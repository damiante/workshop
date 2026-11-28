import type { AllowanceView, Burndown, BurndownWeek, Limits, UsageWindow } from './api-types.ts';
import { burndownCeiling, heldHours, learnRates, nextMargin, SAME_WINDOW_MS, WEEK_HOURS, type Rates, type Reading } from './burndown.ts';
import { all, one, run } from './db.ts';
import { publish } from './events.ts';
import { getConnection, listConnections, setBurndownMargin } from './providers/index.ts';
import { getSettings } from './settings.ts';

/** What a new connection starts with, and what a run judges by when its connection is gone. */
export const DEFAULT_LIMITS: Limits = { fiveHour: 70, weekly: 80 };

interface SampleRow {
  ts: number;
  five_hour: number | null;
  five_hour_resets: number | null;
  seven_day: number | null;
  seven_day_resets: number | null;
  blocked_until: number | null;
}

const window = (pct: number | null, resetsAt: number | null): UsageWindow | null => (pct === null ? null : { pct, resetsAt });

export function allowanceOf(connectionId: number, name = '', limits?: Limits): AllowanceView {
  const probe = one<SampleRow>("SELECT * FROM allowance_samples WHERE connection_id = ? AND source = 'probe' ORDER BY ts DESC, rowid DESC LIMIT 1", connectionId);
  const block = one<{ blocked_until: number }>(
    "SELECT blocked_until FROM allowance_samples WHERE connection_id = ? AND source = 'limit' ORDER BY ts DESC LIMIT 1",
    connectionId,
  );
  const tokensSince = (ms: number) =>
    one<{ n: number | null }>('SELECT SUM(input_tokens + output_tokens) AS n FROM spend WHERE connection_id = ? AND ts >= ?', connectionId, Date.now() - ms)?.n ?? 0;
  return {
    connectionId,
    connectionName: name,
    fiveHour: probe ? window(probe.five_hour, probe.five_hour_resets) : null,
    sevenDay: probe ? window(probe.seven_day, probe.seven_day_resets) : null,
    sampledAt: probe?.ts ?? null,
    blockedUntil: block && block.blocked_until > Date.now() ? block.blocked_until : null,
    unknown: Boolean(probe) && probe!.five_hour === null && probe!.seven_day === null,
    tokens: { fiveHour: tokensSince(5 * 3600_000), sevenDay: tokensSince(7 * 86400_000) },
    limits: limits ?? getConnection(connectionId)?.limits ?? DEFAULT_LIMITS,
    burndown: burndownOf(connectionId, limits),
  };
}

const HOUR = 3600_000;
const WEEK = WEEK_HOURS * HOUR;
/** How far back the rates and closed weeks look. Readings are kept a day longer. */
const LEARN_MS = 14 * 86400_000;
export const SAMPLE_RETENTION_MS = 15 * 86400_000;
const RATES_TTL_MS = 10 * 60_000;
const BURNDOWN_TTL_MS = 60_000;

const ratesCache = new Map<number, { at: number; rates: Rates }>();
const burndownCache = new Map<number, { at: number; fiveHourLimit: number; value: Burndown }>();

/** Clears the cached burndown of one connection, or of all; the rates stay cached. */
export function forgetBurndown(connectionId?: number) {
  if (connectionId === undefined) burndownCache.clear();
  else burndownCache.delete(connectionId);
}

/** Clears the cached rates as well: for tests that rewrite readings. */
export function forgetRates() {
  ratesCache.clear();
  burndownCache.clear();
}

const fresh = (at: number, now: number, ttl: number) => at <= now && now - at < ttl;

function readings(connectionId: number, since: number): (Reading & { bound: string | null })[] {
  return all<Reading & { bound: string | null }>(
    `SELECT ts, five_hour AS five, five_hour_resets AS fiveResets, seven_day AS week, seven_day_resets AS weekResets, active, ceiling, burndown, bound
     FROM allowance_samples WHERE connection_id = ? AND source = 'probe' AND ts >= ? ORDER BY ts, rowid`,
    connectionId,
    since,
  );
}

