import { getAgent } from './agents.ts';
import { allowanceSamples, allowanceViews, apiSpendSince } from './allowance.ts';
import type { AgentName, AllowanceHistory, BacklogPool, BacklogProjection, BurnRate, LifetimeSpend, SpendSeries, SpendTotals, Stage, TicketSpend, UsageHistory, UsageRange } from './api-types.ts';
import { all, one, run } from './db.ts';
import {
  BACKLOG_HISTORY,
  capAt,
  costTable,
  drain,
  FIVE_HOURS,
  monthEnd,
  SEVEN_DAYS,
  ticketEstimate,
  windowCapacity,
  windowProjection,
  type DrainWindow,
} from './projection.ts';
import { getConnection } from './providers/index.ts';
import type { RunRow } from './runs.ts';
import { startOfDay } from './scheduler/gates.ts';
import { getSettings } from './settings.ts';
import { getRepo, isAllowedAuthor, labelsOf, openTicketsSql, ticketInScope, type TicketRow } from './tickets.ts';
import { parseLabels } from './workflow/labels.ts';

/** Adds one `claude` invocation's result to the ledger and to the run's own totals (a resumed run sums its invocations). */
/**
 * What tokens would have cost, for a session that ended without reporting its cost: the model's own average price per
 * token over what's already in the ledger (cached and fresh input are priced differently, and runs mix them alike).
 * Zero when the model has no history yet.
 */
export function estimateCost(model: string, tokens: number): number {
  const rate = one<{ rate: number | null }>(
    'SELECT SUM(cost_usd) / SUM(input_tokens + output_tokens) AS rate FROM (SELECT cost_usd, input_tokens, output_tokens FROM spend WHERE model = ? AND cost_usd > 0 AND input_tokens + output_tokens > 0 ORDER BY ts DESC LIMIT 50)',
    model,
  )?.rate;
  return rate ? tokens * rate : 0;
}

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
const HOUR = 3600_000;
const RANGE_DAYS: Record<Exclude<UsageRange, '24h' | 'all'>, number> = { '7d': 7, '30d': 30, '90d': 90 };
export const USAGE_RANGES: UsageRange[] = ['24h', '7d', '30d', '90d', 'all'];
/** How many tickets the Usage page's cost per ticket can search and sort; it shows the top 10. */
const TICKET_ROWS = 500;

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

