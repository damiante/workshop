import type { AllowanceView, UsageWindow } from './api-types.ts';
import { one, run } from './db.ts';
import { publish } from './events.ts';
import { listConnections } from './providers/index.ts';

interface SampleRow {
  ts: number;
  five_hour: number | null;
  five_hour_resets: number | null;
  seven_day: number | null;
  seven_day_resets: number | null;
  blocked_until: number | null;
}

const window = (pct: number | null, resetsAt: number | null): UsageWindow | null => (pct === null ? null : { pct, resetsAt });

export function allowanceOf(connectionId: number, name = ''): AllowanceView {
  const probe = one<SampleRow>("SELECT * FROM allowance_samples WHERE connection_id = ? AND source = 'probe' ORDER BY ts DESC LIMIT 1", connectionId);
  const block = one<{ blocked_until: number }>(
    "SELECT blocked_until FROM allowance_samples WHERE connection_id = ? AND source = 'limit' ORDER BY ts DESC LIMIT 1",
    connectionId,
  );
  return {
    connectionId,
    connectionName: name,
    fiveHour: probe ? window(probe.five_hour, probe.five_hour_resets) : null,
    sevenDay: probe ? window(probe.seven_day, probe.seven_day_resets) : null,
    sampledAt: probe?.ts ?? null,
    blockedUntil: block && block.blocked_until > Date.now() ? block.blocked_until : null,
  };
}

/** Allowance for every Claude connection that has a subscription token. */
export function allowanceViews(): AllowanceView[] {
  return listConnections('model')
    .filter((c) => c.secret.oauthToken)
    .map((c) => allowanceOf(c.id, c.name));
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