function ratesOf(connectionId: number, now: number): Rates {
  const hit = ratesCache.get(connectionId);
  if (hit && fresh(hit.at, now, RATES_TTL_MS)) return hit.rates;
  const rates = learnRates(readings(connectionId, now - LEARN_MS));
  ratesCache.set(connectionId, { at: now, rates });
  return rates;
}

/** The latest reading's weekly reset, or null without a weekly reading. */
const latestWeeklyReset = (connectionId: number) =>
  one<{ r: number | null; w: number | null }>(
    "SELECT seven_day_resets AS r, seven_day AS w FROM allowance_samples WHERE connection_id = ? AND source = 'probe' ORDER BY ts DESC, rowid DESC LIMIT 1",
    connectionId,
  );

/** A subscription's weekly burndown now. Cached for a minute: in that time the line moves less than 0.1 points. */
export function burndownOf(connectionId: number, limits?: Limits): Burndown {
  const now = Date.now();
  const conn = getConnection(connectionId);
  const fiveHourLimit = limits?.fiveHour ?? conn?.limits.fiveHour ?? DEFAULT_LIMITS.fiveHour;
  const enabled = Boolean(conn?.burndown);
  const hit = burndownCache.get(connectionId);
  if (hit && hit.fiveHourLimit === fiveHourLimit && hit.value.enabled === enabled && fresh(hit.at, now, BURNDOWN_TTL_MS)) return hit.value;
  const rates = ratesOf(connectionId, now);
  const latest = latestWeeklyReset(connectionId);
  const line = burndownCeiling({
    now,
    resetsAt: latest?.w != null ? latest.r : null,
    margin: conn?.burndownMargin ?? 3,
    rates,
    fiveHourLimit,
    settings: getSettings(),
  });
  const value: Burndown = {
    enabled,
    ceiling: line.ceiling === null ? null : Math.round(line.ceiling * 10) / 10,
    target: line.target,
    otherPerHour: rates.otherPerHour,
    workshopPerHour: rates.workshopPerHour,
    duty: line.duty,
    bound: line.bound,
    basis: { otherHours: rates.otherHours, workshopHours: rates.workshopHours },
  };
  burndownCache.set(connectionId, { at: now, fiveHourLimit, value });
  return value;
}

/** A connection's usage readings since `since`, oldest first. */
export function allowanceSamples(connectionId: number, since: number): { ts: number; fiveHour: number | null; sevenDay: number | null; ceiling: number | null; burndown: boolean | null }[] {
  return all<{ ts: number; fiveHour: number | null; sevenDay: number | null; ceiling: number | null; burndown: number | null }>(
    "SELECT ts, five_hour AS fiveHour, seven_day AS sevenDay, ceiling, burndown FROM allowance_samples WHERE connection_id = ? AND source = 'probe' AND ts >= ? ORDER BY ts, rowid",
    connectionId,
    since,
  ).map((r) => ({ ...r, burndown: r.burndown === null ? null : Boolean(r.burndown) }));
}

/**
 * Writes how each ended weekly window went, once, and moves the margin of a subscription whose burndown was on
 * for most of it. Only windows that ended in the last week: older ones may have lost readings. Returns whether a margin changed.
 */
