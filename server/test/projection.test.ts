import { describe, expect, it } from 'vitest';
import { capAt, costTable, drain, FIVE_HOURS, HORIZON, monthEnd, remainingAgents, SEVEN_DAYS, ticketEstimate, windowCapacity, windowProjection, type DrainWindow } from '../src/projection.ts';

const H = 3600_000;
const T = Date.parse('2026-11-26T12:00:00Z');

describe('windowProjection', () => {
  // A 5-hour window that began 2 hours before the reading: 20% used is 10 points an hour.
  const resetsAt = T + 3 * H;
  const at = (pct: number, opts: { limit?: number; sampledAt?: number | null; now?: number; resets?: number | null } = {}) =>
    windowProjection({ pct, resetsAt: opts.resets === undefined ? resetsAt : opts.resets }, FIVE_HOURS, opts.limit ?? 70, opts.sampledAt === undefined ? T : opts.sampledAt, opts.now ?? T);

  it('reaches the limit before the reset', () => {
    const p = at(20, { limit: 40 })!;
    expect(p.ratePerHour).toBeCloseTo(10);
    expect(p.limitAt).toBe(T + 2 * H);
    expect(p.fullAt).toBeNull(); // 100% would take 8 more hours
    expect(p.over).toBe(false);
  });

  it('resets before reaching the limit', () => {
    expect(at(20, { limit: 70 })).toMatchObject({ limitAt: null, fullAt: null, resetsAt });
  });

  it('is already over the limit', () => {
    expect(at(75, { limit: 70 })).toMatchObject({ limitAt: T, over: true });
  });

  it('is at exactly the limit, which the gate still allows', () => {
    expect(at(70, { limit: 70 })).toMatchObject({ limitAt: T, over: false });
  });

  it('ignores a reading from the previous window', () => {
    expect(at(20, { sampledAt: resetsAt - FIVE_HOURS - 1 })).toBeNull();
  });

  it('ignores a window that has reset since the reading', () => {
    expect(at(20, { now: resetsAt })).toBeNull();
    expect(at(20, { now: resetsAt + H })).toBeNull();
  });

  it('needs a reset time and a reading', () => {
    expect(at(20, { resets: null })).toBeNull();
    expect(at(20, { sampledAt: null })).toBeNull();
    expect(windowProjection(null, FIVE_HOURS, 70, T, T)).toBeNull();
  });

  it('gives no pace in the first 15 minutes', () => {
    const p = windowProjection({ pct: 5, resetsAt: T + FIVE_HOURS - 10 * 60_000 }, FIVE_HOURS, 70, T, T)!;
    expect(p).toMatchObject({ ratePerHour: 0, limitAt: null, fullAt: null });
  });

  it('works for the weekly window', () => {
    // Half a week in, at 50%: 80% comes after 50.4 more hours, and 100% exactly at the reset, which is too late.
    const p = windowProjection({ pct: 50, resetsAt: T + 84 * H }, SEVEN_DAYS, 80, T, T)!;
    expect(p.ratePerHour).toBeCloseTo(50 / 84);
    expect(p.limitAt).toBe(T + Math.round(50.4 * H));
    expect(p.fullAt).toBeNull();
  });
});

describe('capAt', () => {
  const midnight = Date.parse('2026-11-26T00:00:00Z');

  it('reaches the cap today', () => {
    expect(capAt(5, 20, midnight, midnight + 4 * H)).toBe(midnight + 16 * H);
  });

  it("doesn't reach it today", () => {
    expect(capAt(5, 20, midnight, midnight + 8 * H)).toBeNull();
  });

  it('is already over', () => {
    expect(capAt(25, 20, midnight, midnight + 8 * H)).toBe(midnight + 8 * H);
  });

  it('has no projection with a $0 limit, which turns API agents off', () => {
    expect(capAt(0, 0, midnight, midnight + 8 * H)).toBeNull();
  });

  it('needs spend and 15 minutes of pace', () => {
    expect(capAt(0, 20, midnight, midnight + 8 * H)).toBeNull();
    expect(capAt(1, 20, midnight, midnight + 10 * 60_000)).toBeNull();
  });
});

