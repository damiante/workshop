import { describe, expect, it } from 'vitest';
import type { Settings } from '../src/api-types.ts';
import { allowedHours, burndownCeiling, burndownLine, heldHours, learnRates, nextMargin, PRIOR_OTHER_PER_HOUR, weeklyTarget, type Rates, type Reading } from '../src/burndown.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';

const H = 3600_000;
const s = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, mode: 'always', timezone: 'Australia/Melbourne', ...over });
// Tuesday 2026-10-13, 00:00 in Melbourne (UTC+11).
const now = Date.parse('2026-10-13T00:00:00+11:00');
const none: Rates = { otherPerHour: PRIOR_OTHER_PER_HOUR, workshopPerHour: null, fivePerHour: null, otherHours: 0, workshopHours: 0 };
const line = (hoursLeft: number, rates: Rates = none, settings = s(), margin = 3) =>
  burndownCeiling({ now, resetsAt: now + hoursLeft * H, margin, rates, fiveHourLimit: 70, settings });

describe('burndownCeiling', () => {
  it('rises from 0 at the start of the week to the target at the reset', () => {
    expect(line(168)).toMatchObject({ ceiling: 0, bound: 'linear', target: 97 });
    expect(line(84).ceiling).toBeCloseTo(48.5);
    expect(line(1 / 60).ceiling).toBeCloseTo(97, 1);
    expect(line(84, none, s(), 5).target).toBe(95);
  });

  it('rises monotonically for fixed rates', () => {
    const rates: Rates = { ...none, otherPerHour: 0.2, workshopPerHour: 1, fivePerHour: 10 };
    let last = -1;
    for (let h = 168; h >= 1; h -= 3) {
      const c = line(h, rates, s({ mode: 'scheduled', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' })).ceiling!;
      expect(c).toBeGreaterThanOrEqual(last - 1e-9);
      last = c;
    }
  });

  it('starts a week whose reset has just passed near 0, not with no line', () => {
    const b = burndownCeiling({ now, resetsAt: now - 5 * 60_000, margin: 3, rates: none, fiveHourLimit: 70, settings: s() });
    expect(b.ceiling).not.toBeNull();
    expect(b.ceiling!).toBeLessThan(0.1);
    expect(burndownCeiling({ now, resetsAt: null, margin: 3, rates: none, fiveHourLimit: 70, settings: s() })).toMatchObject({ ceiling: null, bound: null });
  });

  it('raises the line to catch up when the hours left or the 5-hour limit would not let agents reach the target', () => {
    const rates: Rates = { ...none, otherPerHour: 0.05, workshopPerHour: 1, fivePerHour: 10 };
    // Running at all hours, the agents catch up easily: the even line stands.
    expect(line(84, rates)).toMatchObject({ bound: 'linear' });
    // Weekdays 9 to 5 only: far fewer hours to work in.
    const office = line(84, rates, s({ mode: 'scheduled', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }));
    expect(office.bound).toBe('catchUp');
    expect(office.ceiling!).toBeGreaterThan(60);
    // A 5-hour limit that holds agents most of the time.
    const held = line(84, { ...rates, fivePerHour: 70 });
    expect(held.duty).toBeCloseTo(0.2);
    expect(held.bound).toBe('catchUp');
    expect(held.ceiling!).toBeCloseTo(97 - 0.05 * 84 - 0.75 * 0.2 * 84);
  });

  it('ignores catching up until the agents have been measured', () => {
    expect(line(84, { ...none, otherPerHour: 0.05 }, s({ mode: 'scheduled', days: [] })).bound).toBe('linear');
  });

  it('holds the line down for heavy own use', () => {
    const b = line(84, { ...none, otherPerHour: 0.5 });
    expect(b.bound).toBe('userCap');
    expect(b.ceiling!).toBeCloseTo(97 - 1.5 * 0.5 * 84);
    expect(line(160, { ...none, otherPerHour: 2 }).ceiling).toBe(0);
  });

  it('never goes over the target', () => {
    const b = line(84, { ...none, otherPerHour: 0, workshopPerHour: 0, fivePerHour: 0 });
    expect(b).toMatchObject({ ceiling: 97, bound: 'target' });
  });
});

describe('burndownLine and weeklyTarget', () => {
  it('gives the line only when on, with the grace for running agents', () => {
    expect(burndownLine({ enabled: true, ceiling: 40 })).toBe(40);
    expect(burndownLine({ enabled: true, ceiling: 40 }, true)).toBe(42);
    expect(burndownLine({ enabled: false, ceiling: 40 })).toBeNull();
    expect(burndownLine({ enabled: true, ceiling: null })).toBeNull();
    expect(weeklyTarget(100, { enabled: true, target: 97 })).toBe(97);
    expect(weeklyTarget(80, { enabled: true, target: 97 })).toBe(80);
    expect(weeklyTarget(100, { enabled: false, target: 97 })).toBe(100);
  });
});

describe('learnRates', () => {
  const R = (h: number, week: number | null, active: number | null, more: Partial<Reading> = {}): Reading => ({
    ts: now + h * H,
    five: null,
    fiveResets: null,
    week,
    weekResets: now + 100 * H,
    active,
    ...more,
  });

  it('lets the prior dominate with little data', () => {
    const r = learnRates([R(0, 10, 0), R(1, 12, 0)]);
    expect(r.otherPerHour).toBeCloseTo((0.15 * 24 + 2) / 25);
    expect(r.otherHours).toBe(1);
    expect(learnRates([]).otherPerHour).toBe(PRIOR_OTHER_PER_HOUR);
  });

  it('learns your own use from idle pairs and the agents’ from busy ones', () => {
    const idle = Array.from({ length: 49 }, (_, i) => R(i, 10 + i * 0.1, 0));
    const busy = Array.from({ length: 5 }, (_, i) => R(60 + i, 20 + i * 1.1, 2, { five: 10 + i * 8, fiveResets: now + 63 * H }));
    const r = learnRates([...idle, ...busy]);
    expect(r.otherPerHour).toBeCloseTo((0.15 * 24 + 4.8) / 72);
    expect(r.workshopHours).toBe(4);
    expect(r.workshopPerHour!).toBeCloseTo(1.1 - r.otherPerHour);
    expect(r.fivePerHour).toBeCloseTo(8);
  });

  it('skips mixed, unknown, far-apart, falling and cross-reset pairs', () => {
    const r = learnRates([
      R(0, 10, 0),
      R(1, 15, 1), // mixed
      R(2, 16, null), // unknown
      R(3, 17, 0),
      R(6, 20, 0), // 3 hours apart
      R(7, 19, 0), // falls
      R(8, 0, 0, { weekResets: now + 268 * H }), // a new week
      R(9, 30, 0, { weekResets: now + 100 * H }), // and back across the reset
    ]);
    expect(r.otherHours).toBe(0);
    expect(r.otherPerHour).toBe(PRIOR_OTHER_PER_HOUR);
  });

  it('takes the 5-hour rate only from pairs in the same 5-hour window, and waits for 2 hours of it', () => {
    const busy = [
      R(0, 10, 1, { five: 10, fiveResets: now + 2 * H }),
      R(1, 11, 1, { five: 30, fiveResets: now + 2 * H }),
      R(2, 12, 1, { five: 5, fiveResets: now + 7 * H }), // new 5-hour window
      R(3, 13, 1, { five: 25, fiveResets: now + 7 * H }),
    ];
    const r = learnRates(busy);
    expect(r.fivePerHour).toBeCloseTo(20);
    expect(learnRates(busy.slice(0, 2)).fivePerHour).toBeNull();
    expect(learnRates(busy.slice(0, 2)).workshopPerHour).toBeNull();
  });
});

describe('allowedHours', () => {
  it('counts every hour when always on or paused', () => {
    expect(allowedHours(now, now + 10 * H, s())).toBe(10);
    expect(allowedHours(now, now + 10 * H, s({ mode: 'paused' }))).toBe(10);
    expect(allowedHours(now, now - H, s())).toBe(0);
  });

  it('counts operating hours in scheduled mode, including overnight spans', () => {
    expect(allowedHours(now, now + 168 * H, s({ mode: 'scheduled', days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }))).toBe(40);
    expect(allowedHours(now, now + 24 * H, s({ mode: 'scheduled', start: '22:00', end: '06:00' }))).toBe(8);
  });

  it('follows daylight saving through the time zone', () => {
    // Melbourne's clocks go forward on Sunday 2026-10-04: that Sunday has 23 hours.
    const sunday = Date.parse('2026-10-04T00:00:00+10:00');
    expect(allowedHours(sunday, sunday + 30 * H, s({ mode: 'scheduled', days: [0] }))).toBe(23);
  });
});

describe('nextMargin', () => {
  const week = (over: Partial<Parameters<typeof nextMargin>[1]> = {}) => ({ enabled: true, finalPct: 95, blocked: false, heldHours: 0, ...over });

  it('widens after an overshoot, up to 10', () => {
    expect(nextMargin(3, week({ finalPct: 100 }))).toBe(5);
    expect(nextMargin(3, week({ blocked: true }))).toBe(5);
    expect(nextMargin(9, week({ finalPct: 101 }))).toBe(10);
  });

  it('narrows after a week held back that still ended low, down to 1', () => {
    expect(nextMargin(3, week({ heldHours: 6, finalPct: 90 }))).toBe(2);
    expect(nextMargin(1, week({ heldHours: 20, finalPct: 50 }))).toBe(1);
    expect(nextMargin(3, week({ heldHours: 5, finalPct: 90 }))).toBe(3);
    expect(nextMargin(3, week({ heldHours: 10, finalPct: 95 }))).toBe(3);
  });

  it('leaves weeks with the burndown off alone', () => {
    expect(nextMargin(3, week({ enabled: false, finalPct: 100 }))).toBe(3);
  });
});

describe('heldHours', () => {
  it('counts only spans with the burndown on and usage at its line', () => {
    const r = (h: number, week: number, ceiling: number, burndown: number | null) => ({ ts: now + h * H, week, ceiling, burndown });
    expect(heldHours([r(0, 50, 50, 1), r(1, 50, 51, 1), r(2, 52, 52, 0), r(3, 51, 52, 1), r(4, 53, 53, null), r(5, 54, 53, 1)])).toBe(1);
    expect(heldHours([r(0, 50, 50, 1), r(10, 50, 50, 1)])).toBe(2); // a long gap counts at most 2 hours
  });
});
