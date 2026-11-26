import type { UsageWindow, WindowProjection } from './api-types.ts';

/** Pure projections for the Usage page: no database, no clock. */

export const FIVE_HOURS = 5 * 3600_000;
export const SEVEN_DAYS = 7 * 86400_000;
const HOUR = 3600_000;
/** Under this, a pace is too noisy to project from. */
const MIN_ELAPSED = 15 * 60_000;

/**
 * Where a subscription window is heading at its average pace since it began.
 * Null without a reading from the current window, or once the window has reset (the launch gate counts that as empty).
 */
export function windowProjection(w: UsageWindow | null, length: number, limit: number, sampledAt: number | null, now: number): WindowProjection | null {
  if (!w || w.resetsAt === null || sampledAt === null) return null;
  const resetsAt = w.resetsAt;
  const start = resetsAt - length;
  if (sampledAt < start || resetsAt <= now) return null;
  const elapsed = sampledAt - start;
  const ratePerHour = elapsed < MIN_ELAPSED ? 0 : w.pct / (elapsed / HOUR);
  const reaches = (target: number) => {
    if (w.pct >= target) return sampledAt;
    if (ratePerHour <= 0) return null;
    const at = Math.round(sampledAt + ((target - w.pct) / ratePerHour) * HOUR);
    return at < resetsAt ? at : null;
  };
  return { pct: w.pct, resetsAt, ratePerHour, limitAt: reaches(limit), fullAt: reaches(100), over: w.pct > limit };
}

/**
 * When today's API spend reaches the daily limit at today's pace since midnight: `now` if it already has,
 * null if it won't today or the limit is $0 (API launches are off).
 */
export function capAt(spent: number, cap: number, dayStart: number, now: number): number | null {
  if (cap <= 0) return null;
  if (spent >= cap) return now;
  if (spent <= 0 || now - dayStart < MIN_ELAPSED) return null;
  const at = Math.round(dayStart + cap / (spent / (now - dayStart)));
  return at < dayStart + 24 * HOUR ? at : null;
}

/** Month-to-date plus `perDay` for the rest of today (`dayFraction` has passed) and the days left. `todayKey` is 'YYYY-MM-DD'. */
export function monthEnd(monthToDate: number, perDay: number, todayKey: string, dayFraction: number): number {
  const [y, m, d] = todayKey.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return monthToDate + perDay * (daysInMonth - d + (1 - dayFraction));
}
