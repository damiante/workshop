import { clearAlert, raiseAlert } from '../alerts.ts';
import { all, run } from '../db.ts';
import { publish } from '../events.ts';
import type { CreatedTicket } from '../providers/types.ts';
import { appendLog } from '../runs.ts';
import { getSettings } from '../settings.ts';
import { getRepo, getTicket, isAllowedAuthor, labelsOf, raisedOf, repoRef, sourceFor, type Raised, type RepoRow, type TicketRow } from '../tickets.ts';
import { label } from '../workflow/labels.ts';
import type { FollowUps } from '../workflow/schemas.ts';
import { bestMatch, type Similarity } from '../workflow/similar.ts';
import { followUpBody } from '../workflow/transitions.ts';

export const MAX_RAISED_TITLE = 200;
export const MAX_RAISED_BODY = 20_000;

export const sameTitle = (a: string, b: string) => a.trim().replace(/\s+/g, ' ').toLowerCase() === b.trim().replace(/\s+/g, ' ').toLowerCase();

export const score = (s: Similarity) => `title ${s.title.toFixed(2)} with ${s.shared} shared keyword${s.shared === 1 ? '' : 's'}, text ${s.text.toFixed(2)}`;

/**
 * Stores a ticket Workshop just opened from what the reply already holds, so other runs see it, in the open-ticket
 * index and as a similarity candidate, before the next sync. No extra request; the sync later updates it as usual.
 * Left to the sync if it already has it, and skipped, as the sync would, if Workshop isn't an allowed author.
 */
export function storeCreated(repo: RepoRow, made: CreatedTicket, t: { title: string; body: string; labels: string[] }) {
  const author = made.author ?? sourceFor(repo).selfLogin();
  if (!isAllowedAuthor(author)) return;
  const now = new Date().toISOString();
  run(
    `INSERT INTO tickets (repo_id, number, node_id, title, body, url, author, state, labels, updated_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?) ON CONFLICT (repo_id, number) DO NOTHING`,
    repo.id,
    made.number,
    made.nodeId ?? null,
    t.title,
    t.body,
    made.url,
    author,
    JSON.stringify(t.labels),
    made.updatedAt ?? now,
    made.createdAt ?? now,
  );
  publish('tickets');
}

/**
 * Raises a `raise-rate` alert while agents have opened more tickets in the repository in the last hour than the
 * `raiseAlertPerHour` setting allows, and clears it otherwise. It only reports: agents may still open tickets.
 */
export function checkRaiseRate(repo: RepoRow) {
  const since = Date.now() - 3600_000;
  const count = all<{ raised: string }>('SELECT raised FROM tickets WHERE repo_id = ? AND raised IS NOT NULL', repo.id)
    .flatMap((row) => JSON.parse(row.raised) as Raised[])
    .filter((x) => (x.at ?? 0) >= since).length;
  const limit = getSettings().raiseAlertPerHour;
  const ref = `repo:${repo.id}`;
  if (count > limit) {
    raiseAlert(
      'warning',
      'raise-rate',
      `Agents opened ${count} tickets in ${repo.full_name} in the last hour, more than the limit of ${limit}. Check that they aren't duplicates, or turn off "Agents open tickets for what they notice" for this repository.`,
      ref,
    );
  } else clearAlert('raise-rate', ref);
}

/**
 * Opens a ticket for each code review finding left on the default branch, once the work is pushed (`commit`),
 * and returns a line for each finding for the pushed comment. Each ticket is recorded as soon as it exists, so a retry
 * after a GitHub failure lists it again instead of opening it twice. A finding an open ticket already has the title
 * of, or that is similar to an open ticket agents raised, isn't opened. Nothing is opened when the repository doesn't
 * let Workshop open tickets (as it is now), or when this ticket was itself raised.
 */
export async function raiseFollowUps(t: TicketRow, follow: FollowUps, commit: { sha: string; url: string }): Promise<string[]> {
  const repo = getRepo(t.repo_id)!;
  if (!repo.raise_tickets || labelsOf(t).includes(label.raised)) return [];
  const source = sourceFor(repo);
  const lines: string[] = [];
  for (const f of follow.findings) {
    const title = f.title.trim().replace(/\s+/g, ' ').slice(0, MAX_RAISED_TITLE);
    const before = raisedOf(getTicket(t.id)!);
    const earlier = before.find((x) => sameTitle(x.title, title));
    if (earlier) {
      lines.push(`- #${earlier.number} ${earlier.title}`);
      continue;
    }
    const others = all<TicketRow>("SELECT * FROM tickets WHERE repo_id = ? AND state = 'open' AND id != ?", t.repo_id, t.id);
    const open = others.find((x) => sameTitle(x.title, title));
    if (open) {
      lines.push(`- ${title}: already open as #${open.number}`);
      continue;
    }
    const body = followUpBody(f, t, commit, repo.default_branch).slice(0, MAX_RAISED_BODY);
    const candidates = others.filter((o) => labelsOf(o).includes(label.raised) && isAllowedAuthor(o.author)).map((o) => ({ number: o.number, title: o.title, body: o.body }));
    const similar = bestMatch({ title, body: [f.detail, f.consequence ?? ''].join(' ') }, candidates);
    if (similar) {
      const m = similar.match;
      appendLog(follow.runId, { step: 'workshop', stream: 'stdout', text: `Didn't open a follow-up for "${title}": #${m.number} "${m.title}" already covers it (${score(similar.score)}).` });
      lines.push(`- ${title}: already covered by #${m.number}`);
      continue;
    }
    const made = await source.createTicket(repoRef(repo), { title, body, labels: [label.raised] });
    storeCreated(repo, made, { title, body, labels: [label.raised] });
    run('UPDATE tickets SET raised = ? WHERE id = ?', JSON.stringify([...before, { number: made.number, url: made.url, title, runId: follow.runId, at: Date.now() }]), t.id);
    checkRaiseRate(repo);
    lines.push(`- #${made.number} ${title}`);
  }
  return lines;
}
