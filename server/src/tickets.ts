import type { DependencyGraph, DependencyNode, Push, RepoSelection, RepoView, TicketRefView, TicketView } from './api-types.ts';
import { all, one, run } from './db.ts';
import { publish } from './events.ts';
import { getConnection, ticketsOf, vcsOf } from './providers/index.ts';
import type { RepoRef, TicketLink } from './providers/types.ts';
import { mediaCount } from './media.ts';
import { getSettings } from './settings.ts';
import { dependencyBlock, implicitPriority, inScope, waitingCounts } from './scheduler/gates.ts';
import type { Handoff, Rescue, Rework } from './workflow/schemas.ts';
import { branchFor, describeStep, label, nextStep, parseLabels } from './workflow/labels.ts';

export interface RepoRow {
  id: number;
  vcs_connection_id: number;
  ticket_connection_id: number | null;
  full_name: string;
  default_branch: string;
  private: number;
  url: string;
  enabled: number;
  image: string | null;
  priority: number;
  synced_at: string | null;
  selection: RepoSelection;
  merge_without_review: number;
  raise_tickets: number;
  push_to_default: number;
  merge_warning: string | null;
}

export interface TicketRow {
  id: number;
  repo_id: number;
  number: number;
  node_id: string | null;
  title: string;
  body: string;
  url: string;
  author: string;
  state: 'open' | 'closed';
  labels: string;
  branch: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_status: string | null;
  failures: number;
  blocked_by: string;
  blockers_checked_at: number | null;
  /** Last full read of its blockers into ticket_links; null means never, and the backfill reads it. */
  links_checked_at: number | null;
  push: Push | null;
  push_stage: string | null;
  ui: number;
  rescue: string | null;
  handoff: string | null;
  raised: string | null;
  rework: string | null;
  dismissed: string | null;
  prioritised: number;
  bypass_limits: number;
  updated_at: string;
  created_at: string | null;
}

export const MAX_ATTEMPTS = 2;

export const rescueOf = (t: TicketRow): Rescue | null => (t.rescue ? JSON.parse(t.rescue) : null);
export const handoffOf = (t: TicketRow): Handoff | null => (t.handoff ? JSON.parse(t.handoff) : null);
/** The tickets Workshop opened for what this ticket's agents noticed or needed first, and the run that reported each. */
export interface Raised {
  number: number;
  url: string;
  title: string;
  runId: string;
  /** Raised as a prerequisite this ticket waits for, not as noticed work. */
  blocker?: boolean;
}
export const raisedOf = (t: TicketRow): Raised[] => (t.raised ? JSON.parse(t.raised) : []);
export const reworkOf = (t: TicketRow): Rework | null => (t.rework ? JSON.parse(t.rework) : null);

export const repoRef = (r: RepoRow): RepoRef => ({ fullName: r.full_name, defaultBranch: r.default_branch, private: Boolean(r.private), url: r.url });

/** Open tickets in enabled repositories, as `t`; append ORDER BY as needed. */
export const openTicketsSql = `SELECT t.* FROM tickets t JOIN repos r ON r.id = t.repo_id WHERE r.enabled = 1 AND t.state = 'open'`;

export const getRepo = (id: number) => one<RepoRow>('SELECT * FROM repos WHERE id = ?', id);
export const getTicket = (id: number) => one<TicketRow>('SELECT * FROM tickets WHERE id = ?', id);
export const labelsOf = (t: TicketRow): string[] => JSON.parse(t.labels);
export const ticketInScope = (t: TicketRow, repo: RepoRow) => inScope(repo.selection, labelsOf(t));
/** Open tickets this one waits for, as display refs such as "#2" or "other/repo#5". */
export const blockersOf = (t: TicketRow): string[] => JSON.parse(t.blocked_by);
/** A blocker ref as a graph key: `#n` becomes `owner/repo#n`, all lower case. */
export const refKey = (ref: string, repoFullName: string) => (ref.startsWith('#') ? repoFullName + ref : ref).toLowerCase();
export const branchOf = (t: TicketRow) => t.branch ?? branchFor(t.number, t.title);
/** The design doc lives beside the branch name, so renaming the issue doesn't move it. */
export const docPathOf = (t: TicketRow) => `docs/workshop/${branchOf(t).replace(/^workshop\//, '')}.md`;

