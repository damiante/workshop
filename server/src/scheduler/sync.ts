import { all, one, run } from '../db.ts';
import { publish } from '../events.ts';
import { deleteMedia } from '../media.ts';
import { getSettings } from '../settings.ts';
import {
  activeRunId,
  blockersOf,
  editLabels,
  getTicket,
  isAllowedAuthor,
  labelsOf,
  linkCount,
  linkRef,
  priorityGraph,
  refKey,
  repoRef,
  setBlockers,
  setLinks,
  sourceFor,
  vcsFor,
  type RepoRow,
  type TicketRow,
} from '../tickets.ts';
import type { RemoteTicket } from '../providers/types.ts';
import { label, moveTo, parseLabels } from '../workflow/labels.ts';
import { raiseAlert } from '../alerts.ts';
import { cleanUpClosedIssue, finishMerged, stopAfterClosedPr } from './merge.ts';
import { stopRun } from './runner.ts';
import { isRateLimited, isTransient } from './gates.ts';

/**
 * Open tickets the sync has just stored that list open blockers it hasn't read yet. Allocation runs during a sync,
 * so these wait in the queue until their blockers are read (or the sync ends).
 */
export const checkingBlockers = new Set<number>();

/** Pulls changed tickets for one repo, then checks pull requests waiting for your review. */
export async function syncRepo(repo: RepoRow) {
  const ref = repoRef(repo);
  // Overlap the window a little: `since` compares update times, and duplicates are harmless upserts.
  const started = new Date(Date.now() - 60_000).toISOString();
  const changed = await sourceFor(repo).listChanged(ref, repo.synced_at);
  const checking: number[] = [];
  try {
    await storeChanged(repo, changed, checking);
    const complete = await syncBlockers(repo, changed);
    await syncReviews(repo);
    if (complete) run('UPDATE repos SET synced_at = ? WHERE id = ?', started, repo.id);
    if (changed.length) publish('tickets');
  } finally {
    // A failed or rate-limited sync leaves the stored holds as they were, as before this set existed.
    for (const id of checking) checkingBlockers.delete(id);
  }
}

/** Upserts the listed tickets, stopping runs on tickets that were closed or skipped, and tidies up closed ones. */
async function storeChanged(repo: RepoRow, changed: RemoteTicket[], checking: number[]) {
  for (const t of changed) {
    if (!isAllowedAuthor(t.author)) continue;
    const existing = one<TicketRow>('SELECT * FROM tickets WHERE repo_id = ? AND number = ?', repo.id, t.number);
    // Removing workshop/failed is how you ask Workshop to try again.
    const retry = existing && labelsOf(existing).includes(label.failed) && !t.labels.includes(label.failed);
    run(
      `INSERT INTO tickets (repo_id, number, node_id, title, body, url, author, state, labels, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (repo_id, number) DO UPDATE SET node_id = excluded.node_id, title = excluded.title, body = excluded.body,
         url = excluded.url, state = excluded.state, labels = excluded.labels, updated_at = excluded.updated_at,
         created_at = COALESCE(excluded.created_at, tickets.created_at)
         ${retry ? ', failures = 0' : ''}`,
      repo.id,
      t.number,
      t.nodeId ?? null,
      t.title,
      t.body,
      t.url,
      t.author,
      t.state,
      JSON.stringify(t.labels),
      t.updatedAt,
      t.createdAt ?? null,
    );
    // In the same synchronous step as the upsert, so no allocation pass sees the ticket before it's held.
    const row = one<TicketRow>('SELECT * FROM tickets WHERE repo_id = ? AND number = ?', repo.id, t.number)!;
    if (t.state === 'open' && t.openBlockers && row.blocked_by === '[]') {
      checkingBlockers.add(row.id);
      checking.push(row.id);
    }
    const stopReason = t.state === 'closed' ? 'The ticket was closed.' : t.labels.includes(label.skip) ? `The ticket was labelled ${label.skip}.` : null;
    const active = existing && stopReason ? activeRunId(existing.id) : null;
    if (active) await stopRun(active, stopReason!, false);
    if (existing?.state === 'open' && t.state === 'closed') {
      deleteMedia(existing.id); // before the tidy-up, so it happens even if that throws
      try {
        await cleanUpClosedIssue(getTicket(existing.id)!);
      } catch (err) {
        // The row is already closed, so this isn't retried; the alert says what to tidy by hand.
        raiseAlert('warning', 'close-cleanup', `Couldn't tidy up after ${repo.full_name}#${t.number} was closed: ${(err as Error).message}`, `ticket:${existing.id}`);
      }
    }
  }
}

