import type { SpendSeries, SpendTotals, UsageRange } from '../../server/src/api-types.ts';

/** Pure helpers for the Usage page's charts. */

export type Metric = 'cost' | 'tokens';
export type Grouping = 'billing' | 'model' | 'project' | 'connection';

export const RANGES: { value: UsageRange; label: string }[] = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: 'all', label: 'All time' },
];
export const GROUPINGS: { value: Grouping; label: string }[] = [
  { value: 'billing', label: 'Billing' },
  { value: 'model', label: 'Model' },
  { value: 'project', label: 'Project' },
  { value: 'connection', label: 'Connection' },
];
export const METRICS: { value: Metric; label: string }[] = [
  { value: 'cost', label: 'Cost' },
  { value: 'tokens', label: 'Tokens' },
];

export const value = (t: SpendTotals, metric: Metric) => (metric === 'cost' ? t.costUsd : t.inputTokens + t.outputTokens);

/** Round tick values from 0 that cover `max`, in steps of 1, 2 or 5 × 10ⁿ, and at least `minStep` (a cent, for money). */
export function niceTicks(max: number, count = 4, minStep = 0): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = Math.max(max / count, minStep);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw * (1 - 1e-9))!;
  const n = Math.ceil(max / step - 1e-9);
  return Array.from({ length: n + 1 }, (_, i) => Number((i * step).toPrecision(12)));
}

const add = (a: SpendTotals, b: SpendTotals): SpendTotals => ({
  runs: a.runs + b.runs,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  costUsd: a.costUsd + b.costUsd,
});

/**
 * The biggest `n` series by the metric, with the rest summed into Other. Series with nothing in the range are dropped,
 * and Other never holds a single group: with `n + 1` series, all are kept.
 */
export function foldSeries(series: SpendSeries[], metric: Metric, n = 4): SpendSeries[] {
  const kept = series.filter((s) => value(s.totals, metric) > 0);
  // The server sorts by cost; tokens need their own order.
  if (metric === 'tokens') kept.sort((a, b) => value(b.totals, metric) - value(a.totals, metric));
  if (kept.length <= n + 1) return kept;
  const rest = kept.slice(n);
  const other: SpendSeries = {
    key: 'other',
    name: 'Other',
    points: rest[0].points.map((_, i) => rest.reduce((t, s) => add(t, s.points[i]), { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 })),
    totals: rest.reduce((t, s) => add(t, s.totals), { runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 }),
  };
  return [...kept.slice(0, n), other];
}

/** '26 Nov' for a 'YYYY-MM-DD' day, 'Nov 2026' for a 'YYYY-MM' month, in the reader's locale. */
export function bucketLabel(key: string, bucket: 'day' | 'month', locale?: string): string {
  const date = new Date(`${bucket === 'day' ? key : `${key}-01`}T00:00:00Z`);
  return date.toLocaleDateString(locale, bucket === 'day' ? { day: 'numeric', month: 'short', timeZone: 'UTC' } : { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const pick = <T extends string>(raw: string | null, options: { value: T }[], fallback: T): T => options.find((o) => o.value === raw)?.value ?? fallback;

/** The Usage page's filters from its URL, with defaults for missing or unknown values. */
export function readFilters(params: URLSearchParams): { range: UsageRange; group: Grouping; metric: Metric } {
  return {
    range: pick(params.get('range'), RANGES, '30d'),
    group: pick(params.get('group'), GROUPINGS, 'billing'),
    metric: pick(params.get('show'), METRICS, 'cost'),
  };
}

/** Moves label positions apart, downwards, so that no two are closer than `minGap`. Keeps the input order. */
export function spreadLabels(ys: number[], minGap = 14): number[] {
  const order = ys.map((y, i) => ({ y, i })).sort((a, b) => a.y - b.y);
  const out = [...ys];
  let last = -Infinity;
  for (const { y, i } of order) {
    out[i] = Math.max(y, last + minGap);
    last = out[i];
  }
  return out;
}

/** Each series' total by the metric and its share of the sum, biggest first, without the empty ones. */
export function shares(series: SpendSeries[], metric: Metric): { key: string; name: string; value: number; share: number }[] {
  const rows = series.map((s) => ({ key: s.key, name: s.name, value: value(s.totals, metric) })).filter((r) => r.value > 0);
  const sum = rows.reduce((n, r) => n + r.value, 0);
  return rows.map((r) => ({ ...r, share: r.value / sum })).sort((a, b) => b.value - a.value);
}

/** '42%', or '<1%' for a share that would round to nothing. */
export const percent = (share: number) => (share > 0 && share < 0.005 ? '<1%' : `${Math.round(share * 100)}%`);