export const linkRef = (link: TicketLink, repo: RepoRow) => (link.repo.toLowerCase() === repo.full_name.toLowerCase() ? `#${link.number}` : `${link.repo}#${link.number}`);

/** The stage a ticket is at, as stored with a push: the stage label, or 'new' when it has none. */
export const stageKey = (labels: string[]) => parseLabels(labels).stage ?? 'new';

export function setPush(t: TicketRow, push: Push | null) {
  const stage = push ? stageKey(labelsOf(t)) : null;
  run('UPDATE tickets SET push = ?, push_stage = ? WHERE id = ?', push, stage, t.id);
  t.push = push;
  t.push_stage = stage;
  publish('tickets');
  publish('runs');
}

export function setPrioritised(t: TicketRow, on: boolean) {
  run('UPDATE tickets SET prioritised = ? WHERE id = ?', on ? 1 : 0, t.id);
  t.prioritised = on ? 1 : 0;
  publish('tickets');
  publish('runs');
}

export function setBypassLimits(t: TicketRow, on: boolean) {
  run('UPDATE tickets SET bypass_limits = ? WHERE id = ?', on ? 1 : 0, t.id);
  t.bypass_limits = on ? 1 : 0;
  publish('tickets');
  publish('runs');
}

export function setBlockers(t: TicketRow, refs: string[]) {
  const value = JSON.stringify(refs);
  if (value === t.blocked_by) return;
  run('UPDATE tickets SET blocked_by = ? WHERE id = ?', value, t.id);
  t.blocked_by = value;
  publish('tickets');
}

interface LinkRow {
  ticket_id: number;
  blocker_repo: string;
  blocker_number: number;
  blocker_title: string | null;
  blocker_url: string;
  blocker_state: 'open' | 'closed';
}

const linkKey = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;
const linksOf = (ticketId: number) => all<LinkRow>('SELECT * FROM ticket_links WHERE ticket_id = ? ORDER BY blocker_repo, blocker_number', ticketId);

function upsertLink(ticketId: number, l: TicketLink) {
  run(
    `INSERT INTO ticket_links (ticket_id, blocker_repo, blocker_number, blocker_title, blocker_url, blocker_state) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (ticket_id, blocker_repo, blocker_number) DO UPDATE SET
       blocker_title = COALESCE(excluded.blocker_title, ticket_links.blocker_title), blocker_url = excluded.blocker_url, blocker_state = excluded.blocker_state`,
    ticketId,
    l.repo,
    l.number,
    l.title ?? null,
    // Shown as a link on the Dependencies page, so only web addresses are kept.
    /^https?:\/\//i.test(l.url) ? l.url : `https://github.com/${l.repo}/issues/${l.number}`,
    l.state,
  );
}

/**
 * Stores the ticket's complete list of blockers, open and closed, and marks it read. Returns whether the stored links
 * changed. It doesn't publish: a sync reads many tickets and publishes once.
 */
export function setLinks(t: TicketRow, links: TicketLink[]): boolean {
  const before = JSON.stringify(linksOf(t.id));
  const now = Date.now();
  run('BEGIN');
  try {
    run('DELETE FROM ticket_links WHERE ticket_id = ?', t.id);
    for (const l of links) upsertLink(t.id, l);
    run('UPDATE tickets SET links_checked_at = ? WHERE id = ?', now, t.id);
    run('COMMIT');
  } catch (err) {
    run('ROLLBACK');
    throw err;
  }
  t.links_checked_at = now;
  return JSON.stringify(linksOf(t.id)) !== before;
}

/** Adds links without removing others, for links Workshop made itself; the list isn't complete, so it isn't marked read. */
export function addLinks(t: TicketRow, links: TicketLink[]) {
  const before = JSON.stringify(linksOf(t.id));
  for (const l of links) upsertLink(t.id, l);
  if (JSON.stringify(linksOf(t.id)) !== before) publish('tickets');
}