/** What each ticket's runs used, biggest cost first. Spend recorded without its ticket is left out. */
function ticketSpend(rows: SpendRow[]): TicketSpend[] {
  const known = rows.filter((r) => r.repo !== null && r.ticket !== null);
  return [...groupBy(known, (r) => `${r.repo}#${r.ticket}`)]
    .sort(([, a], [, b]) => b.costUsd - a.costUsd)
    .slice(0, TICKET_ROWS)
    .map(([key, t]) => {
      const at = key!.lastIndexOf('#');
      const repo = key!.slice(0, at);
      const number = Number(key!.slice(at + 1));
      const ticket = one<{ title: string; url: string }>(
        'SELECT tickets.title, tickets.url FROM tickets JOIN repos ON repos.id = tickets.repo_id WHERE repos.full_name = ? AND tickets.number = ?',
        repo,
        number,
      );
      return { repo, number, title: ticket?.title ?? null, url: ticket?.url ?? null, ...t };
    });
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
  if (range === '24h') {
    // 'YYYY-MM-DDTHH' on the settings clock. The hour a clock change repeats is one bucket, so there can be 23.
    const hourFmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
    const hourOf = (ts: number) => {
      const p = Object.fromEntries(hourFmt.formatToParts(ts).map((x) => [x.type, x.value]));
      return `${p.year}-${p.month}-${p.day}T${p.hour}`;
    };
    buckets = [...new Set(Array.from({ length: 24 }, (_, i) => hourOf(now - (23 - i) * HOUR)))];
    const keys = new Set(buckets);
    bucketOf = (row) => hourOf(row.ts);
    rows = all<SpendRow>('SELECT * FROM spend WHERE ts >= ? ORDER BY ts, id', now - 25 * HOUR).filter((r) => keys.has(bucketOf(r)));
  } else if (range === 'all') {
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

  // Projections don't depend on the range: this month so far, and the pace over the last 7 days.
  const dayStart = startOfDay(now, timeZone);
  const dayFraction = Math.min(1, (now - dayStart) / DAY);
  const recent = all<SpendRow>('SELECT * FROM spend WHERE ts >= ? AND ts <= ?', now - 32 * DAY, now);
  const firstApi = one<{ ts: number | null }>("SELECT MIN(ts) AS ts FROM spend WHERE billing = 'api'")?.ts ?? now;
  const firstSubscription = one<{ ts: number | null }>("SELECT MIN(ts) AS ts FROM spend WHERE billing != 'api'")?.ts ?? now;
  const sum = (subset: SpendRow[], f: (r: SpendRow) => number) => subset.reduce((n, r) => n + f(r), 0);
  /** A billing or connection used for under 7 days averages over the days since its first use (at least 1). */
  const paceDaysSince = (first: number) => Math.min(7, Math.max(1, (now - first) / DAY));
  const burn = (subset: SpendRow[], first: number): BurnRate => {
    const since = (ms: number) => {
      const s = subset.filter((r) => r.ts >= now - ms);
      return { usd: sum(s, (r) => r.cost_usd), tokens: sum(s, (r) => r.input_tokens + r.output_tokens) };
    };
    const week = since(SEVEN_DAYS);
    const days = paceDaysSince(first);
    return { fiveHours: since(FIVE_HOURS), day: since(DAY), perDay: { usd: week.usd / days, tokens: week.tokens / days } };
  };
  const pace = (billing: string) => {
    const first = billing === 'api' ? firstApi : firstSubscription;
    const paceDays = paceDaysSince(first);
    const mine = recent.filter((r) => billingOf(r) === billing);
    const week = mine.filter((r) => r.ts >= now - SEVEN_DAYS);
    const perDayUsd = sum(week, (r) => r.cost_usd) / paceDays;
    const monthToDateUsd = sum(
      mine.filter((r) => monthOf(r.ts) === thisMonth),
      (r) => r.cost_usd,
    );
    return {
      perDayUsd,
      perDayTokens: sum(week, (r) => r.input_tokens + r.output_tokens) / paceDays,
      monthToDateUsd,
      monthEndUsd: monthEnd(monthToDateUsd, perDayUsd, today, dayFraction),
      burn: burn(mine, first),
    };
  };
  const api = pace('api');
  const subscription = pace('subscription');
  const todayUsd = apiSpendSince(dayStart);
  const dailyCapUsd = getSettings().apiDailyCapUsd;

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
    burn: burn(
      recent.filter((r) => r.connection_id === v.connectionId && r.billing !== 'api'),
      one<{ ts: number | null }>("SELECT MIN(ts) AS ts FROM spend WHERE connection_id = ? AND billing != 'api'", v.connectionId)?.ts ?? now,
    ),
  }));
  const nextMidnight = startOfDay(dayStart + 36 * 3600_000, timeZone);

  return {
    range,
    bucket: range === '24h' ? 'hour' : range === 'all' ? 'month' : 'day',
    buckets,
    byBilling: seriesOf(rows, buckets, bucketOf, billingOf, (k) => (k === 'api' ? 'API' : 'Subscription')),
    byModel: seriesOf(rows, buckets, bucketOf, (r) => r.model, (k) => k),
    byProject: seriesOf(rows, buckets, bucketOf, (r) => r.repo ?? '', (k) => k || 'Unknown'),
    byConnection: seriesOf(rows, buckets, bucketOf, dimensions(timeZone).connection, connectionName),
    byTicket: ticketSpend(rows),
    allowance,
    projection: {
      api: { todayUsd, dailyCapUsd, capAt: capAt(todayUsd, dailyCapUsd, dayStart, now), perDayUsd: api.perDayUsd, monthToDateUsd: api.monthToDateUsd, monthEndUsd: api.monthEndUsd, burn: api.burn },
      subscription,
      backlog: backlog(now, allowance, {
        subscriptionPerHour: subscription.perDayUsd / 24,
        apiPerHour: api.perDayUsd / 24,
        apiWindow: { kind: 'daily', left: Math.max(0, dailyCapUsd - todayUsd), perWindow: dailyCapUsd, resetsAt: nextMidnight, length: DAY },
      }),
    },
  };
}

/** The order `byStage` lists stages in: the pipeline's. */
const STAGE_ORDER: (Stage | 'new')[] = ['new', 'reclassify', 'design', 'design-review', 'implement', 'code-review', 'merge', 'reconcile'];

/**
 * Open tickets, what they should cost and when they finish. Each is costed at what finished tickets of its size spent
 * on the stages it has left, split by each agent's current billing, then drained at the last 7 days' pace.
 */