describe('monthEnd', () => {
  it('adds the rest of today and the days left', () => {
    expect(monthEnd(10, 2, '2026-11-26', 0.5)).toBe(10 + 2 * 4.5); // 30 days
    expect(monthEnd(10, 2, '2026-12-01', 0)).toBe(10 + 2 * 31);
    expect(monthEnd(10, 2, '2026-02-14', 0.25)).toBe(10 + 2 * 14.75); // 28 days
  });

  it('on the last day is just the rest of today', () => {
    expect(monthEnd(10, 4, '2026-10-31', 0.75)).toBe(11);
  });
});

describe('remainingAgents', () => {
  it('follows the pipeline from each stage', () => {
    const all = ['classifier', 'design', 'design-review', 'implement', 'code-review', 'merge'];
    expect(remainingAgents(null)).toEqual(all);
    expect(remainingAgents('reclassify')).toEqual(all);
    expect(remainingAgents('design')).toEqual(all.slice(1));
    expect(remainingAgents('design-review')).toEqual(all.slice(2));
    expect(remainingAgents('implement')).toEqual(['implement', 'code-review', 'merge']);
    expect(remainingAgents('code-review')).toEqual(['code-review', 'merge']);
    expect(remainingAgents('merge')).toEqual(['merge']);
    expect(remainingAgents('reconcile')).toEqual(['merge']);
    expect(remainingAgents('pr-review')).toEqual([]);
  });
});

describe('costTable and ticketEstimate', () => {
  // Three finished M tickets; only ticket 1 had a design run.
  const m = [1, 2, 3].flatMap((ticket) => [
    { ticket, size: 'm' as const, agent: 'implement' as const, usd: 6, tokens: 600 },
    { ticket, size: 'm' as const, agent: 'code-review' as const, usd: 3, tokens: 300 },
  ]);
  const rows = [...m, { ticket: 1, size: 'm' as const, agent: 'design' as const, usd: 9, tokens: 900 }, { ticket: 4, size: 'xs' as const, agent: 'implement' as const, usd: 2, tokens: 200 }];
  const table = costTable(rows);

  it('averages over every finished ticket of the size, counting agents a ticket never ran as 0', () => {
    expect(table.m.tickets).toBe(3);
    expect(table.m.byAgent.design).toEqual({ usd: 3, tokens: 300 });
    expect(table.all.tickets).toBe(4);
    expect(table.all.byAgent.implement).toEqual({ usd: 20 / 4, tokens: 2000 / 4 });
  });

  it('sums only the stages a ticket has left', () => {
    expect(ticketEstimate(table, 'm', 'implement')).toEqual({ implement: { usd: 6, tokens: 600 }, 'code-review': { usd: 3, tokens: 300 }, merge: { usd: 0, tokens: 0 } });
  });

  it('uses all sizes for a size with too few tickets, and for unclassified tickets', () => {
    expect(ticketEstimate(table, 'xs', 'implement')!.implement).toEqual(table.all.byAgent.implement);
    expect(ticketEstimate(table, null, null)!.classifier).toEqual({ usd: 0, tokens: 0 });
    expect(ticketEstimate(table, null, null)!.design).toEqual(table.all.byAgent.design);
  });

  it('has no estimate without history', () => {
    expect(ticketEstimate(costTable([]), 'm', 'design')).toBeNull();
  });
});