export const linkCount = (ticketId: number) => one<{ n: number }>('SELECT count(*) AS n FROM ticket_links WHERE ticket_id = ?', ticketId)!.n;

/** One graph per enabled repo: every stored link whose dependent is in it, with both ends as nodes. */
export function dependencyGraphs(): DependencyGraph[] {
  const repos = all<RepoRow>('SELECT * FROM repos');
  const byId = new Map(repos.map((r) => [r.id, r]));
  return repos
    .filter((r) => r.enabled)
    .sort((a, b) => a.full_name.localeCompare(b.full_name))
    .map((repo) => {
      const links = all<LinkRow & { number: number }>(
        'SELECT l.*, t.number FROM ticket_links l JOIN tickets t ON t.id = l.ticket_id WHERE t.repo_id = ?',
        repo.id,
      );
      // Both ends, as Workshop rows in any enabled repo: the dependents, and blockers matched by full name and number.
      const rows = all<TicketRow>(
        `SELECT t.* FROM tickets t JOIN repos r ON r.id = t.repo_id
         WHERE r.enabled = 1 AND (
           t.id IN (SELECT l.ticket_id FROM ticket_links l JOIN tickets d ON d.id = l.ticket_id WHERE d.repo_id = ?)
           OR (lower(r.full_name), t.number) IN (
             SELECT lower(l.blocker_repo), l.blocker_number FROM ticket_links l JOIN tickets d ON d.id = l.ticket_id WHERE d.repo_id = ?))`,
        repo.id,
        repo.id,
      );
      const refOf = (fullName: string, number: number) => (fullName.toLowerCase() === repo.full_name.toLowerCase() ? `#${number}` : `${fullName}#${number}`);
      const nodes = new Map<string, DependencyNode>();
      for (const t of rows) {
        const r = byId.get(t.repo_id)!;
        const node = { ref: refOf(r.full_name, t.number), number: t.number, title: t.title, url: t.url, state: t.state, held: blockersOf(t).length > 0, ticket: ticketView(t, r) };
        nodes.set(linkKey(r.full_name, t.number), node);
      }
      const seen = new Set<string>();
      const edges = links.flatMap((l) => {
        const key = linkKey(l.blocker_repo, l.blocker_number);
        if (!nodes.has(key)) {
          const node = { ref: refOf(l.blocker_repo, l.blocker_number), number: l.blocker_number, title: l.blocker_title, url: l.blocker_url, state: l.blocker_state, held: false, ticket: null };
          nodes.set(key, node);
        }
        const edge = { blocker: nodes.get(key)!.ref, ticket: `#${l.number}` };
        // The same link can be stored twice when GitHub spelled the repo with different case.
        const id = `${edge.blocker}>${edge.ticket}`;
        if (seen.has(id)) return [];
        seen.add(id);
        return [edge];
      });
      const sortedNodes = [...nodes.values()].sort((a, b) => a.number - b.number || a.ref.localeCompare(b.ref));
      edges.sort((a, b) => a.ticket.localeCompare(b.ticket, undefined, { numeric: true }) || a.blocker.localeCompare(b.blocker, undefined, { numeric: true }));
      return { repoId: repo.id, repo: repo.full_name, nodes: sortedNodes, edges };
    });
}

export function repoView(r: RepoRow): RepoView {
  return {
    id: r.id,
    connectionId: r.vcs_connection_id,
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    private: Boolean(r.private),
    url: r.url,
    enabled: Boolean(r.enabled),
    image: r.image,
    priority: r.priority,
    selection: r.selection,
    mergeWithoutReview: Boolean(r.merge_without_review),
    mergeWarning: r.merge_without_review ? r.merge_warning : null,
    raiseTickets: Boolean(r.raise_tickets),
    pushToDefault: Boolean(r.push_to_default),
  };
}

export function vcsFor(repo: RepoRow) {
  const conn = getConnection(repo.vcs_connection_id);
  if (!conn) throw new Error(`${repo.full_name}: its code host connection was removed.`);
  return vcsOf(conn);
}

