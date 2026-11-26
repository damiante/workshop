import { describe, expect, it } from 'vitest';
import type { SpendSeries, SpendTotals } from '../../server/src/api-types.ts';
import { bucketLabel, foldSeries, niceTicks, readFilters, spreadLabels } from '../src/chart.ts';

const t = (costUsd: number, tokens = 0, runs = 1): SpendTotals => ({ runs, inputTokens: tokens, outputTokens: 0, costUsd });
const s = (key: string, cost: number, tokens = 0): SpendSeries => ({ key, name: key, points: [t(cost / 2, tokens / 2), t(cost / 2, tokens / 2)], totals: t(cost, tokens) });

describe('niceTicks', () => {
  it('gives round steps from 0 that cover the maximum', () => {
    expect(niceTicks(0)).toEqual([0, 1]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(1234)).toEqual([0, 500, 1000, 1500]);
    expect(niceTicks(0.37)).toEqual([0, 0.1, 0.2, 0.3, 0.4]);
    expect(niceTicks(8)).toEqual([0, 2, 4, 6, 8]);
  });
});

describe('foldSeries', () => {
  it('keeps fewer than n series as they are', () => {
    expect(foldSeries([s('a', 3), s('b', 2)], 'cost').map((x) => x.key)).toEqual(['a', 'b']);
  });

  it('keeps n + 1 series rather than fold one into Other', () => {
    expect(foldSeries([s('a', 5), s('b', 4), s('c', 3), s('d', 2), s('e', 1)], 'cost').map((x) => x.key)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('sums the rest into Other, points and totals', () => {
    const out = foldSeries([s('a', 6), s('b', 5), s('c', 4), s('d', 3), s('e', 2), s('f', 1)], 'cost');
    expect(out.map((x) => x.key)).toEqual(['a', 'b', 'c', 'd', 'other']);
    expect(out[4].name).toBe('Other');
    expect(out[4].totals).toEqual({ runs: 2, inputTokens: 0, outputTokens: 0, costUsd: 3 });
    expect(out[4].points.map((p) => p.costUsd)).toEqual([1.5, 1.5]);
  });

  it('drops series with nothing in the range', () => {
    expect(foldSeries([s('a', 3), s('zero', 0)], 'cost').map((x) => x.key)).toEqual(['a']);
  });

  it('orders by tokens when showing tokens', () => {
    expect(foldSeries([s('a', 3, 10), s('b', 2, 50)], 'tokens').map((x) => x.key)).toEqual(['b', 'a']);
  });
});

describe('bucketLabel', () => {
  it('labels days and months whatever the local time zone', () => {
    expect(bucketLabel('2026-11-26', 'day', 'en-GB')).toBe('26 Nov');
    expect(bucketLabel('2026-11', 'month', 'en-GB')).toBe('Nov 2026');
    expect(bucketLabel('2026-01-01', 'day', 'en-GB')).toBe('1 Jan');
  });
});

describe('readFilters', () => {
  it('reads the filters', () => {
    expect(readFilters(new URLSearchParams('range=7d&group=model&show=tokens'))).toEqual({ range: '7d', group: 'model', metric: 'tokens' });
  });

  it('falls back for missing and unknown values', () => {
    expect(readFilters(new URLSearchParams(''))).toEqual({ range: '30d', group: 'billing', metric: 'cost' });
    expect(readFilters(new URLSearchParams('range=1y&group=x&show=y'))).toEqual({ range: '30d', group: 'billing', metric: 'cost' });
  });
});

describe('spreadLabels', () => {
  it('pushes close labels apart and leaves far ones alone', () => {
    expect(spreadLabels([50, 40])).toEqual([54, 40]);
    expect(spreadLabels([10, 100])).toEqual([10, 100]);
    expect(spreadLabels([20, 20, 20], 10)).toEqual([20, 30, 40]);
  });
});
