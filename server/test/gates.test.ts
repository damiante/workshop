import { describe, expect, it } from 'vitest';
import type { AllowanceView, Settings } from '../src/api-types.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { allowanceBlock, dependencyBlock, modeBlock, pickHost, pushEnded, pushRefusal, stepPriority, withinHours } from '../src/scheduler/gates.ts';

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
    expect(pickHost([{ id: 1, healthy: true, available: true, slots: 1, busy: 1 }])).toBeNull();
    expect(pickHost([{ id: 1, healthy: false, available: true, slots: 4, busy: 0 }, { id: 2, healthy: true, available: true, slots: 2, busy: 1 }])).toBe(2);
    expect(pickHost([{ id: 1, healthy: true, available: true, slots: 2, busy: 1 }, { id: 2, healthy: true, available: true, slots: 3, busy: 0 }])).toBe(2);
    expect(pickHost([{ id: 1, healthy: true, available: false, slots: 4, busy: 0 }])).toBeNull();
    expect(pickHost([{ id: 1, healthy: true, available: false, slots: 4, busy: 0 }, { id: 2, healthy: true, available: true, slots: 1, busy: 0 }])).toBe(2);
  });

  it('finishes work in flight first', () => {
    expect(stepPriority({ kind: 'merge' })).toBeLessThan(stepPriority({ kind: 'agent', agent: 'implement', mode: 'normal' }));
    expect(stepPriority({ kind: 'agent', agent: 'implement', mode: 'normal' })).toBeLessThan(stepPriority({ kind: 'agent', agent: 'design', mode: 'normal' }));
    expect(stepPriority({ kind: 'agent', agent: 'design', mode: 'normal' })).toBeLessThan(stepPriority({ kind: 'agent', agent: 'classifier', mode: 'normal' }));
  });
});

describe('dependency gate', () => {
  it('holds a ticket while it has open blockers, and releases it when none are left', () => {
    expect(dependencyBlock(['#2'])).toBe('Depends on #2');
    expect(dependencyBlock(['#2', 'other/repo#5'])).toBe('Depends on #2 and other/repo#5');
    expect(dependencyBlock(['#2', '#5', '#7'])).toBe('Depends on #2, #5 and #7');
    expect(dependencyBlock([])).toBeNull();
  });
});

describe('hand pushes', () => {
  const l = (...names: string[]) => names;
  it('a stage push ends when the stage changes, not before', () => {
    expect(pushEnded('stage', 'new', [], true)).toBe(false);
    expect(pushEnded('stage', 'new', l('workshop/size:m', 'workshop/stage:design'), true)).toBe(true);
    expect(pushEnded('stage', 'design', l('workshop/stage:design'), true)).toBe(false);
    expect(pushEnded('stage', 'design', l('workshop/stage:implement'), true)).toBe(true);
    expect(pushEnded('stage', 'reclassify', l('workshop/stage:implement'), true)).toBe(true);
  });

  it('a lifecycle push carries on through stage changes', () => {
    expect(pushEnded('lifecycle', 'new', l('workshop/stage:design'), true)).toBe(false);
    expect(pushEnded('lifecycle', 'design', l('workshop/stage:implement'), true)).toBe(false);
    expect(pushEnded('lifecycle', 'implement', l('workshop/stage:merge'), true)).toBe(false);
  });

  it.each(['stage', 'lifecycle'] as const)('a %s push ends where Workshop waits for you', (push) => {
    expect(pushEnded(push, 'implement', l('workshop/stage:pr-review'), true)).toBe(true);
    expect(pushEnded(push, 'implement', l('workshop/stage:implement', 'workshop/needs-info'), true)).toBe(true);
    expect(pushEnded(push, 'implement', l('workshop/stage:implement', 'workshop/failed'), true)).toBe(true);
    expect(pushEnded(push, 'implement', l('workshop/stage:implement', 'workshop/skip'), true)).toBe(true);
    expect(pushEnded(push, 'implement', l('workshop/stage:implement'), false)).toBe(true);
  });

  it('refuses pushes that could not do anything', () => {
    const ok = { labels: l('workshop/stage:implement'), open: true, running: false };
    expect(pushRefusal(ok, 'stage')).toBeNull();
    expect(pushRefusal({ ...ok, labels: [] }, 'lifecycle')).toBeNull();
    expect(pushRefusal({ ...ok, open: false }, 'stage')).toBe('This ticket is closed.');
    expect(pushRefusal({ ...ok, labels: l('workshop/failed') }, 'stage')).toMatch(/workshop\/failed/);
    expect(pushRefusal({ ...ok, labels: l('workshop/skip') }, 'stage')).toMatch(/skipped/);
    expect(pushRefusal({ ...ok, labels: l('workshop/needs-info') }, 'stage')).toMatch(/asked a question/);
    expect(pushRefusal({ ...ok, labels: l('workshop/stage:pr-review') }, 'lifecycle')).toMatch(/waiting for your review/);
  });

  it('allows a lifecycle push while an agent works, but not a stage push', () => {
    const running = { labels: l('workshop/stage:implement'), open: true, running: true };
    expect(pushRefusal(running, 'lifecycle')).toBeNull();
    expect(pushRefusal(running, 'stage')).toBe('An agent is already working on this stage.');
  });
});
