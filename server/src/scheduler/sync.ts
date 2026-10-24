import { all, one, run } from '../db.ts';
import { publish } from '../events.ts';
import { deleteMedia } from '../media.ts';
import { getSettings } from '../settings.ts';
import { activeRunId, editLabels, getTicket, isAllowedAuthor, labelsOf, linkRef, repoRef, setBlockers, sourceFor, vcsFor, type RepoRow, type TicketRow } from '../tickets.ts';
import type { RemoteTicket } from '../providers/types.ts';
import { label, moveTo, parseLabels } from '../workflow/labels.ts';
import { raiseAlert } from '../alerts.ts';
import { cleanUpClosedIssue, finishMerged, stopAfterClosedPr } from './merge.ts';
import { stopRun } from './runner.ts';

/** Pulls changed tickets for one repo, then checks pull requests waiting for your review. */
export async function syncRepo(repo: RepoRow) {
  const ref = repoRef(repo);
  // Overlap the window a little: `since` compares update times, and duplicates are harmless upserts.
  const started = new Date(Date.now() - 60_000).toISOString();
  const changed = await sourceFor(repo).listChanged(ref, repo.synced_at);
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
    const active = existing && t.state === 'closed' ? activeRunId(existing.id) : null;
    if (active) await stopRun(active, 'The ticket was closed.', false);
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
  await syncBlockers(repo, changed);
  await syncReviews(repo);
  run('UPDATE repos SET synced_at = ? WHERE id = ?', started, repo.id);
  if (changed.length) publish('tickets');
}

/**
 * Open blockers decide whether a ticket is held. The list's count only says which tickets not yet held
 * need a look; held tickets are always re-read, because closing a blocker may not touch their update time.
 * A failure for one ticket keeps its stored hold and mustn't stop the rest of the sync.
 */
async function syncBlockers(repo: RepoRow, changed: RemoteTicket[]) {
  const source = sourceFor(repo);
  const ref = repoRef(repo);
  const targets = new Map<number, TicketRow>();
  for (const t of changed) {
    if (t.state !== 'open' || !t.openBlockers) continue;
    const row = one<TicketRow>('SELECT * FROM tickets WHERE repo_id = ? AND number = ?', repo.id, t.number);
    if (row) targets.set(row.number, row);
  }
  for (const row of all<TicketRow>("SELECT * FROM tickets WHERE repo_id = ? AND state = 'open' AND blocked_by != '[]'", repo.id)) targets.set(row.number, row);
  for (const t of targets.values()) {
    try {
      const links = await source.blockers(ref, t.number);
      // Re-read the row: a Classifier run may have set the hold while the request was in flight.
      setBlockers(getTicket(t.id) ?? t, links.filter((l) => l.state === 'open').map((l) => linkRef(l, repo)));
    } catch (err) {
      console.warn(`Couldn't read the blockers of ${repo.full_name}#${t.number}: ${(err as Error).message}`);
    }
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
      else if (state.stage === 'merge') continue; // still open and approved: the merge step handles it
      else if (pr.decision === 'approved') move = moveTo(labelsOf(t), 'merge');
      else if (pr.decision === 'changes_requested') move = moveTo(labelsOf(t), 'reclassify');
      if (move) await editLabels(t, move.add, move.remove);
    } catch (err) {
      // One failing pull request mustn't stop the others from being checked.
      console.warn(`Couldn't check the pull request of ${repo.full_name}#${t.number}: ${(err as Error).message}`);
    }
  }
  if (touched) publish('tickets');
}
