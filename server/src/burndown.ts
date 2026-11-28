// The weekly burndown (#142): a weekly limit that rises through the week so usage reaches about 100% at the
// reset. Pure: no database, no clock. allowance.ts feeds it readings and settings.
import type { Burndown, BurndownBound, Settings } from './api-types.ts';
import { withinHours } from './scheduler/gates.ts';

const HOUR = 3600_000;
/** A weekly window, in hours. */
export const WEEK_HOURS = 168;
/** Workshop is assumed to reach the target at this share of its measured speed, so the line errs low. */
export const CATCH_UP_SHARE = 0.75;
/** The line keeps room for this many times your usual own use until the reset. */
export const USER_SAFETY = 1.5;
/** Running agents pause only this many points over the line, so they don't stop and start as it moves. */
export const RUN_GRACE_PCT = 2;
/** Your own use before Workshop has measured it, in weekly points an hour (about 25% a week), and how many hours of readings it weighs as. */
export const PRIOR_OTHER_PER_HOUR = 0.15;
export const PRIOR_HOURS = 24;
/** Hours of busy readings before the agents' rates are trusted. */
export const MIN_RATE_HOURS = 2;
/** Consecutive readings further apart than this say nothing about a rate. */
export const MAX_PAIR_GAP_MS = 2 * HOUR;
/** Readings whose reset times differ by less than this are from the same window. */
export const SAME_WINDOW_MS = HOUR;
/** Where the margin starts, and how far it may move. */
export const DEFAULT_MARGIN = 3;
export const MIN_MARGIN = 1;
export const MAX_MARGIN = 10;

/** One usage reading as allowance.ts stores it. */
export interface Reading {
  ts: number;
  five: number | null;
  fiveResets: number | null;
  week: number | null;
  weekResets: number | null;
  /** This subscription's agents in their claude step at the reading; null on older rows. */
  active: number | null;
  ceiling?: number | null;
  burndown?: number | null;
}

export interface Rates {
  /** Use that isn't Workshop's agents, in weekly points an hour. */
  otherPerHour: number;
  /** The agents' own weekly points an hour while they run; null until MIN_RATE_HOURS of readings. */
  workshopPerHour: number | null;
  /** The 5-hour window's points an hour while agents run; null until MIN_RATE_HOURS of readings. */
  fivePerHour: number | null;
  otherHours: number;
  workshopHours: number;
}

const sameWindow = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < SAME_WINDOW_MS;

/**
 * Rates from consecutive readings, oldest first. Pairs where no agent ran on either end measure your own use;
 * pairs with agents running on both ends measure Workshop's. Mixed, unknown, far-apart, falling and
 * cross-reset pairs are skipped. An agent that ran between two idle readings recorded readings of its own,
 * so it splits that span into mixed pairs rather than counting as your use.
 */
export function learnRates(readings: Reading[]): Rates {
  let idleDw = 0;
  let idleH = 0;
  let busyDw = 0;
  let busyH = 0;
  let fiveD = 0;
  let fiveH = 0;
  for (let i = 1; i < readings.length; i++) {
    const a = readings[i - 1];
    const b = readings[i];
    const dt = b.ts - a.ts;
    if (dt <= 0 || dt > MAX_PAIR_GAP_MS) continue;
    if (a.week === null || b.week === null || !sameWindow(a.weekResets, b.weekResets) || b.week < a.week) continue;
    if (a.active === null || b.active === null) continue;
    const h = dt / HOUR;
    if (a.active === 0 && b.active === 0) {
      idleDw += b.week - a.week;
      idleH += h;
    } else if (a.active > 0 && b.active > 0) {
      busyDw += b.week - a.week;
      busyH += h;
      if (a.five !== null && b.five !== null && sameWindow(a.fiveResets, b.fiveResets) && b.five >= a.five) {
        fiveD += b.five - a.five;
        fiveH += h;
      }
    }
  }
  const otherPerHour = (PRIOR_OTHER_PER_HOUR * PRIOR_HOURS + idleDw) / (PRIOR_HOURS + idleH);
  return {
    otherPerHour,
    workshopPerHour: busyH >= MIN_RATE_HOURS ? Math.max(0, busyDw / busyH - otherPerHour) : null,
    fivePerHour: fiveH >= MIN_RATE_HOURS ? fiveD / fiveH : null,
    otherHours: idleH,
    workshopHours: busyH,
  };
}

type HoursSettings = Pick<Settings, 'mode' | 'days' | 'start' | 'end' | 'timezone'>;

