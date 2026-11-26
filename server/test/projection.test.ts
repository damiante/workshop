import { describe, expect, it } from 'vitest';
import { capAt, FIVE_HOURS, monthEnd, SEVEN_DAYS, windowProjection } from '../src/projection.ts';

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
