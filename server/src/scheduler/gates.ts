import type { AgentSize, AllowanceView, Limits, Topic, Push, RepoSelection, Settings, UsageWindow } from '../api-types.ts';
import { label, nextStep, parseLabels, type Step } from '../workflow/labels.ts';

/** Whether Workshop may work on a ticket: always for a whole-backlog repository, otherwise only when nominated. */
export function inScope(selection: RepoSelection, labels: string[]): boolean {
  return selection === 'all' || labels.includes(label.nominated);
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localTime(now: Date, timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return { day: WEEKDAYS.indexOf(part('weekday')), minutes: Number(part('hour')) * 60 + Number(part('minute')) };
}

/** Local midnight today in the time zone, as epoch milliseconds. */
export function startOfDay(now: number, timeZone: string) {
  const { minutes } = localTime(new Date(now), timeZone);
  return now - minutes * 60_000 - (now % 60_000);
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** start === end means all day; start > end spans midnight and belongs to the day it starts on. */
export function withinHours(s: Pick<Settings, 'days' | 'start' | 'end' | 'timezone'>, now: Date): boolean {
  const { day, minutes } = localTime(now, s.timezone);
  const start = toMinutes(s.start);
  const end = toMinutes(s.end);
  if (start === end) return s.days.includes(day);
  if (start < end) return s.days.includes(day) && minutes >= start && minutes < end;
  return (s.days.includes(day) && minutes >= start) || (s.days.includes((day + 6) % 7) && minutes < end);
}

export function modeBlock(s: Settings, now: Date): string | null {
  if (s.mode === 'paused') return 'Workshop is paused';
  if (s.mode === 'scheduled' && !withinHours(s, now)) return 'Outside operating hours';
  return null;
}

export function formatTime(ms: number, timeZone: string, now = Date.now()): string {
  const sameDay = Math.abs(ms - now) < 20 * 3600_000;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    ...(sameDay ? {} : { weekday: 'short' }),
  }).format(ms);
}

/** A window whose reset time has passed counts as empty. */
const used = (w: UsageWindow | null, now: number) => (!w || (w.resetsAt !== null && w.resetsAt <= now) ? 0 : w.pct);

export const ALLOWANCE_MAX_AGE_MS = 10 * 60_000;

/**
 * Why the subscription allowance blocks a launch right now, or null. With `ignoreLimits` (a ticket you let
 * past your limits) only a limit Claude reported and a missing or stale reading hold it.
 */
export function allowanceBlock(a: AllowanceView | undefined, s: Settings, now: number, ignoreLimits = false): string | null {
  if (a?.blockedUntil && a.blockedUntil > now) return `Claude reported you're at or near a usage limit; resumes ${formatTime(a.blockedUntil, s.timezone, now)}`;
  if (!a?.sampledAt || now - a.sampledAt > ALLOWANCE_MAX_AGE_MS) return 'Checking allowance';
  return ignoreLimits ? null : (thresholdBlock(a, a.limits, s, now)?.reason ?? null);
}

/** Which usage window is over this subscription's limits, or null. Launches and running agents both stop on it. */
export function thresholdBlock(
  w: { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null },
  limits: Limits,
  s: Pick<Settings, 'timezone'>,
  now: number,
): { reason: string; resetsAt: number | null } | null {
  const resets = (u: UsageWindow | null) => (u?.resetsAt ? `, resets ${formatTime(u.resetsAt, s.timezone, now)}` : '');
  const five = used(w.fiveHour, now);
  if (five > limits.fiveHour) return { reason: `5-hour allowance at ${Math.round(five)}%${resets(w.fiveHour)}`, resetsAt: w.fiveHour?.resetsAt ?? null };
  const week = used(w.sevenDay, now);
  if (week > limits.weekly) return { reason: `Weekly allowance at ${Math.round(week)}%${resets(w.sevenDay)}`, resetsAt: w.sevenDay?.resetsAt ?? null };
  return null;
}

/**
 * Which subscription a launch uses: the first in your order that isn't blocked. One that's still being checked is waited
 * for, unless its last check failed, so a broken token doesn't hold up the rest. With none free, the first one's reason stands.
 */