/** Hours between `from` and `to` when Workshop may start agents, in 15-minute steps. Paused counts as always: a pause is temporary. */
export function allowedHours(from: number, to: number, s: HoursSettings): number {
  if (to <= from) return 0;
  if (s.mode !== 'scheduled') return (to - from) / HOUR;
  const step = 15 * 60_000;
  let n = 0;
  for (let t = from; t < to; t += step) if (withinHours(s, new Date(t))) n++;
  return (n * step) / HOUR;
}

/** Share of the time the 5-hour limit lets agents run: they burn at `fivePerHour` until the limit, then wait for the reset. */
export function dutyCycle(fivePerHour: number | null, fiveHourLimit: number): number | null {
  if (fivePerHour === null) return null;
  return fivePerHour <= 0 ? 1 : Math.min(1, fiveHourLimit / (5 * fivePerHour));
}

/**
 * Where weekly usage may reach now. A reset that has already passed rolls forward by whole weeks, so a reading
 * from just before it starts the new week near 0 rather than leaving no line at all.
 */
export function burndownCeiling(o: {
  now: number;
  resetsAt: number | null;
  margin: number;
  rates: Rates;
  fiveHourLimit: number;
  settings: HoursSettings;
}): { ceiling: number | null; bound: BurndownBound | null; target: number; duty: number | null } {
  const target = 100 - o.margin;
  const duty = dutyCycle(o.rates.fivePerHour, o.fiveHourLimit);
  if (o.resetsAt === null) return { ceiling: null, bound: null, target, duty };
  let resetsAt = o.resetsAt;
  if (resetsAt <= o.now) resetsAt += Math.floor((o.now - resetsAt) / (WEEK_HOURS * HOUR) + 1) * WEEK_HOURS * HOUR;
  const r = Math.min(WEEK_HOURS, (resetsAt - o.now) / HOUR);
  const U = o.rates.otherPerHour;
  const M = o.rates.workshopPerHour;
  const linear = target * (1 - r / WEEK_HOURS);
  const catchUp = M !== null && duty !== null ? target - U * r - CATCH_UP_SHARE * M * duty * allowedHours(o.now, resetsAt, o.settings) : -Infinity;
  const userCap = target - USER_SAFETY * U * r;
  const raised = Math.max(linear, catchUp);
  const raw = Math.min(raised, userCap);
  const bound: BurndownBound = raw >= target ? 'target' : userCap < raised ? 'userCap' : catchUp > linear ? 'catchUp' : 'linear';
  return { ceiling: Math.min(target, Math.max(0, raw)), bound, target, duty };
}

/** The line a weekly reading is judged against, or null when the burndown is off or has no reading. Running agents get the grace. */
export function burndownLine(b: Pick<Burndown, 'enabled' | 'ceiling'> | undefined, running = false): number | null {
  if (!b?.enabled || b.ceiling === null) return null;
  return b.ceiling + (running ? RUN_GRACE_PCT : 0);
}

/** The weekly limit to size and project a whole week against: the set limit, or the burndown's target when that's lower. */
export function weeklyTarget(weekly: number, b: Pick<Burndown, 'enabled' | 'target'> | undefined): number {
  return b?.enabled ? Math.min(weekly, b.target) : weekly;
}

/** Hours the burndown held agents back: spans that start on a reading with the burndown on and usage at or over its line. */
export function heldHours(readings: Pick<Reading, 'ts' | 'week' | 'ceiling' | 'burndown'>[]): number {
  let ms = 0;
  for (let i = 1; i < readings.length; i++) {
    const a = readings[i - 1];
    if (a.burndown !== 1 || a.ceiling == null || a.week === null || a.week < a.ceiling) continue;
    ms += Math.min(MAX_PAIR_GAP_MS, readings[i].ts - a.ts);
  }
  return ms / HOUR;
}

/** The margin after a week ends. An overshoot widens it; a week that ended low though the line held agents back narrows it. */
export function nextMargin(margin: number, week: { enabled: boolean; finalPct: number | null; blocked: boolean; heldHours: number }): number {
  if (!week.enabled) return margin;
  if ((week.finalPct !== null && week.finalPct >= 100) || week.blocked) return Math.min(MAX_MARGIN, margin + 2);
  if (week.heldHours >= 6 && week.finalPct !== null && week.finalPct < 100 - margin - 3) return Math.max(MIN_MARGIN, margin - 1);
  return margin;
}
