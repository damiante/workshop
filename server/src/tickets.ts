import type { Push, RepoSelection, RepoView, TicketView } from './api-types.ts';
import { all, one, run } from './db.ts';
import { publish } from './events.ts';
import { getConnection, ticketsOf, vcsOf } from './providers/index.ts';
import type { RepoRef, TicketLink } from './providers/types.ts';
import { mediaCount } from './media.ts';
import { getSettings } from './settings.ts';
import { dependencyBlock, inScope } from './scheduler/gates.ts';
import type { Rescue } from './workflow/schemas.ts';
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
  push: Push | null;
  push_stage: string | null;
  ui: number;
  rescue: string | null;
  updated_at: string;
  created_at: string | null;
}

export const MAX_ATTEMPTS = 2;

export const rescueOf = (t: TicketRow): Rescue | null => (t.rescue ? JSON.parse(t.rescue) : null);

export const repoRef = (r: RepoRow): RepoRef => ({ fullName: r.full_name, defaultBranch: r.default_branch, private: Boolean(r.private), url: r.url });

export const getRepo = (id: number) => one<RepoRow>('SELECT * FROM repos WHERE id = ?', id);
export const getTicket = (id: number) => one<TicketRow>('SELECT * FROM tickets WHERE id = ?', id);
export const labelsOf = (t: TicketRow): string[] => JSON.parse(t.labels);
export const ticketInScope = (t: TicketRow, repo: RepoRow) => inScope(repo.selection, labelsOf(t));
/** Open tickets this one waits for, as display refs such as "#2" or "other/repo#5". */
export const blockersOf = (t: TicketRow): string[] => JSON.parse(t.blocked_by);
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

export function setBlockers(t: TicketRow, refs: string[]) {
  const value = JSON.stringify(refs);
  if (value === t.blocked_by) return;
  run('UPDATE tickets SET blocked_by = ? WHERE id = ?', value, t.id);
  t.blocked_by = value;
  publish('tickets');
}

export function repoView(r: RepoRow): RepoView {
  return { id: r.id, connectionId: r.vcs_connection_id, fullName: r.full_name, defaultBranch: r.default_branch, private: Boolean(r.private), url: r.url, enabled: Boolean(r.enabled), image: r.image, priority: r.priority, selection: r.selection };
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

export function isAllowedAuthor(login: string) {
  return getSettings().authors.some((a) => a.toLowerCase() === login.toLowerCase());
}

export function activeRunId(ticketId: number) {
  return one<{ id: string }>("SELECT id FROM runs WHERE ticket_id = ? AND status IN ('starting', 'running', 'publishing', 'paused')", ticketId)?.id ?? null;
}

export function ticketView(t: TicketRow, repo: RepoRow): TicketView {
  const labels = labelsOf(t);
  const state = parseLabels(labels);
  const step = nextStep(state, t.state === 'open');
  const next = step && !inScope(repo.selection, labels)
    ? 'Not nominated'
    : state.stage === 'pr-review' && !state.needsInfo ? 'Waiting for your review' : (step && dependencyBlock(blockersOf(t))) || describeStep(step, state.stage);
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
    activeRunId: activeRunId(t.id),
    push: t.push,
    mediaCount: mediaCount(t.id),
    updatedAt: t.updated_at,
  };
}

export function listTicketViews(includeClosed = false): TicketView[] {
  const rows = all<TicketRow & { r_id: number }>(
    `SELECT t.* FROM tickets t JOIN repos r ON r.id = t.repo_id WHERE r.enabled = 1 ${includeClosed ? '' : "AND t.state = 'open'"} ORDER BY t.updated_at DESC`,
  );
  const repos = new Map(all<RepoRow>('SELECT * FROM repos').map((r) => [r.id, r]));
  return rows.map((t) => ticketView(t, repos.get(t.repo_id)!));
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