export function pickSubscription(pool: { id: number; block: string | null; failing: boolean }[]): { id: number; block: string | null } | null {
  for (const c of pool) {
    if (!c.block) return { id: c.id, block: null };
    if (c.block === 'Checking allowance' && !c.failing) return { id: c.id, block: c.block };
  }
  return pool[0] ? { id: pool[0].id, block: pool[0].block } : null;
}

export function apiCapBlock(spentTodayUsd: number, s: Settings): string | null {
  return spentTodayUsd >= s.apiDailyCapUsd ? `API spend today $${spentTodayUsd.toFixed(2)} reached the $${s.apiDailyCapUsd} daily cap` : null;
}

export interface HostLoad {
  id: number;
  healthy: boolean;
  /** Switched on for new agents. Off keeps the host connected and its running agents going. */
  available: boolean;
  /** Slots and running agents by size. Small and large are present only when the host keeps slots for them. */
  pools: Partial<Record<AgentSize, Pool>> & { standard: Pool };
}

export interface Pool {
  slots: number;
  busy: number;
}

/** The pool an agent of this size runs in on a host: its own when the host keeps one, otherwise the standard one. */
export const poolFor = (h: Pick<HostLoad, 'pools'>, size: AgentSize): Pool => h.pools[size] ?? h.pools.standard;

/** Free slots for an agent of this size. */
export function freeSlots(h: Pick<HostLoad, 'pools'>, size: AgentSize): number {
  const p = poolFor(h, size);
  return p.slots - p.busy;
}

/** The healthy, available host with the most free slots for an agent of this size. */
export function pickHost(hosts: HostLoad[], size: AgentSize = 'standard'): number | null {
  const free = hosts.filter((h) => h.healthy && h.available && freeSlots(h, size) > 0);
  free.sort((a, b) => freeSlots(b, size) - freeSlots(a, size) || a.id - b.id);
  return free[0]?.id ?? null;
}

/** "#2", "#2 and #5", "#2, #5 and #7". */
export function joinRefs(refs: string[]): string {
  return refs.length < 2 ? refs.join('') : `${refs.slice(0, -1).join(', ')} and ${refs[refs.length - 1]}`;
}

/** Why open blocking tickets hold a ticket back, or null. */
export function dependencyBlock(refs: string[]): string | null {
  return refs.length ? `Depends on ${joinRefs(refs)}` : null;
}

/** For each ticket, the explicitly prioritised tickets that wait on it, directly or through others (sorted). Keys are `owner/repo#n`, lower case. */
export function implicitPriority(nodes: { key: string; prioritised: boolean; blockers: string[] }[]): Map<string, string[]> {
  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const found = new Map<string, Set<string>>();
  for (const root of nodes) {
    if (!root.prioritised) continue;
    // Iterative DFS with its own visited set, so cycles and shared blockers end.
    const seen = new Set([root.key]);
    const stack = [...root.blockers];
    while (stack.length) {
      const key = stack.pop()!;
      const node = byKey.get(key);
      if (!node || seen.has(key)) continue;
      seen.add(key);
      if (!found.has(key)) found.set(key, new Set());
      found.get(key)!.add(root.key);
      stack.push(...node.blockers);
    }
  }
  return new Map([...found].map(([k, v]) => [k, [...v].sort()]));
}

/**
 * The higher-priority repos whose queued tickets go ahead of one in a repo of this priority. It only
 * orders the queue: a ticket that fits a free slot nothing ahead of it can use still starts.
 */
export function priorityAhead(priority: number, queued: { repo: string; priority: number }[]): string[] {
  return [...new Set(queued.filter((q) => q.priority > priority).map((q) => q.repo))];
}

/**
 * How many distinct open tickets wait on each ticket, directly or through others. Keys and blockers
 * are `refKey`s; blockers Workshop doesn't know are skipped, and in a cycle no ticket counts itself.
 * Only tickets something waits on are in the result.
 */