describe('drain', () => {
  const win = (w: Partial<DrainWindow>): DrainWindow => ({ kind: 'weekly', left: 0, perWindow: 0, resetsAt: T, length: SEVEN_DAYS, ...w });
  const valueAt = (curve: [number, number][], ts: number) => curve.find((p) => p[0] === ts)?.[1];

  it('finishes at the pace alone when nothing limits it', () => {
    const d = drain(10, 2, [[]], T);
    expect(d.finishAt).toBe(T + 5 * H);
    expect(d.unlimitedAt).toBe(d.finishAt);
    expect(d.limitedBy).toBeNull();
    expect(d.curve[0]).toEqual([T, 1]);
    expect(valueAt(d.curve, T + H)).toBeCloseTo(0.8);
    expect(d.curve.at(-1)).toEqual([T + 5 * H, 0]);
  });

  it('waits for a weekly reset, flat in between', () => {
    // $10 of room, $20 of work at $1 an hour, and the window refills in 2 days.
    const d = drain(20, 1, [[win({ left: 10, perWindow: 50, resetsAt: T + 48 * H })]], T);
    expect(d.limitedBy).toBe('weekly');
    expect(d.finishAt).toBe(T + 58 * H);
    expect(d.unlimitedAt).toBe(T + 20 * H);
    expect(valueAt(d.curve, T + 12 * H)).toBeCloseTo(0.5);
    expect(valueAt(d.curve, T + 47 * H)).toBeCloseTo(0.5);
  });

  it('refills a 5-hour window over several cycles', () => {
    // $1 an hour against $2 per 5 hours: $2 every 5 hours, so $6 takes three windows.
    const d = drain(6, 1, [[win({ kind: 'five-hour', left: 2, perWindow: 2, resetsAt: T + 5 * H, length: FIVE_HOURS })]], T);
    expect(d.limitedBy).toBe('five-hour');
    expect(d.finishAt).toBe(T + 12 * H);
  });

  it('moves to the next account when the first is exhausted', () => {
    const d = drain(10, 1, [[win({ left: 4, perWindow: 4, resetsAt: T + 30 * 86400_000 })], []], T);
    expect(d.finishAt).toBe(T + 10 * H);
    expect(d.limitedBy).toBeNull();
  });

  it('opens a blocked subscription when its block ends, without calling it the limit', () => {
    const d = drain(2, 1, [[{ kind: 'limit', left: 0, perWindow: Infinity, resetsAt: T + 3 * H, length: Infinity }]], T);
    expect(d.finishAt).toBe(T + 5 * H);
    expect(d.limitedBy).toBeNull();
  });

  it('gives nulls without a pace or accounts, and past the horizon', () => {
    expect(drain(5, 0, [[]], T)).toEqual({ finishAt: null, unlimitedAt: null, limitedBy: null, curve: [] });
    expect(drain(5, 1, [], T).finishAt).toBeNull();
    const far = drain(5, 1, [[win({ left: 0, perWindow: 0, resetsAt: T + H })]], T);
    expect(far.finishAt).toBeNull();
    expect(far.curve.at(-1)![0]).toBe(T + HORIZON);
  });

  it('is done now with no work', () => {
    expect(drain(0, 1, [[]], T)).toMatchObject({ finishAt: T, curve: [] });
  });
});

describe('windowCapacity', () => {
  const p = { pct: 40, resetsAt: T + H, ratePerHour: 1, limitAt: null, fullAt: null, over: false };

  it('sizes the window from spend per percent, up to your limit', () => {
    // $20 bought 40%, so 1% is $0.50: $15 left to a 70% limit, $35 a window.
    expect(windowCapacity(p, 70, 20, 'weekly', SEVEN_DAYS)).toEqual({ kind: 'weekly', left: 15, perWindow: 35, resetsAt: T + H, length: SEVEN_DAYS });
    expect(windowCapacity({ ...p, pct: 80 }, 70, 20, 'weekly', SEVEN_DAYS)!.left).toBe(0);
  });

  it("can't size a window under 5%, without a reading or without spend", () => {
    expect(windowCapacity({ ...p, pct: 4 }, 70, 20, 'five-hour', FIVE_HOURS)).toBeNull();
    expect(windowCapacity(null, 70, 20, 'five-hour', FIVE_HOURS)).toBeNull();
    expect(windowCapacity(p, 70, 0, 'five-hour', FIVE_HOURS)).toBeNull();
  });
});