export function sourceFor(repo: RepoRow) {
  const conn = getConnection(repo.ticket_connection_id);
  if (!conn) throw new Error(`${repo.full_name} has no ticket source. Add GitHub Issues under Connections.`);
  return ticketsOf(conn);
}

/** Whether Workshop works on tickets by `login`: the authors you allow, plus Workshop's own GitHub App, which opens tickets like Set up agent image. */
export function isAllowedAuthor(login: string) {
  const l = login.toLowerCase();
  if (getSettings().authors.some((a) => a.toLowerCase() === l)) return true;
  const apps = all<{ config: string }>("SELECT config FROM connections WHERE kind = 'vcs' AND provider = 'github'");
  return apps.some((c) => `${(JSON.parse(c.config) as { slug?: string }).slug}[bot]`.toLowerCase() === l);
}

export function activeRunId(ticketId: number) {
  return one<{ id: string }>("SELECT id FROM runs WHERE ticket_id = ? AND status IN ('starting', 'running', 'publishing', 'paused')", ticketId)?.id ?? null;
}

type Attention = NonNullable<TicketView['attention']>;

/** Why a ticket is waiting on you, or null when it isn't. */
export function attentionOf(v: Pick<TicketView, 'needsInfo' | 'failed' | 'stage' | 'activeRunId' | 'prStatus' | 'skipped'>): TicketView['attention'] {
  if (v.skipped) return null;
  if (v.needsInfo) return 'question';
  if (v.failed) return 'failed';
  if (v.stage === 'pr-review' && !v.activeRunId && v.prStatus !== 'changes_requested') return 'review';
  return null;
}

/** The reason plus the latest run: each question, failure or pull request revision comes from a new run. */
function attentionKey(t: TicketRow, reason: Attention | null) {
  if (!reason) return null;
  const latest = one<{ id: string }>('SELECT id FROM runs WHERE ticket_id = ? ORDER BY started_at DESC LIMIT 1', t.id)?.id;
  return `${reason}:${latest ?? ''}`;
}

export function setDismissed(t: TicketRow, on: boolean) {
  const key = on ? attentionKey(t, ticketView(t, getRepo(t.repo_id)!).attention) : null;
  run('UPDATE tickets SET dismissed = ? WHERE id = ?', key, t.id);
  t.dismissed = key;
  publish('tickets');
}

export interface PriorityGraph {
  /** The prioritised tickets that wait on this one, directly or through others. */
  prioritisedFor(t: TicketRow, repo: RepoRow): TicketRefView[];
  /** A blocker ref of a ticket in `repo`, with Workshop's id for it when Workshop has it. */
  resolve(ref: string, repo: RepoRow): TicketRefView;
  /** How many open tickets wait on this one, directly or through others. */
  unblocks(t: TicketRow, repo: RepoRow): number;
}

/** Implicit priority, worked out from the open tickets' stored blockers. Nothing of it is stored. */
export function priorityGraph(): PriorityGraph {
  const rows = all<{ id: number; number: number; prioritised: number; blocked_by: string; full_name: string }>(
    openTicketsSql.replace('SELECT t.*', 'SELECT t.id, t.number, t.prioritised, t.blocked_by, r.full_name'),
  );
  const known = new Map<string, { id: number; ref: string }>();
  for (const r of rows) known.set(refKey(`#${r.number}`, r.full_name), { id: r.id, ref: `${r.full_name}#${r.number}` });
  const nodes = rows.map((r) => ({ key: refKey(`#${r.number}`, r.full_name), prioritised: Boolean(r.prioritised), blockers: (JSON.parse(r.blocked_by) as string[]).map((b) => refKey(b, r.full_name)) }));
  const graph = implicitPriority(nodes);
  const counts = waitingCounts(nodes);
  /** `#n` within `repo`, otherwise `owner/repo#n` as GitHub spells it. */
  const displayRef = (key: string, repo: RepoRow) => {
    const full = known.get(key)?.ref ?? key;
    const prefix = `${repo.full_name.toLowerCase()}#`;
    return key.startsWith(prefix) ? `#${key.slice(prefix.length)}` : full;
  };
  return {
    prioritisedFor: (t, repo) => (graph.get(refKey(`#${t.number}`, repo.full_name)) ?? []).map((k) => ({ ref: displayRef(k, repo), ticketId: known.get(k)?.id ?? null })),
    resolve: (ref, repo) => ({ ref, ticketId: known.get(refKey(ref, repo.full_name))?.id ?? null }),
    unblocks: (t, repo) => counts.get(refKey(`#${t.number}`, repo.full_name)) ?? 0,
  };
}

