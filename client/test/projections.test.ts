import { describe, expect, it } from 'vitest';
import type { AllowanceHistory, UsageHistory, WindowProjection } from '../../server/src/api-types.ts';
import { projectionLines } from '../src/projections.ts';

const H = 3600_000;
const now = Date.parse('2026-11-26T12:00:00Z');
const time = (ms: number) => `T${(ms - now) / 60_000}`; // minutes from now

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
  ...a,
});
const projection = (api: Partial<UsageHistory['projection']['api']> = {}, subscription: Partial<UsageHistory['projection']['subscription']> = {}): UsageHistory['projection'] => ({
  api: { todayUsd: 0, dailyCapUsd: 20, capAt: null, perDayUsd: 0, monthToDateUsd: 0, monthEndUsd: 0, ...api },
  subscription: { perDayUsd: 0, perDayTokens: 0, monthToDateUsd: 0, monthEndUsd: 0, ...subscription },
});
const lines = (allowance: AllowanceHistory[], p = projection()) => projectionLines({ allowance, projection: p }, now, time).map((l) => l.text);
const five = (a: Partial<AllowanceHistory>) => lines([sub(a)])[0];

describe('projectionLines for subscriptions', () => {
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
    expect(five({ unknown: true })).toBe("Claude-1: Claude doesn't report this subscription's usage.");
    expect(five({ sampledAt: null })).toBe('Claude-1, 5-hour window: No current reading.');
    expect(five({})).toBe('Claude-1, 5-hour window: No reading from this window since it last reset.');
  });

  it('keys lines apart for subscriptions with the same name', () => {
    const keys = projectionLines({ allowance: [sub({}), sub({ connectionId: 2 })], projection: projection() }, now, time).map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('projectionLines for spend', () => {
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
