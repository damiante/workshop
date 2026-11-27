import type { AgentName, Size, Stage, UsageWindow, WindowProjection } from './api-types.ts';

/** Pure projections for the Usage page: no database, no clock. */

export const FIVE_HOURS = 5 * 3600_000;
export const SEVEN_DAYS = 7 * 86400_000;
const HOUR = 3600_000;
/** Under this, a pace is too noisy to project from. */
const MIN_ELAPSED = 15 * 60_000;

/**
 * Where a subscription window is heading at its average pace since it began.
 * Null without a reading from the current window, or once the window has reset (the launch gate counts that as empty).
 */
export function windowProjection(w: UsageWindow | null, length: number, limit: number, sampledAt: number | null, now: number): WindowProjection | null {
  if (!w || w.resetsAt === null || sampledAt === null) return null;
  const resetsAt = w.resetsAt;
  const start = resetsAt - length;
  if (sampledAt < start || resetsAt <= now) return null;
  const elapsed = sampledAt - start;
  const ratePerHour = elapsed < MIN_ELAPSED ? 0 : w.pct / (elapsed / HOUR);
  const reaches = (target: number) => {
    if (w.pct >= target) return sampledAt;
    if (ratePerHour <= 0) return null;
    const at = Math.round(sampledAt + ((target - w.pct) / ratePerHour) * HOUR);
    return at < resetsAt ? at : null;
  };
  return { pct: w.pct, resetsAt, ratePerHour, limitAt: reaches(limit), fullAt: reaches(100), over: w.pct > limit };
}

/**
 * When today's API spend reaches the daily limit at today's pace since midnight: `now` if it already has,
 * null if it won't today or the limit is $0 (API launches are off).
 */
export function capAt(spent: number, cap: number, dayStart: number, now: number): number | null {
  if (cap <= 0) return null;
  if (spent >= cap) return now;
  if (spent <= 0 || now - dayStart < MIN_ELAPSED) return null;
  const at = Math.round(dayStart + cap / (spent / (now - dayStart)));
  return at < dayStart + 24 * HOUR ? at : null;
}

/** Month-to-date plus `perDay` for the rest of today (`dayFraction` has passed) and the days left. `todayKey` is 'YYYY-MM-DD'. */
export function monthEnd(monthToDate: number, perDay: number, todayKey: string, dayFraction: number): number {
  const [y, m, d] = todayKey.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return monthToDate + perDay * (daysInMonth - d + (1 - dayFraction));
}

/** How far back finished tickets count, how many of a size it takes to trust that size, the drain's step and how far it looks. */
export const BACKLOG_HISTORY = 90 * 86400_000,
  MIN_TICKETS = 3,
  STEP = 15 * 60_000,
  HORIZON = 60 * 86400_000;

const PIPELINE: AgentName[] = ['classifier', 'design', 'design-review', 'implement', 'code-review', 'merge'];

/** Agents a ticket at `stage` may still need, in pipeline order. Empty for pr-review (waiting on you). */
export function remainingAgents(stage: Stage | null): AgentName[] {
  switch (stage) {
    case null:
    case 'reclassify':
      return PIPELINE;
    case 'design':
    case 'design-review':
    case 'implement':
    case 'code-review':
    case 'merge':
      return PIPELINE.slice(PIPELINE.indexOf(stage));
    case 'reconcile':
      return ['merge'];
    case 'pr-review':
      return [];
  }
}

export interface Spent {
  usd: number;
  tokens: number;
}
export type CostTable = Record<Size | 'all', { tickets: number; byAgent: Partial<Record<AgentName, Spent>> }>;

/** Mean spend per finished ticket by agent, per size and for all sizes. `rows` are one per finished ticket and agent. */
export function costTable(rows: { ticket: number; size: Size | null; agent: AgentName; usd: number; tokens: number }[]): CostTable {
  const sums = new Map<Size | 'all', { tickets: Set<number>; byAgent: Partial<Record<AgentName, Spent>> }>();
  const add = (key: Size | 'all', r: (typeof rows)[number]) => {
    let g = sums.get(key);
    if (!g) sums.set(key, (g = { tickets: new Set(), byAgent: {} }));
    g.tickets.add(r.ticket);
    const a = (g.byAgent[r.agent] ??= { usd: 0, tokens: 0 });
    a.usd += r.usd;
    a.tokens += r.tokens;
  };
  for (const r of rows) {
    add('all', r);
    if (r.size) add(r.size, r);
  }
  const keys: (Size | 'all')[] = ['xs', 's', 'm', 'l', 'xl', 'all'];
  return Object.fromEntries(
    keys.map((k) => {
      const g = sums.get(k);
      const n = g?.tickets.size ?? 0;
      // Dividing by every finished ticket of the size counts an agent a ticket never ran as 0.
      const byAgent = Object.fromEntries(Object.entries(g?.byAgent ?? {}).map(([a, s]) => [a, { usd: s.usd / n, tokens: s.tokens / n }]));
      return [k, { tickets: n, byAgent }];
    }),
  ) as CostTable;
}

