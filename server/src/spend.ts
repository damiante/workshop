import { allowanceSamples, allowanceViews, apiSpendSince } from './allowance.ts';
import type { AllowanceHistory, LifetimeSpend, SpendSeries, SpendTotals, UsageHistory, UsageRange } from './api-types.ts';
import { all, one, run } from './db.ts';
import { capAt, FIVE_HOURS, monthEnd, SEVEN_DAYS, windowProjection } from './projection.ts';
import type { RunRow } from './runs.ts';
import { startOfDay } from './scheduler/gates.ts';
import { getSettings } from './settings.ts';

/** Adds one `claude` invocation's result to the ledger and to the run's own totals (a resumed run sums its invocations). */
export function recordSpend(r: RunRow, res: { inputTokens?: number; outputTokens?: number; costUsd?: number }) {
  const input = res.inputTokens ?? 0;
  const output = res.outputTokens ?? 0;
  const cost = res.costUsd ?? 0;
  const where = one<{ full_name: string; number: number }>('SELECT repos.full_name, tickets.number FROM tickets JOIN repos ON repos.id = tickets.repo_id WHERE tickets.id = ?', r.ticket_id);
  const conn = r.model_connection_id === null ? undefined : one<{ name: string }>('SELECT name FROM connections WHERE id = ?', r.model_connection_id);
  run(
    'INSERT INTO spend (run_id, ts, model, billing, input_tokens, output_tokens, cost_usd, repo, agent, ticket, connection_id, connection) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    r.id,
    Date.now(),
    r.model,
    r.billing,
    input,
    output,
    cost,
    where?.full_name ?? null,
    r.agent,
    where?.number ?? null,
    conn ? r.model_connection_id : null,
    conn?.name ?? null,
  );
  run(
    'UPDATE runs SET input_tokens = COALESCE(input_tokens, 0) + ?, output_tokens = COALESCE(output_tokens, 0) + ?, cost_usd = COALESCE(cost_usd, 0) + ? WHERE id = ?',
    input,
    output,
    cost,
    r.id,
  );
}

/** One ledger row. `repo`, `agent` and `ticket` are null when the run was deleted before they were recorded. */
export interface SpendRow {
  run_id: string;
  ts: number;
  model: string;
  billing: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  repo: string | null;
  agent: string | null;
  ticket: number | null;
  connection_id: number | null;
  /** The connection's name when recorded. */
  connection: string | null;
}

const zero = (): SpendTotals => ({ runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });

/** Totals per bucket of `key`, counting each run id once per bucket so a resumed run counts once. */
function groupBy(rows: SpendRow[], key: (row: SpendRow) => string | null): Map<string | null, SpendTotals> {
  const groups = new Map<string | null, { t: SpendTotals; ids: Set<string> }>();
  for (const row of rows) {
    const k = key(row);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { t: zero(), ids: new Set() }));
    if (!g.ids.has(row.run_id)) {
      g.ids.add(row.run_id);
      g.t.runs++;
    }
    g.t.inputTokens += row.input_tokens;
    g.t.outputTokens += row.output_tokens;
    g.t.costUsd += row.cost_usd;
  }
  return new Map([...groups].map(([k, g]) => [k, g.t]));
}

/** What the lifetime view can group by. Built per call because the month depends on the time zone. */
const dimensions = (timeZone: string) => {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' });
  return {
    model: (row: SpendRow) => row.model,
    month: (row: SpendRow) => fmt.format(row.ts).slice(0, 7),
    project: (row: SpendRow) => row.repo,
    // A connection can hold a subscription token and an API key; each is its own account on Anthropic's side.
    connection: (row: SpendRow) => `${row.connection_id ?? ''}:${row.billing}`,
  };
};

/** Labels a connection's totals with its current name, or the latest recorded one if it was removed. */
function connectionTotals(key: string, rows: SpendRow[], t: SpendTotals) {
  const [id, billing] = key.split(':');
  if (!id) return { connectionId: null, connection: null, billing, ...t };
  const current = one<{ name: string }>('SELECT name FROM connections WHERE id = ?', Number(id));
  const recorded = rows.findLast((r) => String(r.connection_id) === id)?.connection ?? null;
  return { connectionId: Number(id), connection: current?.name ?? recorded, billing, ...t };
}