export function waitingCounts(nodes: { key: string; blockers: string[] }[]): Map<string, number> {
  const known = new Set(nodes.map((n) => n.key));
  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    for (const b of new Set(n.blockers)) {
      if (!known.has(b) || b === n.key) continue;
      if (!dependents.has(b)) dependents.set(b, []);
      dependents.get(b)!.push(n.key);
    }
  }
  const counts = new Map<string, number>();
  for (const root of dependents.keys()) {
    // Iterative DFS over the reverse edges, with its own visited set, so cycles and diamonds end.
    const seen = new Set([root]);
    const stack = [...dependents.get(root)!];
    while (stack.length) {
      const key = stack.pop()!;
      if (seen.has(key)) continue;
      seen.add(key);
      stack.push(...(dependents.get(key) ?? []));
    }
    counts.set(root, seen.size - 1);
  }
  return counts;
}

/** Finish work in flight before starting new work. */
export function stepPriority(step: Step): number {
  if (step.kind === 'merge') return 0;
  if (step.agent === 'merge') return 0;
  if (step.agent === 'implement' || step.agent === 'code-review' || step.mode === 'delta') return 1;
  if (step.agent === 'design-review') return 2;
  if (step.agent === 'design') return 3;
  return 4;
}

/**
 * Whether a hand push is finished. Both kinds end where Workshop would wait for you anyway
 * (review, a question, skip, failed, closed); a stage push also ends once the stage changes.
 */
export function pushEnded(push: Push, pushStage: string | null, labels: string[], open: boolean): boolean {
  const state = parseLabels(labels);
  if (!nextStep(state, open)) return true;
  return push === 'stage' && (state.stage ?? 'new') !== pushStage;
}

/** Why a push can't start on this ticket, or null. */
export function pushRefusal(t: { labels: string[]; open: boolean; running: boolean }, scope: Push): string | null {
  const state = parseLabels(t.labels);
  if (!t.open) return 'This ticket is closed.';
  if (state.failed) return 'Remove the workshop/failed label first, then push it again.';
  if (state.skip) return 'Workshop skipped this ticket. Remove the workshop/skip label first.';
  if (state.needsInfo) return 'An agent asked a question. Answer it and remove the workshop/needs-info label first.';
  if (state.stage === 'pr-review') return 'This is waiting for your review. Approve the pull request or request changes on GitHub first.';
  if (scope === 'stage' && t.running) return 'An agent is already working on this stage.';
  return null;
}

/** What changes with the clock alone, as fingerprints: compared between ticks to know what to announce. */
export interface ClockState {
  withinHours: boolean;
  blocks: string;
  queue: string;
}

/** Topics whose views changed since the previous tick without any write announcing it. */
export function clockTopics(prev: ClockState | null, next: ClockState): Topic[] {
  if (!prev) return [];
  const out: Topic[] = [];
  if (prev.withinHours !== next.withinHours) out.push('settings');
  if (prev.blocks !== next.blocks) out.push('allowance');
  if (prev.queue !== next.queue) out.push('tickets');
  return out;
}

/** Minutes between publish retries: 1, 5, 15, then every 30. */
const PUBLISH_RETRY_MIN = [1, 5, 15, 30];
export const publishRetryMinutes = (retries: number) => PUBLISH_RETRY_MIN[Math.min(retries, PUBLISH_RETRY_MIN.length - 1)];
/** How long publishing may keep failing on temporary errors before the run fails. */
export const PUBLISH_GIVE_UP_MS = 6 * 3600_000;
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);

/** GitHub refused for its rate limit: a 429, or a 403 that says the quota is used up or to retry later. */
export function isRateLimited(err: unknown): boolean {
  const e = err as { status?: unknown; response?: { headers?: Record<string, unknown> } } | null;
  if (e?.status === 429) return true;
  const h = e?.response?.headers ?? {};
  return e?.status === 403 && (String(h['x-ratelimit-remaining']) === '0' || h['retry-after'] !== undefined);
}

/** A GitHub 5xx or rate limit, or a network error: worth retrying later rather than failing the run. */
export function isTransient(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { status?: unknown; code?: unknown; name?: unknown; cause?: unknown };
  if (typeof e.status === 'number') return e.status >= 500 || isRateLimited(err);
  const cause = typeof e.cause === 'object' && e.cause !== null ? (e.cause as { code?: unknown }).code : undefined;
  return NETWORK_CODES.has(String(e.code)) || NETWORK_CODES.has(String(cause)) || e.name === 'TimeoutError';
}
