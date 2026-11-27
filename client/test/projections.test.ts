import { describe, expect, it } from 'vitest';
import type { AllowanceHistory, BacklogPool, BacklogProjection, BurnRate, UsageHistory, WindowProjection } from '../../server/src/api-types.ts';
import { projectionSections } from '../src/projections.ts';

const H = 3600_000;
const now = Date.parse('2026-11-26T12:00:00Z');
const time = (ms: number) => `T${(ms - now) / 60_000}`; // minutes from now

const noBurn = (): BurnRate => ({ fiveHours: { usd: 0, tokens: 0 }, day: { usd: 0, tokens: 0 }, perDay: { usd: 0, tokens: 0 } });
const emptyBacklog = (): BacklogProjection => ({ tickets: 0, byStage: [], unestimated: 0, basis: 0, subscription: null, api: null, finishAt: null });
const win = (p: Partial<WindowProjection>): WindowProjection => ({ pct: 40, resetsAt: now + 3 * H, ratePerHour: 10, limitAt: null, fullAt: null, over: false, ...p });
const sub = (a: Partial<AllowanceHistory>): AllowanceHistory => ({
  connectionId: 1,
  connectionName: 'Claude-1',
  limits: { fiveHour: 70, weekly: 80 },
  samples: [],
  sampledAt: now,
  blockedUntil: null,
  unknown: false,
  fiveHour: null,
  sevenDay: null,
  burn: noBurn(),
  ...a,
});
const projection = (
  api: Partial<UsageHistory['projection']['api']> = {},
  subscription: Partial<UsageHistory['projection']['subscription']> = {},
  backlog: Partial<BacklogProjection> = {},
): UsageHistory['projection'] => ({
  api: { todayUsd: 0, dailyCapUsd: 20, capAt: null, perDayUsd: 0, monthToDateUsd: 0, monthEndUsd: 0, burn: noBurn(), ...api },
  subscription: { perDayUsd: 0, perDayTokens: 0, monthToDateUsd: 0, monthEndUsd: 0, burn: noBurn(), ...subscription },
  backlog: { ...emptyBacklog(), ...backlog },
});
const sections = (allowance: AllowanceHistory[], p = projection()) => projectionSections({ allowance, projection: p }, now, time);
const lines = (allowance: AllowanceHistory[], p = projection()) => {
  const s = sections(allowance, p);
  return [...s.windows, ...s.month].map((l) => l.text);
};
const five = (a: Partial<AllowanceHistory>) => lines([sub(a)])[0];

