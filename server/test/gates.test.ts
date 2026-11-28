import { describe, expect, it } from 'vitest';
import type { AllowanceView, Limits, Settings } from '../src/api-types.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';
import { allowanceBlock, clockTopics, thresholdBlock, dependencyBlock, inScope, isTransient, modeBlock, priorityAhead, place, poolFor, slotsFor, freeSlot, implicitPriority, waitingCounts, pickSubscription, publishRetryMinutes, pushEnded, pushRefusal, stepPriority, withinHours, type HostLoad } from '../src/scheduler/gates.ts';

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
    unknown: false,
    tokens: { fiveHour: 0, sevenDay: 0 },
    limits: { fiveHour: 70, weekly: 80 },
    burndown: { enabled: false, ceiling: null, target: 97, otherPerHour: 0.15, workshopPerHour: null, duty: null, bound: null, basis: { otherHours: 0, workshopHours: 0 } },
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

  it("uses the subscription's own limits", () => {
    const high = { pct: 74, resetsAt: null };
    expect(allowanceBlock(a({ fiveHour: high, limits: { fiveHour: 80, weekly: 80 } }), s(), now)).toBeNull();
    expect(allowanceBlock(a({ fiveHour: high, limits: { fiveHour: 70, weekly: 80 } }), s(), now)).toMatch(/5-hour allowance at 74%/);
    expect(allowanceBlock(a({ limits: { fiveHour: 70, weekly: 40 } }), s(), now)).toMatch(/Weekly allowance at 50%/);
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

  it("skips your limits for a ticket you let past them, but not Claude's or a stale reading", () => {
    const over = a({ fiveHour: { pct: 95, resetsAt: null }, sevenDay: { pct: 95, resetsAt: null } });
    expect(allowanceBlock(over, s(), now)).toMatch(/5-hour allowance at 95%/);
    expect(allowanceBlock(over, s(), now, true)).toBeNull();
    expect(allowanceBlock(a({ ...over, blockedUntil: now + 60_000 }), s(), now, true)).toMatch(/usage limit/);
    expect(allowanceBlock(undefined, s(), now, true)).toBe('Checking allowance');
    expect(allowanceBlock(a({ ...over, sampledAt: now - 11 * 60_000 }), s(), now, true)).toBe('Checking allowance');
  });

  it('says which window is over the thresholds and when it resets, for pausing running agents', () => {
    const five = { pct: 74, resetsAt: now + 600_000 };
    const week = { pct: 81, resetsAt: now + 86400_000 };
    const L: Limits = { fiveHour: 70, weekly: 80 };
    expect(thresholdBlock({ fiveHour: five, sevenDay: null }, L, s(), now)).toEqual({ reason: expect.stringMatching(/^5-hour allowance at 74%, resets \d\d:\d\d$/), resetsAt: five.resetsAt });
    expect(thresholdBlock({ fiveHour: null, sevenDay: week }, L, s(), now)).toEqual({ reason: expect.stringMatching(/^Weekly allowance at 81%, resets /), resetsAt: week.resetsAt });
    expect(thresholdBlock({ fiveHour: { pct: 70, resetsAt: null }, sevenDay: { pct: 80, resetsAt: null } }, L, s(), now)).toBeNull();
    expect(thresholdBlock({ fiveHour: { pct: 95, resetsAt: now - 1 }, sevenDay: null }, L, s(), now)).toBeNull();
    expect(thresholdBlock({ fiveHour: five, sevenDay: null }, { fiveHour: 80, weekly: 80 }, s(), now)).toBeNull();
  });

  it('stops the weekly window at the lower of the set limit and the burndown, and names the line it hit', () => {
    const L: Limits = { fiveHour: 70, weekly: 80 };
    const w = (pct: number) => ({ fiveHour: null, sevenDay: { pct, resetsAt: now + 86400_000 } });
    expect(thresholdBlock(w(52), L, s(), now, 50)?.reason).toMatch(/^Weekly allowance at 52%, over the burndown ceiling of 50%, resets /);
    expect(thresholdBlock(w(49), L, s(), now, 50)).toBeNull();
    // A burndown above the set limit leaves the set limit in charge.
    expect(thresholdBlock(w(85), L, s(), now, 95)?.reason).toMatch(/^Weekly allowance at 85%, resets /);
    expect(thresholdBlock(w(79), L, s(), now, 95)).toBeNull();
  });

  it('applies the burndown only when it is on, and never to a ticket you let past your limits', () => {
    const on = (ceiling: number | null, enabled = true) => ({ ...a().burndown, enabled, ceiling });
    expect(allowanceBlock(a({ burndown: on(40) }), s(), now)).toMatch(/over the burndown ceiling of 40%/);
    expect(allowanceBlock(a({ burndown: on(40, false) }), s(), now)).toBeNull();
    expect(allowanceBlock(a({ burndown: on(null) }), s(), now)).toBeNull();
    expect(allowanceBlock(a({ burndown: on(40) }), s(), now, true)).toBeNull();
    // A fresh reading from before the weekly reset needs a new one first.
    const lastWeek = { sevenDay: { pct: 90, resetsAt: now - 60_000 } };
    expect(allowanceBlock(a({ ...lastWeek, burndown: on(0.1) }), s(), now)).toBe('Checking allowance');
    expect(allowanceBlock(a({ ...lastWeek, burndown: on(0.1, false) }), s(), now)).toBeNull();
  });
});

