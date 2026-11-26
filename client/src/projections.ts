import type { AllowanceHistory, UsageHistory, WindowProjection } from '../../server/src/api-types.ts';
import { clock, money, tokens } from './format.ts';

/** Pure: the Usage page's projections as plain sentences. */

/** Matches the launch gate: an older reading gets re-checked before a launch. */
const ALLOWANCE_MAX_AGE_MS = 10 * 60_000;

type Time = (ms: number) => string;

/** One sentence about where a subscription window is heading. */
function windowLine(name: string, a: AllowanceHistory, p: WindowProjection | null, limit: number, now: number, time: Time): string {
  if (!p) return `${name}: ${a.sampledAt === null ? 'No current reading.' : 'No reading from this window since it last reset.'}`;
  const old = a.sampledAt !== null && now - a.sampledAt > ALLOWANCE_MAX_AGE_MS;
  const head = old ? `${name}, as of ${time(a.sampledAt!)}:` : `${name}:`;
  const used = `${Math.round(p.pct)}% used`;
  const resets = time(p.resetsAt);
  if (p.over) return `${head} ${used}. Over your ${limit}% limit until it resets at ${resets}.`;
  if (p.limitAt === a.sampledAt) return `${head} ${used}. At your ${limit}% limit; resets at ${resets}.`;
  if (p.ratePerHour === 0) return `${head} ${used}. Too early in this window to tell its pace; resets at ${resets}.`;
  let line = `${head} ${used}, ${p.ratePerHour.toFixed(1)}% an hour.`;
  if (p.limitAt === null) line += ` Resets at ${resets} before reaching your ${limit}% limit.`;
  else if (p.limitAt <= now) line += ` At that pace it may already be at your ${limit}% limit.`;
  else line += ` Reaches your ${limit}% limit at ${time(p.limitAt)} and resets at ${resets}.`;
  if (p.fullAt !== null && p.fullAt !== p.limitAt && p.fullAt > now) line += ` Reaches 100% at ${time(p.fullAt)}.`;
  return line;
}

function subscriptionLines(a: AllowanceHistory, now: number, time: Time): { key: string; text: string }[] {
  const id = a.connectionId;
  if (a.blockedUntil) return [{ key: `${id}`, text: `${a.connectionName}: Claude reported a usage limit; resumes at ${time(a.blockedUntil)}.` }];
  if (a.unknown) return [{ key: `${id}`, text: `${a.connectionName}: Claude doesn't report this subscription's usage.` }];
  return [
    { key: `${id}-5h`, text: windowLine(`${a.connectionName}, 5-hour window`, a, a.fiveHour, a.limits.fiveHour, now, time) },
    { key: `${id}-7d`, text: windowLine(`${a.connectionName}, weekly window`, a, a.sevenDay, a.limits.weekly, now, time) },
  ];
}

export function projectionLines(data: Pick<UsageHistory, 'allowance' | 'projection'>, now: number, time: Time = clock): { key: string; text: string }[] {
  const { api, subscription } = data.projection;
  const lines = data.allowance.flatMap((a) => subscriptionLines(a, now, time));
  if (api.monthToDateUsd > 0 || api.todayUsd > 0) {
    const today = `API: ${money(api.todayUsd)} today.`;
    const limit = money(api.dailyCapUsd);
    let text: string;
    if (api.dailyCapUsd <= 0) text = 'API agents are off: the daily limit is $0.';
    else if (api.todayUsd >= api.dailyCapUsd) text = `${today} API daily limit reached; new API agents start again tomorrow.`;
    else if (api.capAt !== null) text = `${today} At today's pace new API agents stop starting at about ${time(api.capAt)}, when the ${limit} daily limit is reached.`;
    else text = `${today} At today's pace it stays under the ${limit} daily limit today.`;
    lines.push({ key: 'api-today', text });
    lines.push({
      key: 'api-month',
      text: `API this month: ${money(api.monthToDateUsd)} so far, about ${money(api.monthEndUsd)} by the end of the month at ${money(api.perDayUsd)} a day (last 7 days).`,
    });
  }
  if (data.allowance.length > 0 || subscription.monthToDateUsd > 0) {
    lines.push({
      key: 'subscription-month',
      text: `Subscriptions this month: ${money(subscription.monthToDateUsd)} token-equivalent so far, about ${money(subscription.monthEndUsd)} by the end of the month (${tokens(Math.round(subscription.perDayTokens))} a day).`,
    });
  }
  return lines;
}
