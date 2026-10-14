import type { AllowanceView, Settings, UsageWindow } from '../api-types.ts';
import type { Step } from '../workflow/labels.ts';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function localTime(now: Date, timeZone: string): { day: number; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)!.value;
  return { day: WEEKDAYS.indexOf(part('weekday')), minutes: Number(part('hour')) * 60 + Number(part('minute')) };
}

const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** start === end means all day; start > end spans midnight and belongs to the day it starts on. */
export function withinHours(s: Pick<Settings, 'days' | 'start' | 'end' | 'timezone'>, now: Date): boolean {
  const { day, minutes } = localTime(now, s.timezone);
  const start = toMinutes(s.start);
  const end = toMinutes(s.end);
  if (start === end) return s.days.includes(day);
  if (start < end) return s.days.includes(day) && minutes >= start && minutes < end;
  return (s.days.includes(day) && minutes >= start) || (s.days.includes((day + 6) % 7) && minutes < end);
}

export function modeBlock(s: Settings, now: Date): string | null {
  if (s.mode === 'paused') return 'Workshop is paused';
  if (s.mode === 'scheduled' && !withinHours(s, now)) return 'Outside operating hours';
  return null;
}

export function formatTime(ms: number, timeZone: string, now = Date.now()): string {
  const sameDay = Math.abs(ms - now) < 20 * 3600_000;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    ...(sameDay ? {} : { weekday: 'short' }),
  }).format(ms);
}

/** A window whose reset time has passed counts as empty. */
const used = (w: UsageWindow | null, now: number) => (!w || (w.resetsAt !== null && w.resetsAt <= now) ? 0 : w.pct);

export const ALLOWANCE_MAX_AGE_MS = 10 * 60_000;

/** Why the subscription allowance blocks a launch right now, or null. */
export function allowanceBlock(a: AllowanceView | undefined, s: Settings, now: number): string | null {
  if (a?.blockedUntil && a.blockedUntil > now) return `Claude reported you're at or near a usage limit; resumes ${formatTime(a.blockedUntil, s.timezone, now)}`;
  if (!a?.sampledAt || now - a.sampledAt > ALLOWANCE_MAX_AGE_MS) return 'Checking allowance';
  const resets = (w: UsageWindow | null) => (w?.resetsAt ? `, resets ${formatTime(w.resetsAt, s.timezone, now)}` : '');
  const five = used(a.fiveHour, now);
  if (five > s.fiveHourMax) return `5-hour allowance at ${Math.round(five)}%${resets(a.fiveHour)}`;
  const week = used(a.sevenDay, now);
  if (week > s.weeklyMax) return `Weekly allowance at ${Math.round(week)}%${resets(a.sevenDay)}`;
  return null;
}

export function apiCapBlock(spentTodayUsd: number, s: Settings): string | null {
  return spentTodayUsd >= s.apiDailyCapUsd ? `API spend today $${spentTodayUsd.toFixed(2)} reached the $${s.apiDailyCapUsd} daily cap` : null;
}

export interface HostLoad {
  id: number;
  healthy: boolean;
  slots: number;
  busy: number;
}

/** The healthy host with the most free slots. */
export function pickHost(hosts: HostLoad[]): number | null {
  const free = hosts.filter((h) => h.healthy && h.busy < h.slots);
  free.sort((a, b) => b.slots - b.busy - (a.slots - a.busy) || a.id - b.id);
  return free[0]?.id ?? null;
}

/** "#2", "#2 and #5", "#2, #5 and #7". */
export function joinRefs(refs: string[]): string {
  return refs.length < 2 ? refs.join('') : `${refs.slice(0, -1).join(', ')} and ${refs[refs.length - 1]}`;
}

/** Why open blocking tickets hold a ticket back, or null. */
export function dependencyBlock(refs: string[]): string | null {
  return refs.length ? `Depends on ${joinRefs(refs)}` : null;
}

/** Finish work in flight before starting new work. */
export function stepPriority(step: Step): number {
  if (step.kind === 'merge') return 0;
  if (step.agent === 'merge') return 0;
  if (step.agent === 'implement' || step.mode === 'delta') return 1;
  if (step.agent === 'design-review') return 2;
  if (step.agent === 'design') return 3;
  return 4;
}