export function lifetimeSpend(timeZone: string): LifetimeSpend {
  const rows = all<SpendRow>('SELECT * FROM spend ORDER BY ts, id');
  const DIMENSIONS = dimensions(timeZone);
  const totals = (subset: SpendRow[]) => groupBy(subset, () => '').get('') ?? zero();
  const byCost = (a: SpendTotals, b: SpendTotals) => b.costUsd - a.costUsd;
  return {
    since: rows[0]?.ts ?? null,
    total: totals(rows),
    subscription: totals(rows.filter((r) => r.billing !== 'api')),
    api: totals(rows.filter((r) => r.billing === 'api')),
    byModel: [...groupBy(rows, DIMENSIONS.model)].map(([model, t]) => ({ model: model!, ...t })).sort(byCost),
    byProject: [...groupBy(rows, DIMENSIONS.project)].map(([project, t]) => ({ project, ...t })).sort(byCost),
    byConnection: [...groupBy(rows, DIMENSIONS.connection)].map(([key, t]) => connectionTotals(key!, rows, t)).sort(byCost),
    byMonth: [...groupBy(rows, DIMENSIONS.month)].map(([month, t]) => ({ month: month!, ...t })).sort((a, b) => b.month.localeCompare(a.month)),
  };
}

const DAY = 86400_000;
const RANGE_DAYS: Record<Exclude<UsageRange, 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90 };
export const USAGE_RANGES: UsageRange[] = ['7d', '30d', '90d', 'all'];

/** 'YYYY-MM-DD' a number of calendar days before `key`; calendar arithmetic, so DST can't skip or repeat a day. */
const dayBefore = (key: string, days: number) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
};

/** Every 'YYYY-MM' from `first` to `last`, inclusive. */
function monthsBetween(first: string, last: string): string[] {
  const out: string[] = [];
  let [y, m] = first.split('-').map(Number);
  for (let key = first; key <= last; key = `${y}-${String(m).padStart(2, '0')}`) {
    out.push(key);
    if (++m > 12) [y, m] = [y + 1, 1];
  }
  return out;
}

/** One series per group, each split into `buckets`, sorted by cost over the range. */
function seriesOf(rows: SpendRow[], buckets: string[], bucketOf: (row: SpendRow) => string, keyOf: (row: SpendRow) => string, nameOf: (key: string) => string): SpendSeries[] {
  const groups = new Map<string, SpendRow[]>();
  for (const row of rows) {
    const k = keyOf(row);
    const g = groups.get(k);
    if (g) g.push(row);
    else groups.set(k, [row]);
  }
  return [...groups]
    .map(([key, subset]) => {
      const perBucket = groupBy(subset, bucketOf);
      return { key, name: nameOf(key), points: buckets.map((b) => perBucket.get(b) ?? zero()), totals: groupBy(subset, () => '').get('') ?? zero() };
    })
    .sort((a, b) => b.totals.costUsd - a.totals.costUsd);
}