/** Held tickets re-read per repo per sync, beyond those you prioritised or pushed. */
export const HELD_CHECKS_PER_SYNC = 100;
/** Tickets whose links were never read, read per repo per sync, so the Dependencies page fills in over time. */
export const LINK_BACKFILL_PER_SYNC = 20;

/**
 * Open blockers decide whether a ticket is held. The list's count says which tickets not yet held need a look;
 * those are all read, so nothing blocked gets launched. Held tickets are re-read because closing a blocker may not
 * touch their update time, but there can be thousands, so each sync reads first every ticket you prioritised or
 * pushed, then up to HELD_CHECKS_PER_SYNC more: those with a blocker Workshop has seen close, then the least recently
 * read. The cap matters when many blockers close at once: reads are one at a time. Allocation doesn't wait for them;
 * newly blocked tickets not yet read wait in the queue as "Checking what it depends on" (see `checkingBlockers`).
 *
 * Every read also stores the ticket's full list of links (open and closed) for the Dependencies page. Two more groups
 * are read for that alone: listed tickets whose total link count differs from what's stored, then up to
 * LINK_BACKFILL_PER_SYNC tickets never read, closed ones included. A temporary failure to read a changed count hands
 * the ticket to the backfill, since the sync moves on and won't list it again; a permanent one (404) marks it read.
 *
 * A failure for one ticket keeps its stored hold; a rate limit ends the round. Returns false when GitHub's rate limit
 * stopped it before every newly blocked ticket was read, so the next sync lists them again.
 */
async function syncBlockers(repo: RepoRow, changed: RemoteTicket[]): Promise<boolean> {
  const source = sourceFor(repo);
  const ref = repoRef(repo);
  const fresh: TicketRow[] = [];
  const recount: TicketRow[] = [];
  for (const t of changed) {
    const row = one<TicketRow>('SELECT * FROM tickets WHERE repo_id = ? AND number = ?', repo.id, t.number);
    if (!row) continue;
    if (t.state === 'open' && t.openBlockers && row.blocked_by === '[]') fresh.push(row);
    if (t.totalBlockers !== undefined && t.totalBlockers !== linkCount(row.id)) recount.push(row);
  }
  const closed = new Set(
    all<{ ref: string }>("SELECT lower(r.full_name) || '#' || t.number AS ref FROM tickets t JOIN repos r ON r.id = t.repo_id WHERE t.state = 'closed'").map((r) => r.ref),
  );
  const looksFree = (t: TicketRow) => blockersOf(t).some((b) => closed.has(refKey(b, repo.full_name)));
  const held = all<TicketRow>(
    "SELECT * FROM tickets WHERE repo_id = ? AND state = 'open' AND blocked_by != '[]' ORDER BY COALESCE(blockers_checked_at, 0), id",
    repo.id,
  );
  const graph = priorityGraph();
  const isYours = (t: TicketRow) => t.prioritised || t.push || graph.prioritisedFor(t, repo).length > 0;
  const yours = held.filter(isYours);
  const rest = held.filter((t) => !isYours(t));
  const capped = [...rest.filter(looksFree), ...rest.filter((t) => !looksFree(t))].slice(0, HELD_CHECKS_PER_SYNC);
  const holds = [...yours, ...fresh, ...capped];
  const seen = new Set(holds.map((t) => t.id));
  const recounts = recount.filter((t) => !seen.has(t.id) && seen.add(t.id));
  const backfill = all<TicketRow>(
    "SELECT * FROM tickets WHERE repo_id = ? AND links_checked_at IS NULL ORDER BY state = 'closed', number DESC LIMIT ?",
    repo.id,
    LINK_BACKFILL_PER_SYNC + seen.size,
  ).filter((t) => !seen.has(t.id)).slice(0, LINK_BACKFILL_PER_SYNC);
  const targets = [...holds, ...recounts, ...backfill];
  // A changed count that isn't read goes to the backfill, which retries it on a later sync: the sync moves on and
  // won't list it again. That holds whichever group read it.
  const recounted = new Set(recount.map((t) => t.id));
  const retryLater = (ts: TicketRow[]) => {
    for (const t of ts) if (recounted.has(t.id)) run('UPDATE tickets SET links_checked_at = NULL WHERE id = ?', t.id);
  };
  let linksChanged = false;
  try {
    for (const [i, t] of targets.entries()) {
      try {
        const links = await source.blockers(ref, t.number);
        // Re-read the row: a Classifier run may have set the hold while the request was in flight.
        const current = getTicket(t.id) ?? t;
        if (setLinks(current, links)) linksChanged = true;
        setBlockers(current, links.filter((l) => l.state === 'open').map((l) => linkRef(l, repo)));
        run('UPDATE tickets SET blockers_checked_at = ? WHERE id = ?', Date.now(), t.id);
      } catch (err) {
        console.warn(`Couldn't read the blockers of ${repo.full_name}#${t.number}: ${(err as Error).message}`);
        if (isTransient(err)) retryLater([t]);
        // A read that can't succeed (a deleted or moved issue) counts as done, so the backfill moves past it.
        else run('UPDATE tickets SET links_checked_at = COALESCE(links_checked_at, ?) WHERE id = ?', Date.now(), t.id);
        if (isRateLimited(err)) {
          retryLater(targets.slice(i + 1));
          return i >= yours.length + fresh.length;
        }
      } finally {
        checkingBlockers.delete(t.id); // read or failed: its stored hold applies again
      }
    }
    return true;
  } finally {
    if (linksChanged) publish('tickets');
  }
}

