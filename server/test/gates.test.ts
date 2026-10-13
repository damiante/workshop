import { describe, expect, it } from 'vitest';
import type { AllowanceView, Settings } from '../src/api-types.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { allowanceBlock, modeBlock, pickHost, stepPriority, withinHours } from '../src/scheduler/gates.ts';

const s = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, timezone: 'Australia/Melbourne', ...over });
// 2026-10-13 is a Tuesday. Melbourne is UTC+11 (daylight time) on that date.
const melb = (hhmm: string, day = 13) => new Date(`2026-10-${day}T${hhmm}:00+11:00`);

describe('operating hours', () => {
  it('treats start === end as all day on the chosen days', () => {
    expect(withinHours(s(), melb('03:00'))).toBe(true);
    expect(withinHours(s({ days: [1] }), melb('03:00'))).toBe(false);
  });

  it('handles a daytime window', () => {
    const day = s({ start: '09:00', end: '17:00' });
    expect(withinHours(day, melb('08:59'))).toBe(false);
    expect(withinHours(day, melb('09:00'))).toBe(true);
    expect(withinHours(day, melb('17:00'))).toBe(false);
  });

  it('handles an overnight window belonging to the day it starts', () => {
    const nights = s({ start: '22:00', end: '07:00', days: [1] }); // Monday nights only
    expect(withinHours(nights, melb('23:00', 12))).toBe(true); // Mon 23:00
    expect(withinHours(nights, melb('06:59', 13))).toBe(true); // Tue 06:59, still Monday's window
    expect(withinHours(nights, melb('23:00', 13))).toBe(false); // Tue 23:00
  });

  it('uses the configured timezone, including across DST', () => {
    const day = s({ start: '09:00', end: '17:00' });
    expect(withinHours(day, new Date('2026-10-13T00:30:00Z'))).toBe(true); // 11:30 in Melbourne
    expect(withinHours({ ...day, timezone: 'UTC' }, new Date('2026-10-13T00:30:00Z'))).toBe(false);
    // 2026-04-05 Melbourne leaves DST (UTC+10): 23:30Z is 09:30 local on the 6th.
    expect(withinHours(day, new Date('2026-04-05T23:30:00Z'))).toBe(true);
  });

  it('paused blocks, always ignores hours', () => {
    expect(modeBlock(s({ mode: 'paused' }), melb('12:00'))).toMatch(/paused/);
    expect(modeBlock(s({ mode: 'scheduled', start: '01:00', end: '02:00' }), melb('12:00'))).toMatch(/hours/);
    expect(modeBlock(s({ mode: 'always', start: '01:00', end: '02:00' }), melb('12:00'))).toBeNull();
  });
});

describe('allowance gate', () => {
  const now = Date.parse('2026-10-13T01:00:00Z');
  const a = (over: Partial<AllowanceView> = {}): AllowanceView => ({
    connectionId: 1,
    connectionName: 'Claude',
    fiveHour: { pct: 40, resetsAt: now + 3600_000 },
    sevenDay: { pct: 50, resetsAt: now + 86400_000 },
    sampledAt: now - 60_000,
    blockedUntil: null,
    ...over,
  });

  it('passes under both thresholds', () => {
    expect(allowanceBlock(a(), s(), now)).toBeNull();
  });

  it('blocks over the 5-hour or weekly threshold (strictly greater)', () => {
    expect(allowanceBlock(a({ fiveHour: { pct: 70, resetsAt: null } }), s(), now)).toBeNull();
    expect(allowanceBlock(a({ fiveHour: { pct: 74, resetsAt: now + 600_000 } }), s(), now)).toMatch(/^5-hour allowance at 74%, resets \d\d:\d\d$/);
    expect(allowanceBlock(a({ sevenDay: { pct: 81, resetsAt: null } }), s(), now)).toMatch(/Weekly allowance at 81%/);
  });

  it('ignores a window whose reset has passed', () => {
    expect(allowanceBlock(a({ fiveHour: { pct: 95, resetsAt: now - 1 } }), s(), now)).toBeNull();
  });

  it('fails closed on a missing or stale reading', () => {
    expect(allowanceBlock(undefined, s(), now)).toBe('Checking allowance');
    expect(allowanceBlock(a({ sampledAt: now - 11 * 60_000 }), s(), now)).toBe('Checking allowance');
  });

  it('honours a limit Claude reported mid-run', () => {
    expect(allowanceBlock(a({ blockedUntil: now + 60_000 }), s(), now)).toMatch(/usage limit/);
  });
});

describe('scheduling helpers', () => {
  it('picks the healthy host with the most free slots', () => {
    expect(pickHost([])).toBeNull();
    expect(pickHost([{ id: 1, healthy: true, slots: 1, busy: 1 }])).toBeNull();
    expect(pickHost([{ id: 1, healthy: false, slots: 4, busy: 0 }, { id: 2, healthy: true, slots: 2, busy: 1 }])).toBe(2);
    expect(pickHost([{ id: 1, healthy: true, slots: 2, busy: 1 }, { id: 2, healthy: true, slots: 3, busy: 0 }])).toBe(2);
  });

  it('finishes work in flight first', () => {
    expect(stepPriority({ kind: 'merge' })).toBeLessThan(stepPriority({ kind: 'agent', agent: 'implement', mode: 'normal' }));
    expect(stepPriority({ kind: 'agent', agent: 'implement', mode: 'normal' })).toBeLessThan(stepPriority({ kind: 'agent', agent: 'design', mode: 'normal' }));
    expect(stepPriority({ kind: 'agent', agent: 'design', mode: 'normal' })).toBeLessThan(stepPriority({ kind: 'agent', agent: 'classifier', mode: 'normal' }));
  });
});