function backlog(
  now: number,
  allowance: AllowanceHistory[],
  o: { subscriptionPerHour: number; apiPerHour: number; apiWindow: DrainWindow },
): BacklogProjection {
  const open = all<TicketRow>(openTicketsSql).flatMap((t) => {
    const repo = getRepo(t.repo_id)!;
    if (!isAllowedAuthor(t.author) || !ticketInScope(t, repo)) return [];
    const state = parseLabels(labelsOf(t));
    if (state.needsInfo || state.skip || state.failed || state.stage === 'pr-review') return [];
    return [state];
  });

  // One row per finished ticket and agent: closed, with an Implementation run in the window.
  const history = all<{ ticket: number; labels: string; agent: AgentName; usd: number; tokens: number }>(
    `SELECT t.id AS ticket, t.labels, s.agent, SUM(s.cost_usd) AS usd, SUM(s.input_tokens + s.output_tokens) AS tokens
     FROM spend s JOIN repos r ON r.full_name = s.repo JOIN tickets t ON t.repo_id = r.id AND t.number = s.ticket
     WHERE t.state = 'closed' AND s.ts >= ? AND s.agent IS NOT NULL GROUP BY t.id, s.agent`,
    now - BACKLOG_HISTORY,
  );
  const implemented = new Set(history.filter((h) => h.agent === 'implement').map((h) => h.ticket));
  const table = costTable(
    history.filter((h) => implemented.has(h.ticket)).map((h) => ({ ticket: h.ticket, size: parseLabels(JSON.parse(h.labels)).size, agent: h.agent, usd: h.usd, tokens: h.tokens })),
  );

  const billingOf = new Map<AgentName, string>();
  const left = { subscription: { usd: 0, tokens: 0 }, api: { usd: 0, tokens: 0 } };
  let unestimated = 0;
  const counts = new Map<Stage | 'new', number>();
  for (const state of open) {
    const key = state.stage ?? 'new';
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const estimate = ticketEstimate(table, state.size, state.stage);
    if (!estimate) {
      unestimated++;
      continue;
    }
    for (const [agent, spent] of Object.entries(estimate) as [AgentName, { usd: number; tokens: number }][]) {
      if (!billingOf.has(agent)) billingOf.set(agent, getAgent(agent).billing);
      const pool = billingOf.get(agent) === 'api' ? left.api : left.subscription;
      pool.usd += spent.usd;
      pool.tokens += spent.tokens;
    }
  }

  // Subscriptions, in the order launches pick them; paused ones take no work.
  const unsized: string[] = [];
  const unmetered: string[] = [];
  const accounts: DrainWindow[][] = [];
  for (const a of allowance) {
    if (getConnection(a.connectionId)?.paused) continue;
    const windows: DrainWindow[] = [];
    if (a.unknown) unmetered.push(a.connectionName);
    else {
      const sized = (p: typeof a.fiveHour, limit: number, kind: 'five-hour' | 'weekly', length: number, label: string) => {
        const spent = p
          ? (one<{ usd: number | null }>("SELECT SUM(cost_usd) AS usd FROM spend WHERE connection_id = ? AND billing != 'api' AND ts >= ?", a.connectionId, p.resetsAt - length)?.usd ?? 0)
          : 0;
        const w = windowCapacity(p, limit, spent, kind, length);
        if (w) windows.push(w);
        else unsized.push(`${a.connectionName} ${label}`);
      };
      sized(a.fiveHour, a.limits.fiveHour, 'five-hour', FIVE_HOURS, '5-hour');
      sized(a.sevenDay, a.limits.weekly, 'weekly', SEVEN_DAYS, 'weekly');
    }
    if (a.blockedUntil) windows.push({ kind: 'limit', left: 0, perWindow: Infinity, resetsAt: a.blockedUntil, length: Infinity });
    accounts.push(windows);
  }

  const pool = (work: { usd: number; tokens: number }, perHour: number, accts: DrainWindow[][], blocked: BacklogPool['reason'], extra: Pick<BacklogPool, 'unsized' | 'unmetered'>): BacklogPool | null => {
    if (work.usd <= 0 && work.tokens <= 0) return null;
    const base = { usd: work.usd, tokens: work.tokens, perHourUsd: perHour, ...extra };
    const unlimitedAt = perHour > 0 ? Math.round(now + (work.usd / perHour) * 3600_000) : null;
    if (blocked) return { ...base, finishAt: null, unlimitedAt, limitedBy: null, reason: blocked, curve: [] };
    if (perHour <= 0) return { ...base, finishAt: null, unlimitedAt: null, limitedBy: null, reason: 'no-pace', curve: [] };
    const d = drain(work.usd, perHour, accts, now);
    return { ...base, finishAt: d.finishAt, unlimitedAt: d.unlimitedAt, limitedBy: d.limitedBy, reason: d.finishAt === null ? 'beyond' : null, curve: d.curve };
  };
  const subscription = pool(left.subscription, o.subscriptionPerHour, accounts, accounts.length === 0 ? 'no-subscription' : null, { unsized, unmetered });
  const api = pool(left.api, o.apiPerHour, [[o.apiWindow]], o.apiWindow.perWindow <= 0 ? 'api-off' : null, { unsized: [], unmetered: [] });
  const pools = [subscription, api].filter((p) => p !== null);
  return {
    tickets: open.length,
    byStage: STAGE_ORDER.filter((s) => counts.has(s)).map((stage) => ({ stage, count: counts.get(stage)! })),
    unestimated,
    basis: table.all.tickets,
    subscription,
    api,
    finishAt: pools.length && pools.every((p) => p.finishAt !== null) ? Math.max(...pools.map((p) => p.finishAt!)) : null,
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