/** Spend over time for the Usage page, by every grouping, with subscription readings and projections. */
export function usageHistory(range: UsageRange, timeZone: string, now = Date.now()): UsageHistory {
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dayOf = (ts: number) => dayFmt.format(ts);
  const monthOf = (ts: number) => dayOf(ts).slice(0, 7);
  const today = dayOf(now);
  const thisMonth = today.slice(0, 7);

  let rows: SpendRow[];
  let buckets: string[];
  let bucketOf: (row: SpendRow) => string;
  if (range === 'all') {
    rows = all<SpendRow>('SELECT * FROM spend ORDER BY ts, id');
    buckets = monthsBetween(rows.length ? monthOf(rows[0].ts) : thisMonth, thisMonth);
    bucketOf = (row) => monthOf(row.ts);
  } else {
    const days = RANGE_DAYS[range];
    buckets = Array.from({ length: days }, (_, i) => dayBefore(today, days - 1 - i));
    const keys = new Set(buckets);
    bucketOf = (row) => dayOf(row.ts);
    rows = all<SpendRow>('SELECT * FROM spend WHERE ts >= ? ORDER BY ts, id', now - (days + 1) * DAY).filter((r) => keys.has(bucketOf(r)));
  }

  const billingOf = (row: SpendRow) => (row.billing === 'api' ? 'api' : 'subscription');
  const connectionName = (key: string) => {
    const c = connectionTotals(key, rows, zero());
    return `${c.connection ?? 'Unknown'} (${c.billing === 'api' ? 'API key' : 'subscription'})`;
  };

  const allowance: AllowanceHistory[] = allowanceViews().map((v) => ({
    connectionId: v.connectionId,
    connectionName: v.connectionName,
    limits: v.limits,
    samples: allowanceSamples(v.connectionId, now - SEVEN_DAYS),
    sampledAt: v.sampledAt,
    blockedUntil: v.blockedUntil,
    unknown: v.unknown,
    fiveHour: windowProjection(v.fiveHour, FIVE_HOURS, v.limits.fiveHour, v.sampledAt, now),
    sevenDay: windowProjection(v.sevenDay, SEVEN_DAYS, v.limits.weekly, v.sampledAt, now),
  }));

  // Projections don't depend on the range: this month so far, and the pace over the last 7 days.
  const dayStart = startOfDay(now, timeZone);
  const dayFraction = Math.min(1, (now - dayStart) / DAY);
  const recent = all<SpendRow>('SELECT * FROM spend WHERE ts >= ? AND ts <= ?', now - 32 * DAY, now);
  const firstApi = one<{ ts: number | null }>("SELECT MIN(ts) AS ts FROM spend WHERE billing = 'api'")?.ts ?? now;
  const firstSubscription = one<{ ts: number | null }>("SELECT MIN(ts) AS ts FROM spend WHERE billing != 'api'")?.ts ?? now;
  const sum = (subset: SpendRow[], f: (r: SpendRow) => number) => subset.reduce((n, r) => n + f(r), 0);
  const pace = (billing: string) => {
    // A billing used for under 7 days averages over the days since its first use (at least 1).
    const paceDays = Math.min(7, Math.max(1, (now - (billing === 'api' ? firstApi : firstSubscription)) / DAY));
    const mine = recent.filter((r) => billingOf(r) === billing);
    const week = mine.filter((r) => r.ts >= now - SEVEN_DAYS);
    const perDayUsd = sum(week, (r) => r.cost_usd) / paceDays;
    const monthToDateUsd = sum(
      mine.filter((r) => monthOf(r.ts) === thisMonth),
      (r) => r.cost_usd,
    );
    return { perDayUsd, perDayTokens: sum(week, (r) => r.input_tokens + r.output_tokens) / paceDays, monthToDateUsd, monthEndUsd: monthEnd(monthToDateUsd, perDayUsd, today, dayFraction) };
  };
  const api = pace('api');
  const subscription = pace('subscription');
  const todayUsd = apiSpendSince(dayStart);
  const dailyCapUsd = getSettings().apiDailyCapUsd;

  return {
    range,
    bucket: range === 'all' ? 'month' : 'day',
    buckets,
    byBilling: seriesOf(rows, buckets, bucketOf, billingOf, (k) => (k === 'api' ? 'API' : 'Subscription')),
    byModel: seriesOf(rows, buckets, bucketOf, (r) => r.model, (k) => k),
    byProject: seriesOf(rows, buckets, bucketOf, (r) => r.repo ?? '', (k) => k || 'Unknown'),
    byConnection: seriesOf(rows, buckets, bucketOf, dimensions(timeZone).connection, connectionName),
    allowance,
    projection: {
      api: { todayUsd, dailyCapUsd, capAt: capAt(todayUsd, dailyCapUsd, dayStart, now), perDayUsd: api.perDayUsd, monthToDateUsd: api.monthToDateUsd, monthEndUsd: api.monthEndUsd },
      subscription,
    },
  };
}

/**
 * Fills repo, agent and ticket on ledger rows that lack them, and adds rows for runs with usage but no ledger row.
 * `schema` is where the runs, tickets and repos come from: 'main', or 'src' for an attached older copy of the database.
 */
export function backfillSpend(schema: 'main' | 'src' = 'main'): { filled: number; added: number } {
  if (schema !== 'main' && schema !== 'src') throw new Error(`Unknown schema: ${schema}`);
  run('BEGIN');
  try {
    const filled = Number(
      run(
        `UPDATE main.spend SET repo = x.full_name, agent = x.agent, ticket = x.number
         FROM (SELECT runs.id, repos.full_name, runs.agent, tickets.number
               FROM ${schema}.runs JOIN ${schema}.tickets ON tickets.id = runs.ticket_id JOIN ${schema}.repos ON repos.id = tickets.repo_id) AS x
         WHERE x.id = spend.run_id AND spend.repo IS NULL`,
      ).changes,
    );
    const added = Number(
      run(
        `INSERT INTO main.spend (run_id, ts, model, billing, input_tokens, output_tokens, cost_usd, repo, agent, ticket, connection_id, connection)
         SELECT runs.id, COALESCE(runs.ended_at, runs.started_at), runs.model, runs.billing,
                COALESCE(runs.input_tokens, 0), COALESCE(runs.output_tokens, 0), COALESCE(runs.cost_usd, 0),
                repos.full_name, runs.agent, tickets.number, connections.id, connections.name
         FROM ${schema}.runs
         LEFT JOIN ${schema}.tickets ON tickets.id = runs.ticket_id
         LEFT JOIN ${schema}.repos ON repos.id = tickets.repo_id
         LEFT JOIN ${schema}.connections ON connections.id = runs.model_connection_id
         WHERE (runs.input_tokens IS NOT NULL OR runs.output_tokens IS NOT NULL OR runs.cost_usd IS NOT NULL)
           AND runs.id NOT IN (SELECT run_id FROM main.spend)`,
      ).changes,
    );
    run('COMMIT');
    return { filled, added };
  } catch (err) {
    run('ROLLBACK');
    throw err;
  }
}