export function closeWeeks(now: number): boolean {
  let changed = false;
  for (const c of listConnections('model').filter((c) => c.secret.oauthToken)) {
    const weeks: Reading[][] = [];
    for (const r of readings(c.id, now - LEARN_MS)) {
      if (r.week === null || r.weekResets === null) continue;
      const last = weeks[weeks.length - 1];
      if (last && Math.abs(last[last.length - 1].weekResets! - r.weekResets) < SAME_WINDOW_MS) last.push(r);
      else weeks.push([r]);
    }
    let margin = c.burndownMargin;
    for (const week of weeks) {
      const resetsAt = week[week.length - 1].weekResets!;
      if (resetsAt > now || resetsAt <= now - WEEK) continue;
      if (one('SELECT 1 FROM burndown_weeks WHERE connection_id = ? AND resets_at > ? AND resets_at < ?', c.id, resetsAt - SAME_WINDOW_MS, resetsAt + SAME_WINDOW_MS)) continue;
      const on = week.filter((r) => r.burndown === 1).length;
      const result = {
        enabled: on * 2 > week.length,
        finalPct: Math.max(...week.map((r) => r.week!)),
        heldHours: heldHours(week),
        blocked: Boolean(
          one("SELECT 1 FROM allowance_samples WHERE connection_id = ? AND source = 'limit' AND blocked_until > ? AND blocked_until < ?", c.id, resetsAt - HOUR, resetsAt + HOUR),
        ),
      };
      const after = nextMargin(margin, result);
      const rates = ratesOf(c.id, now);
      run(
        `INSERT INTO burndown_weeks (connection_id, resets_at, enabled, final_pct, held_hours, blocked, margin_before, margin_after, other_per_hour, workshop_per_hour, five_per_hour)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        c.id,
        resetsAt,
        Number(result.enabled),
        result.finalPct,
        result.heldHours,
        Number(result.blocked),
        margin,
        after,
        rates.otherPerHour,
        rates.workshopPerHour,
        rates.fivePerHour,
      );
      margin = after;
    }
    if (margin !== c.burndownMargin) {
      setBurndownMargin(c.id, margin);
      forgetBurndown(c.id);
      changed = true;
    }
  }
  return changed;
}

/** A subscription's closed weeks, newest first. */
export function burndownWeeks(connectionId: number, n = 8): BurndownWeek[] {
  return all<{ resets_at: number; enabled: number; final_pct: number | null; held_hours: number; blocked: number; margin_before: number; margin_after: number }>(
    'SELECT * FROM burndown_weeks WHERE connection_id = ? ORDER BY resets_at DESC LIMIT ?',
    connectionId,
    n,
  ).map((w) => ({
    resetsAt: w.resets_at,
    enabled: Boolean(w.enabled),
    finalPct: w.final_pct,
    heldHours: w.held_hours,
    blocked: Boolean(w.blocked),
    marginBefore: w.margin_before,
    marginAfter: w.margin_after,
  }));
}

/** Allowance for every Claude connection that has a subscription token. */
export function allowanceViews(): AllowanceView[] {
  return listConnections('model')
    .filter((c) => c.secret.oauthToken)
    .map((c) => allowanceOf(c.id, c.name, c.limits));
}

/**
 * Stores a usage reading with what the burndown needs to learn from it later: how many of this subscription's
 * agents were running, and the line in force. The cached line is only re-made when the weekly reset moves.
 */
export function recordProbe(connectionId: number, fiveHour: UsageWindow | null, sevenDay: UsageWindow | null) {
  const before = latestWeeklyReset(connectionId);
  const active = one<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE model_connection_id = ? AND status = 'running' AND step = 'run'", connectionId)!.n;
  const { lastInsertRowid } = run(
    "INSERT INTO allowance_samples (connection_id, ts, source, five_hour, five_hour_resets, seven_day, seven_day_resets, active) VALUES (?, ?, 'probe', ?, ?, ?, ?, ?)",
    connectionId,
    Date.now(),
    fiveHour?.pct ?? null,
    fiveHour?.resetsAt ?? null,
    sevenDay?.pct ?? null,
    sevenDay?.resetsAt ?? null,
    active,
  );
  if ((before?.w != null ? before.r : null) !== (sevenDay ? sevenDay.resetsAt : null)) forgetBurndown(connectionId);
  const b = burndownOf(connectionId);
  run('UPDATE allowance_samples SET ceiling = ?, burndown = ?, bound = ? WHERE rowid = ?', b.ceiling, Number(b.enabled), b.bound, lastInsertRowid);
  publish('allowance');
}

/** Claude reported a usage limit mid-run: hold launches on this connection until it resets. */
export function recordLimit(connectionId: number, resetsAt: number) {
  run("INSERT INTO allowance_samples (connection_id, ts, source, blocked_until) VALUES (?, ?, 'limit', ?)", connectionId, Date.now(), resetsAt);
  publish('allowance');
}

export function apiSpendSince(since: number): number {
  return one<{ total: number | null }>("SELECT SUM(cost_usd) AS total FROM runs WHERE billing = 'api' AND started_at >= ?", since)?.total ?? 0;
}

