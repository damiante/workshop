import type { LifetimeSpend, SpendTotals } from './api-types.ts';
import { all, run } from './db.ts';
import type { RunRow } from './runs.ts';

/** Adds one `claude` invocation's result to the ledger and to the run's own totals (a resumed run sums its invocations). */
export function recordSpend(r: RunRow, res: { inputTokens?: number; outputTokens?: number; costUsd?: number }) {
  const input = res.inputTokens ?? 0;
  const output = res.outputTokens ?? 0;
  const cost = res.costUsd ?? 0;
  run('INSERT INTO spend (run_id, ts, model, billing, input_tokens, output_tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)', r.id, Date.now(), r.model, r.billing, input, output, cost);
  run(
    'UPDATE runs SET input_tokens = COALESCE(input_tokens, 0) + ?, output_tokens = COALESCE(output_tokens, 0) + ?, cost_usd = COALESCE(cost_usd, 0) + ? WHERE id = ?',
    input,
    output,
    cost,
    r.id,
  );
}

const zero = (): SpendTotals => ({ runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });

export function lifetimeSpend(timeZone: string): LifetimeSpend {
  const rows = all<{ run_id: string; ts: number; model: string; billing: string; input_tokens: number; output_tokens: number; cost_usd: number }>('SELECT * FROM spend ORDER BY ts, id');
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' });
  const total = zero();
  const byBilling = { subscription: zero(), api: zero() };
  const models = new Map<string, SpendTotals>();
  const months = new Map<string, SpendTotals>();
  // Distinct run ids per bucket, so a resumed run counts once.
  const seen = new Map<SpendTotals, Set<string>>();
  const add = (t: SpendTotals, row: (typeof rows)[number]) => {
    let ids = seen.get(t);
    if (!ids) seen.set(t, (ids = new Set()));
    if (!ids.has(row.run_id)) {
      ids.add(row.run_id);
      t.runs++;
    }
    t.inputTokens += row.input_tokens;
    t.outputTokens += row.output_tokens;
    t.costUsd += row.cost_usd;
  };
  const bucket = (m: Map<string, SpendTotals>, key: string) => m.get(key) ?? (m.set(key, zero()), m.get(key)!);
  for (const row of rows) {
    add(total, row);
    add(row.billing === 'api' ? byBilling.api : byBilling.subscription, row);
    add(bucket(models, row.model), row);
    add(bucket(months, fmt.format(row.ts).slice(0, 7)), row);
  }
  return {
    since: rows[0]?.ts ?? null,
    total,
    subscription: byBilling.subscription,
    api: byBilling.api,
    byModel: [...models].map(([model, t]) => ({ model, ...t })).sort((a, b) => b.costUsd - a.costUsd),
    byMonth: [...months].map(([month, t]) => ({ month, ...t })).sort((a, b) => b.month.localeCompare(a.month)),
  };
}