describe('scheduling helpers', () => {
  it('picks the healthy host with the most free slots', () => {
    const host = (id: number, slots: number, busy: number, more: Partial<HostLoad> = {}): HostLoad => ({ id, healthy: true, available: true, pools: { standard: { slots, busy, borrowed: 0 } }, ...more });
    expect(place([])).toBeNull();
    expect(place([host(1, 1, 1)])).toBeNull();
    expect(place([host(1, 4, 0, { healthy: false }), host(2, 2, 1)])?.hostId).toBe(2);
    expect(place([host(1, 2, 1), host(2, 3, 0)])?.hostId).toBe(2);
    expect(place([host(1, 4, 0, { available: false })])).toBeNull();
    expect(place([host(1, 4, 0, { available: false }), host(2, 1, 0)])?.hostId).toBe(2);
  });

  const pool = (slots: number, busy: number) => ({ slots, busy, borrowed: 0 });
  const sizedHost = (id: number, small: [number, number], standard: [number, number], large?: [number, number]): HostLoad => ({
    id,
    healthy: true,
    available: true,
    pools: { small: pool(...small), standard: pool(...standard), ...(large && { large: pool(...large) }) },
  });

  it('lists the pools a size may use on a host, its own first and never a smaller one', () => {
    const full = sizedHost(1, [1, 0], [1, 0], [1, 0]);
    const noLarge = sizedHost(2, [1, 0], [1, 0]);
    const plain: HostLoad = { id: 3, healthy: true, available: true, pools: { standard: pool(1, 0) } };
    expect(slotsFor(full, 'small')).toEqual(['small', 'standard', 'large']);
    expect(slotsFor(full, 'standard')).toEqual(['standard', 'large']);
    expect(slotsFor(full, 'large')).toEqual(['large']);
    expect(slotsFor(noLarge, 'small')).toEqual(['small', 'standard']);
    expect(slotsFor(noLarge, 'large')).toEqual(['standard']);
    expect(slotsFor({ pools: { standard: pool(1, 0), large: pool(1, 0) } }, 'small')).toEqual(['standard', 'large']);
    for (const size of ['small', 'standard', 'large'] as const) expect(slotsFor(plain, size)).toEqual(['standard']);

    expect(freeSlot(sizedHost(1, [1, 1], [1, 0], [1, 0]), 'small')).toBe('standard');
    expect(freeSlot(sizedHost(1, [1, 1], [1, 1], [1, 0]), 'small')).toBe('large');
    expect(freeSlot(sizedHost(1, [1, 0], [1, 0], [1, 1]), 'large')).toBeNull();
    expect(freeSlot(sizedHost(1, [1, 0], [1, 0], [1, 0]), 'small')).toBe('small');
  });

  it('lets a size borrow a free larger slot when its own pool is full', () => {
    const sized = sizedHost(1, [3, 1], [2, 2], [1, 1]);
    const plain: HostLoad = { id: 2, healthy: true, available: true, pools: { standard: pool(1, 0) } };
    expect(place([sized], 'small')).toEqual({ hostId: 1, slot: 'small' });
    expect(place([sized], 'standard')).toBeNull();
    expect(place([sized], 'large')).toBeNull();
    // Small borrows standard, then large once standard is full.
    expect(place([sizedHost(1, [1, 1], [1, 0], [1, 0])], 'small')).toEqual({ hostId: 1, slot: 'standard' });
    expect(place([sizedHost(1, [1, 1], [1, 1], [1, 0])], 'small')).toEqual({ hostId: 1, slot: 'large' });
    // Standard borrows large; large never squeezes into a smaller slot.
    expect(place([sizedHost(1, [1, 0], [1, 1], [1, 0])], 'standard')).toEqual({ hostId: 1, slot: 'large' });
    expect(place([sizedHost(1, [1, 0], [1, 0], [1, 1])], 'large')).toBeNull();
    // A host with one pool runs every size in it.
    expect(poolFor(plain, 'large')).toBe(plain.pools.standard);
    for (const size of ['small', 'standard', 'large'] as const) expect(place([plain], size)).toEqual({ hostId: 2, slot: 'standard' });
    expect(place([sized, plain], 'large')).toEqual({ hostId: 2, slot: 'standard' });
    // Its own pool on any host comes before borrowing on any host.
    const borrowable = sizedHost(1, [1, 1], [4, 0], [4, 0]);
    const own = sizedHost(2, [1, 0], [1, 1]);
    expect(place([borrowable, own], 'small')).toEqual({ hostId: 2, slot: 'small' });
    expect(place([borrowable], 'small')).toEqual({ hostId: 1, slot: 'standard' });
  });

  it('leaves a larger slot to a larger ready candidate', () => {
    const h = sizedHost(1, [1, 1], [1, 0], [1, 0]);
    // Standard could borrow large too, so small leaves both to it.
    expect(place([h], 'small', ['standard'])).toBeNull();
    expect(place([h], 'small', ['standard', 'large'])).toBeNull();
    expect(place([sizedHost(1, [1, 1], [1, 0])], 'small', ['standard'])).toBeNull();
    // The waiting candidate itself still gets its own pool.
    expect(place([h], 'standard', ['standard', 'small'])).toEqual({ hostId: 1, slot: 'standard' });
    // A large candidate on a host without a large pool claims standard there.
    expect(place([sizedHost(1, [1, 1], [1, 0])], 'small', ['large'])).toBeNull();
    // A waiting small candidate claims nothing larger.
    expect(place([h], 'small', ['small'])).toEqual({ hostId: 1, slot: 'standard' });
  });

  it('gives a slot two borrowers want to the larger one', () => {
    // Small and standard full, one large slot free; small and standard ready, no large.
    const h = sizedHost(1, [1, 1], [1, 1], [1, 0]);
    const ready = ['small', 'small', 'small', 'standard', 'standard'] as const;
    expect(place([h], 'standard', [...ready])).toEqual({ hostId: 1, slot: 'large' });
    expect(place([h], 'small', [...ready])).toBeNull();
    // Only small ready: it still borrows the large slot.
    expect(place([h], 'small', ['small', 'small'])).toEqual({ hostId: 1, slot: 'large' });
    // Standard and large ready, one large slot free: large gets it.
    const full = sizedHost(1, [1, 0], [1, 1], [1, 0]);
    const mixed = [...Array<'standard'>(5).fill('standard'), 'large', 'large'] as const;
    expect(place([full], 'large', [...mixed])).toEqual({ hostId: 1, slot: 'large' });
    expect(place([full], 'standard', [...mixed])).toBeNull();
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

describe('repository priority', () => {
  it('names strictly higher-priority repos once each, in queue order', () => {
    expect(priorityAhead(0, [])).toEqual([]);
    expect(priorityAhead(1, [{ repo: 'me/api', priority: 1 }, { repo: 'me/web', priority: 0 }])).toEqual([]);
    expect(priorityAhead(0, [{ repo: 'me/web', priority: 2 }, { repo: 'me/api', priority: 1 }, { repo: 'me/web', priority: 2 }, { repo: 'me/app', priority: 0 }])).toEqual(['me/web', 'me/api']);
  });
});

describe('nominated tickets', () => {
  it('works on everything for a whole-backlog repository, and only labelled tickets otherwise', () => {
    expect(inScope('all', [])).toBe(true);
    expect(inScope('nominated', [])).toBe(false);
    expect(inScope('nominated', ['workshop/nominated'])).toBe(true);
  });
});

describe('clock topics', () => {
  const base = { withinHours: true, blocks: '[]', queue: '[]' };
  it('announces nothing on the first tick or when nothing changed', () => {
    expect(clockTopics(null, base)).toEqual([]);
    expect(clockTopics(base, { ...base })).toEqual([]);
  });

  it('names the view each change affects', () => {
    expect(clockTopics(base, { ...base, withinHours: false })).toEqual(['settings']);
    expect(clockTopics(base, { ...base, blocks: '[[1,null]]' })).toEqual(['allowance']);
    expect(clockTopics(base, { ...base, queue: '[[1,"x"]]' })).toEqual(['tickets']);
    expect(clockTopics(base, { withinHours: false, blocks: 'a', queue: 'b' })).toEqual(['settings', 'allowance', 'tickets']);
  });
});

describe('pickSubscription', () => {
  const c = (id: number, block: string | null, failing = false) => ({ id, block, failing });
  it('takes the first one in order that is free', () => {
    expect(pickSubscription([c(1, '5-hour allowance at 99%'), c(2, null), c(3, null)])).toEqual({ id: 2, block: null });
  });
  it('waits on one still being checked rather than skipping it', () => {
    expect(pickSubscription([c(1, 'Checking allowance'), c(2, null)])).toEqual({ id: 1, block: 'Checking allowance' });
  });
  it('skips one whose last check failed', () => {
    expect(pickSubscription([c(1, 'Checking allowance', true), c(2, null)])).toEqual({ id: 2, block: null });
  });
  it("gives the first one's reason when none is free, and nothing for an empty pool", () => {
    expect(pickSubscription([c(1, 'Weekly allowance at 95%'), c(2, 'Checking allowance', true)])).toEqual({ id: 1, block: 'Weekly allowance at 95%' });
    expect(pickSubscription([])).toBeNull();
  });
});

describe('publish retries', () => {
  it('treats GitHub 5xx, 429 and network errors as temporary', () => {
    for (const err of [{ status: 502 }, { status: 500 }, { status: 429 }, { code: 'ECONNRESET' }, { cause: { code: 'EAI_AGAIN' } }, Object.assign(new Error('timed out'), { name: 'TimeoutError' })]) {
      expect(isTransient(err)).toBe(true);
    }
  });

  it('treats a GitHub rate limit as temporary', () => {
    expect(isTransient({ status: 403, response: { headers: { 'x-ratelimit-remaining': '0' } } })).toBe(true);
    expect(isTransient({ status: 403, response: { headers: { 'retry-after': '60' } } })).toBe(true);
  });

  it('treats everything else as a real failure', () => {
    for (const err of [{ status: 422 }, { status: 403 }, new Error('The implementation agent finished without committing any changes.'), 'boom', null]) {
      expect(isTransient(err)).toBe(false);
    }
  });

  it('waits 1, 5 and 15 minutes, then every 30', () => {
    expect([0, 1, 2, 3, 4, 5].map(publishRetryMinutes)).toEqual([1, 5, 15, 30, 30, 30]);
  });
});

describe('implicitPriority', () => {
  const node = (key: string, blockers: string[] = [], prioritised = false) => ({ key, blockers, prioritised });
  const of = (map: Map<string, string[]>) => Object.fromEntries(map);

  it('follows a chain from the prioritised ticket', () => {
    expect(of(implicitPriority([node('r#b', ['r#a'], true), node('r#a', ['r#c']), node('r#c')]))).toEqual({ 'r#a': ['r#b'], 'r#c': ['r#b'] });
  });

  it('reaches each ticket of a diamond once', () => {
    const map = implicitPriority([node('r#d', ['r#b', 'r#c'], true), node('r#b', ['r#a']), node('r#c', ['r#a']), node('r#a')]);
    expect(of(map)).toEqual({ 'r#a': ['r#d'], 'r#b': ['r#d'], 'r#c': ['r#d'] });
  });

  it('ends on a cycle without listing a ticket for itself', () => {
    expect(of(implicitPriority([node('r#a', ['r#b']), node('r#b', ['r#a'], true)]))).toEqual({ 'r#a': ['r#b'] });
  });

  it('skips blockers it does not know', () => {
    expect(of(implicitPriority([node('r#b', ['x#1', 'r#a'], true), node('r#a', ['x#2'])]))).toEqual({ 'r#a': ['r#b'] });
  });

  it('lists every prioritised ticket that waits on a shared blocker, sorted and once', () => {
    const map = implicitPriority([node('r#c', ['r#a', 'r#b'], true), node('r#b', ['r#a'], true), node('r#a')]);
    expect(of(map)).toEqual({ 'r#a': ['r#b', 'r#c'], 'r#b': ['r#c'] });
  });

  it('gives nothing without a prioritised ticket', () => {
    expect(implicitPriority([node('r#b', ['r#a']), node('r#a')]).size).toBe(0);
  });
});

describe('waitingCounts', () => {
  const node = (key: string, blockers: string[] = []) => ({ key, blockers });
  const of = (map: Map<string, number>) => Object.fromEntries(map);

  it('counts a chain transitively', () => {
    // r#a waits on r#b, which waits on r#c.
    expect(of(waitingCounts([node('r#a', ['r#b']), node('r#b', ['r#c']), node('r#c')]))).toEqual({ 'r#c': 2, 'r#b': 1 });
  });

  it('counts each dependent of a diamond once', () => {
    const map = waitingCounts([node('r#d', ['r#b', 'r#c']), node('r#b', ['r#a']), node('r#c', ['r#a']), node('r#a')]);
    expect(of(map)).toEqual({ 'r#a': 3, 'r#b': 1, 'r#c': 1 });
  });

  it('ends on a cycle without counting a ticket for itself', () => {
    expect(of(waitingCounts([node('r#a', ['r#b']), node('r#b', ['r#a']), node('r#c', ['r#c'])]))).toEqual({ 'r#a': 1, 'r#b': 1 });
  });

  it('skips blockers it does not know', () => {
    expect(of(waitingCounts([node('r#b', ['x#1', 'r#a']), node('r#a', ['x#2'])]))).toEqual({ 'r#a': 1 });
  });

  it('counts across repositories', () => {
    expect(of(waitingCounts([node('r/app#1', ['x/lib#5']), node('r/app#2', ['x/lib#5', 'x/lib#5']), node('x/lib#5')]))).toEqual({ 'x/lib#5': 2 });
  });

  it('gives nothing without links', () => {
    expect(waitingCounts([node('r#a'), node('r#b')]).size).toBe(0);
  });
});