/**
 * Reviews land on the pull request, not the issue, so every PR waiting on you is checked each sync.
 * Closed tickets are included: merging on GitHub closes the issue (through "Closes #n") before we look.
 */
async function syncReviews(repo: RepoRow) {
  const vcs = vcsFor(repo);
  const ref = repoRef(repo);
  const authors = getSettings().authors;
  const tickets = all<TicketRow>('SELECT * FROM tickets WHERE repo_id = ? AND pr_number IS NOT NULL', repo.id);
  let touched = false;
  for (const t of tickets) {
    try {
      const state = parseLabels(labelsOf(t));
      if (state.skip && t.state === 'open') continue; // you took it out of Workshop
      if (state.stage !== 'pr-review' && state.stage !== 'merge') continue;
      if (state.stage === 'pr-review' && state.needsInfo && t.state === 'open') continue;
      const pr = await vcs.pullRequestState(ref, t.pr_number!, authors);
      // Recorded first, so "Needs you" reflects the review even before the label change lands.
      const status = pr.state === 'open' ? (pr.decision ?? 'review') : pr.state;
      if (status !== t.pr_status) touched = true;
      run('UPDATE tickets SET pr_status = ? WHERE id = ?', status, t.id);
      let move: ReturnType<typeof moveTo> | null = null;
      if (pr.state === 'merged') await finishMerged(t);
      else if (t.state === 'closed') move = moveTo(labelsOf(t), null); // you closed the issue: stop quietly
      else if (pr.state === 'closed') {
        const active = activeRunId(t.id); // a Merge agent may be resolving a conflict on that PR
        if (active) await stopRun(active, 'The pull request was closed.', false);
        await stopAfterClosedPr(t);
      }
      else if (pr.decision === 'changes_requested' && (state.stage === 'pr-review' || repo.merge_without_review)) move = moveTo(labelsOf(t), 'reclassify');
      else if (state.stage === 'merge') continue; // still open: the merge step handles it
      else if (pr.decision === 'approved' || repo.merge_without_review) move = moveTo(labelsOf(t), 'merge');
      if (move) await editLabels(t, move.add, move.remove);
    } catch (err) {
      // One failing pull request mustn't stop the others from being checked.
      console.warn(`Couldn't check the pull request of ${repo.full_name}#${t.number}: ${(err as Error).message}`);
    }
  }
  if (touched) publish('tickets');
}