/** A ticket's expected remaining spend by agent, or null when no finished ticket exists to estimate from. */
export function ticketEstimate(table: CostTable, size: Size | null, stage: Stage | null): Partial<Record<AgentName, Spent>> | null {
  if (table.all.tickets === 0) return null;
  const means = size && table[size].tickets >= MIN_TICKETS ? table[size].byAgent : table.all.byAgent;
  return Object.fromEntries(remainingAgents(stage).map((a) => [a, means[a] ?? { usd: 0, tokens: 0 }]));
}

/** A ceiling on an account, in token-equivalent USD. `limit` is a block Claude reported; it opens at `resetsAt`. */
export interface DrainWindow {
  kind: 'five-hour' | 'weekly' | 'daily' | 'limit';
  left: number;
  perWindow: number;
  resetsAt: number;
  length: number;
}
export interface DrainResult {
  finishAt: number | null;
  unlimitedAt: number | null;
  limitedBy: Exclude<DrainWindow['kind'], 'limit'> | null;
  /** [time, fraction of the work left]: now, hourly, then the finish. */
  curve: [number, number][];
}

/**
 * Simulates `work` USD drawn at `perHour` across `accounts`, in order (each a list of windows; [] is unlimited).
 * Null times when nothing can be drawn (no pace, no accounts) or the work runs past the horizon.
 */
export function drain(work: number, perHour: number, accounts: DrainWindow[][], now: number): DrainResult {
  if (work <= 0) return { finishAt: now, unlimitedAt: now, limitedBy: null, curve: [] };
  if (perHour <= 0 || accounts.length === 0) return { finishAt: null, unlimitedAt: null, limitedBy: null, curve: [] };
  const unlimitedAt = Math.round(now + (work / perHour) * HOUR);
  const windows = accounts.map((a) => a.map((w) => ({ ...w })));
  const demand = (perHour * STEP) / HOUR;
  const held = new Map<DrainWindow['kind'], number>();
  const curve: [number, number][] = [[now, 1]];
  let left = work;
  for (let t = now, i = 1; t < now + HORIZON; t += STEP, i++) {
    for (const w of windows.flat()) {
      while (w.resetsAt <= t) {
        w.left = w.perWindow;
        w.resetsAt += w.length;
      }
    }
    const want = Math.min(demand, left);
    let need = want;
    const binding: DrainWindow['kind'][] = [];
    for (const account of windows) {
      if (need <= 0) break;
      const room = Math.min(Infinity, ...account.map((w) => w.left));
      const take = Math.min(need, room);
      for (const w of account) w.left -= take;
      need -= take;
      if (need > 0) binding.push(account.reduce((a, b) => (b.left < a.left ? b : a)).kind);
    }
    // Only a step where no account could take the rest counts against a limit.
    if (need > 1e-9 * demand) for (const kind of binding) held.set(kind, (held.get(kind) ?? 0) + 1);
    const served = want - need;
    if (served >= left - 1e-9 * work) {
      const finishAt = Math.round(t + (STEP * left) / demand);
      curve.push([finishAt, 0]);
      return { finishAt, unlimitedAt, limitedBy: limitedBy(held), curve };
    }
    left -= served;
    if (i % (HOUR / STEP) === 0) curve.push([t + STEP, left / work]);
  }
  return { finishAt: null, unlimitedAt, limitedBy: limitedBy(held), curve };
}

/** The window kind that most often left demand unmet; a reported block doesn't count (it's shown on its own). */
function limitedBy(held: Map<DrainWindow['kind'], number>): DrainResult['limitedBy'] {
  let best: DrainResult['limitedBy'] = null;
  let most = 0;
  for (const [kind, n] of held) {
    if (kind !== 'limit' && n > most) [best, most] = [kind, n];
  }
  return best;
}

/** Under this percentage a window's reading is too noisy to size it from. */
const MIN_SIZING_PCT = 5;

/**
 * A subscription window's room in token-equivalent USD, sized from what this connection spent since the window began.
 * Null without a current reading of at least 5%, or with no spend to size it from.
 */
export function windowCapacity(w: WindowProjection | null, limit: number, usdSinceStart: number, kind: 'five-hour' | 'weekly', length: number): DrainWindow | null {
  if (!w || w.pct < MIN_SIZING_PCT || usdSinceStart <= 0) return null;
  const usdPerPct = usdSinceStart / w.pct;
  return { kind, left: Math.max(0, limit - w.pct) * usdPerPct, perWindow: limit * usdPerPct, resetsAt: w.resetsAt, length };
}
