import type { AllowanceView, Limits, UsageWindow } from './api-types.ts';
import { all, one, run } from './db.ts';
import { publish } from './events.ts';
import { getConnection, listConnections } from './providers/index.ts';

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
  };
}

/** A connection's usage readings since `since`, oldest first. */
export function allowanceSamples(connectionId: number, since: number): { ts: number; fiveHour: number | null; sevenDay: number | null }[] {
  return all<{ ts: number; fiveHour: number | null; sevenDay: number | null }>(
    "SELECT ts, five_hour AS fiveHour, seven_day AS sevenDay FROM allowance_samples WHERE connection_id = ? AND source = 'probe' AND ts >= ? ORDER BY ts, rowid",
    connectionId,
    since,
  );
}

/** Allowance for every Claude connection that has a subscription token. */
export function allowanceViews(): AllowanceView[] {
  return listConnections('model')
    .filter((c) => c.secret.oauthToken)
    .map((c) => allowanceOf(c.id, c.name, c.limits));
}

export function recordProbe(connectionId: number, fiveHour: UsageWindow | null, sevenDay: UsageWindow | null) {
  run(
    "INSERT INTO allowance_samples (connection_id, ts, source, five_hour, five_hour_resets, seven_day, seven_day_resets) VALUES (?, ?, 'probe', ?, ?, ?, ?)",
    connectionId,
    Date.now(),
    fiveHour?.pct ?? null,
    fiveHour?.resetsAt ?? null,
    sevenDay?.pct ?? null,
    sevenDay?.resetsAt ?? null,
  );
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