export function ticketView(t: TicketRow, repo: RepoRow, graph: PriorityGraph = priorityGraph()): TicketView {
  const labels = labelsOf(t);
  const state = parseLabels(labels);
  const step = nextStep(state, t.state === 'open');
  const next = step && !inScope(repo.selection, labels)
    ? 'Not nominated'
    : state.stage === 'pr-review' && !state.needsInfo ? 'Waiting for your review' : (step && dependencyBlock(blockersOf(t))) || describeStep(step, state.stage);
  const activeRun = activeRunId(t.id);
  const attention = attentionOf({ ...state, skipped: state.skip, prStatus: t.pr_status, activeRunId: activeRun });
  return {
    id: t.id,
    repo: repo.full_name,
    number: t.number,
    title: t.title,
    url: t.url,
    author: t.author,
    state: t.state,
    labels,
    size: state.size,
    stage: state.stage,
    needsInfo: state.needsInfo,
    skipped: state.skip,
    failed: state.failed,
    nominated: repo.selection === 'nominated' ? labels.includes(label.nominated) : null,
    next,
    branch: t.branch,
    prNumber: t.pr_number,
    prUrl: t.pr_url,
    prStatus: t.pr_status,
    activeRunId: activeRun,
    attention,
    dismissed: attention !== null && t.dismissed === attentionKey(t, attention),
    push: t.push,
    prioritised: Boolean(t.prioritised),
    bypassLimits: Boolean(t.bypass_limits),
    dependsOn: blockersOf(t).map((r) => graph.resolve(r, repo)),
    prioritisedFor: graph.prioritisedFor(t, repo),
    mediaCount: mediaCount(t.id),
    updatedAt: t.updated_at,
  };
}

export function listTicketViews(includeClosed = false): TicketView[] {
  const rows = all<TicketRow & { r_id: number }>(
    `SELECT t.* FROM tickets t JOIN repos r ON r.id = t.repo_id WHERE r.enabled = 1 ${includeClosed ? '' : "AND t.state = 'open'"} ORDER BY t.updated_at DESC`,
  );
  const repos = new Map(all<RepoRow>('SELECT * FROM repos').map((r) => [r.id, r]));
  const graph = priorityGraph();
  return rows.map((t) => ticketView(t, repos.get(t.repo_id)!, graph));
}

/** Applies label edits on the ticket source, then mirrors them locally. */
export async function editLabels(t: TicketRow, add: string[], remove: string[]) {
  const current = labelsOf(t);
  add = add.filter((l) => !current.includes(l));
  remove = remove.filter((l) => current.includes(l) && !add.includes(l));
  if (!add.length && !remove.length) return;
  const repo = getRepo(t.repo_id)!;
  await sourceFor(repo).setLabels(repoRef(repo), t.number, add, remove);
  const next = [...current.filter((l) => !remove.includes(l)), ...add];
  run('UPDATE tickets SET labels = ? WHERE id = ?', JSON.stringify(next), t.id);
  t.labels = JSON.stringify(next);
  publish('tickets');
}

/** Best-effort marker on GitHub so you can see from the issue that an agent is working on it. */
export async function markRunning(t: TicketRow, on: boolean) {
  try {
    await editLabels(t, on ? [label.running] : [], on ? [] : [label.running]);
  } catch (err) {
    console.warn(`Couldn't update ${label.running} on #${t.number}: ${(err as Error).message}`);
  }
}