describe('projection windows', () => {
  it('says when the limit is reached, and 100%', () => {
    expect(five({ fiveHour: win({ limitAt: now + 3 * 60_000, fullAt: now + 6 * 60_000, resetsAt: now + 9 * 60_000 }) })).toBe(
      'Claude-1, 5-hour window: 40% used, 10.0% an hour. Reaches your 70% limit at T3 and resets at T9. Reaches 100% at T6.',
    );
  });

  it('says when the window resets first', () => {
    expect(five({ fiveHour: win({ resetsAt: now + 60 * 60_000 }) })).toBe('Claude-1, 5-hour window: 40% used, 10.0% an hour. Resets at T60 before reaching your 70% limit.');
  });

  it('says over only above the limit', () => {
    expect(five({ fiveHour: win({ pct: 75, over: true, limitAt: now }) })).toBe('Claude-1, 5-hour window: 75% used. Over your 70% limit until it resets at T180.');
    expect(five({ fiveHour: win({ pct: 70, limitAt: now }) })).toBe('Claude-1, 5-hour window: 70% used. At your 70% limit; resets at T180.');
  });

  it('dates an old reading and never gives a time already past', () => {
    expect(five({ sampledAt: now - 60 * 60_000, fiveHour: win({ limitAt: now - 10 * 60_000 }) })).toBe(
      'Claude-1, 5-hour window, as of T-60: 40% used, 10.0% an hour. At that pace it may already be at your 70% limit.',
    );
  });

  it("doesn't claim a pace in the first minutes of a window", () => {
    expect(five({ fiveHour: win({ ratePerHour: 0 }) })).toBe('Claude-1, 5-hour window: 40% used. Too early in this window to tell its pace; resets at T180.');
  });

  it('says why there is no projection', () => {
    expect(five({ blockedUntil: now + 30 * 60_000 })).toBe('Claude-1: Claude reported a usage limit; resumes at T30.');
    expect(five({ unknown: true })).toBe("Claude-1: Claude doesn't report this subscription's usage. See its burn rate above.");
    expect(five({ sampledAt: null })).toBe('Claude-1, 5-hour window: No current reading.');
    expect(five({})).toBe('Claude-1, 5-hour window: No reading from this window since it last reset.');
  });

  it('keys lines apart for subscriptions with the same name', () => {
    const keys = sections([sub({}), sub({ connectionId: 2 })]).windows.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('projections this month', () => {
  it('leaves out API lines without API spend this month or today', () => {
    expect(lines([])).toEqual([]);
  });

  it('says when new API agents stop starting', () => {
    expect(lines([], projection({ todayUsd: 6.2, capAt: now + 30 * 60_000, monthToDateUsd: 41, monthEndUsd: 120, perDayUsd: 11.3 }))).toEqual([
      "API: $6.20 today. At today's pace new API agents stop starting at about T30, when the $20.00 daily limit is reached.",
      'API this month: $41.00 so far, about $120.00 by the end of the month at $11.30 a day (last 7 days).',
    ]);
  });

  it('covers staying under, reaching and a $0 limit', () => {
    expect(lines([], projection({ todayUsd: 1 }))[0]).toBe("API: $1.00 today. At today's pace it stays under the $20.00 daily limit today.");
    expect(lines([], projection({ todayUsd: 20, capAt: now }))[0]).toBe('API: $20.00 today. API daily limit reached; new API agents start again tomorrow.');
    expect(lines([], projection({ todayUsd: 0, dailyCapUsd: 0, monthToDateUsd: 3 }))[0]).toBe('API agents are off: the daily limit is $0.');
  });

  it('projects subscriptions as token-equivalent cost', () => {
    expect(lines([], projection({}, { monthToDateUsd: 300, monthEndUsd: 900, perDayTokens: 12e6 }))).toEqual([
      'Subscriptions this month: $300.00 token-equivalent so far, about $900.00 by the end of the month (12.0M tokens a day).',
    ]);
  });
});

const pool = (p: Partial<BacklogPool> = {}): BacklogPool => ({
  usd: 180,
  tokens: 61e6,
  perHourUsd: 12.4,
  finishAt: now + 26 * 60 * 60_000,
  unlimitedAt: now + 26 * 60 * 60_000,
  limitedBy: null,
  reason: null,
  curve: [],
  unsized: [],
  unmetered: [],
  ...p,
});
const backlog = (b: Partial<BacklogProjection>) => sections([], projection({}, {}, { tickets: 14, basis: 23, byStage: [{ stage: 'new', count: 3 }, { stage: 'design', count: 4 }, { stage: 'implement', count: 5 }, { stage: 'code-review', count: 2 }], ...b })).backlog!;

describe('projections for the backlog', () => {
  it('leads with what is left, its cost and when it is done', () => {
    const api = pool({ usd: 42, tokens: 19.1e6, finishAt: now + 60 * 60_000 });
    const b = backlog({ subscription: pool(), api, finishAt: now + 26 * 60 * 60_000 });
    expect(b.lead).toBe("14 tickets left, about $222.00 (80.1M tokens). At the current pace they're done by about T1560.");
    expect(b.rows).toEqual([
      { key: 'subscription', billing: 'Subscriptions', left: { cost: '$180.00 token-equivalent', tokens: '61.0M tokens' }, pace: '$12.40 an hour', finishes: 'T1560' },
      { key: 'api', billing: 'API', left: { cost: '$42.00', tokens: '19.1M tokens' }, pace: '$12.40 an hour', finishes: 'T60' },
    ]);
    expect(b.notes).toEqual([]);
    expect(b.detail).toBe('3 to classify · 4 in design · 5 to implement · 2 in code review. Estimated from 23 tickets finished in the last 90 days, by size and the stages each ticket has left.');
  });

  it('says when there is nothing to estimate from, or nothing left', () => {
    expect(backlog({ basis: 0, unestimated: 14 }).lead).toBe('14 tickets left. There are no finished tickets from the last 90 days to estimate them from yet.');
    expect(backlog({ tickets: 0, byStage: [] }).lead).toBe('Nothing in the backlog.');
    expect(sections([]).backlog).toBeNull();
  });

  it('leaves the finish out of the lead when part of the work can\'t finish', () => {
    expect(backlog({ subscription: pool({ finishAt: null, reason: 'no-pace' }) }).lead).toBe('14 tickets left, about $180.00 (61.0M tokens).');
  });

  it('gives the reason in place of a finish time', () => {
    const finishes = (reason: BacklogPool['reason']) => backlog({ subscription: pool({ finishAt: null, reason }) }).rows[0].finishes;
    expect(finishes('no-pace')).toBe('Not at the current pace');
    expect(finishes('api-off')).toBe('API agents are off');
    expect(finishes('no-subscription')).toBe('Every subscription is paused');
    expect(finishes('beyond')).toBe('More than 60 days');
  });

  it('notes what holds the work back and what the projection leaves out', () => {
    const b = backlog({
      subscription: pool({ limitedBy: 'weekly', finishAt: now + 3000 * 60_000, unsized: ['Claude-1 5-hour'], unmetered: ['Claude-2'] }),
      api: pool({ limitedBy: 'daily', finishAt: now + 4000 * 60_000, unlimitedAt: now + 100 * 60_000 }),
      unestimated: 2,
    });
    expect(b.notes).toEqual([
      'Your weekly limits hold subscription work back. At the pace alone it would be done by T1560.',
      "Ignores Claude-1's 5-hour limit: there's too little use in this window yet to tell how much it holds.",
      "Claude-2 doesn't report usage, so Workshop can't hold it at your limits. This assumes the current pace holds.",
      'The $20.00 API daily limit stretches API work to T4000. Without it, T100.',
      "2 tickets have no estimate yet and aren't counted.",
    ]);
    expect(backlog({ subscription: pool({ limitedBy: 'five-hour', unmetered: ['A', 'B'] }) }).notes).toEqual([
      'Your 5-hour limits hold subscription work back. At the pace alone it would be done by T1560.',
      "A and B don't report usage, so Workshop can't hold them at your limits. This assumes the current pace holds.",
    ]);
  });
});

describe('projections burn rate', () => {
  const rate = (usd: number, tokens: number): BurnRate => ({ fiveHours: { usd, tokens }, day: { usd: usd * 2, tokens: tokens * 2 }, perDay: { usd: usd * 3, tokens: tokens * 3 } });

  it('has a row per subscription, and API only with API spend in the last 7 days', () => {
    const s = sections([sub({ connectionName: 'Claude-2', unknown: true, burn: rate(5, 2e6) })]);
    expect(s.burn).toEqual([
      {
        key: '1',
        name: 'Claude-2',
        cells: [
          { cost: '$5.00', tokens: '2.0M tokens' },
          { cost: '$10.00', tokens: '4.0M tokens' },
          { cost: '$15.00', tokens: '6.0M tokens' },
        ],
      },
    ]);
    expect(sections([], projection({ burn: rate(1, 1000) })).burn.map((r) => r.name)).toEqual(['API']);
  });
});
