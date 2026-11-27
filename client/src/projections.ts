import type { AllowanceHistory, BacklogPool, BacklogProjection, Burn, Stage, UsageHistory, WindowProjection } from '../../server/src/api-types.ts';
import { money, tokens, when } from './format.ts';

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
  if (a.unknown) return [{ key: `${id}`, text: `${a.connectionName}: Claude doesn't report this subscription's usage. See its burn rate above.` }];
  return [
    { key: `${id}-5h`, text: windowLine(`${a.connectionName}, 5-hour window`, a, a.fiveHour, a.limits.fiveHour, now, time) },
    { key: `${id}-7d`, text: windowLine(`${a.connectionName}, weekly window`, a, a.sevenDay, a.limits.weekly, now, time) },
  ];
}

type Line = { key: string; text: string };

export interface Cell {
  cost: string;
  tokens: string;
}

export interface BacklogRow {
  key: 'subscription' | 'api';
  billing: string;
  left: Cell;
  pace: string;
  finishes: string;
}

export interface ProjectionSections {
  /** Null hides the section: no open tickets and nothing finished yet. */
  backlog: { lead: string; rows: BacklogRow[]; notes: string[]; detail: string } | null;
  burn: { key: string; name: string; cells: [Cell, Cell, Cell] }[];
  windows: Line[];
  month: Line[];
}

const STAGE_COUNT: Record<Stage | 'new', string> = {
  new: 'to classify',
  reclassify: 'to re-classify',
  design: 'in design',
  'design-review': 'in design review',
  implement: 'to implement',
  'code-review': 'in code review',
  merge: 'to merge',
  reconcile: 'to reconcile',
  'pr-review': 'in your review',
};

const REASON: Record<NonNullable<BacklogPool['reason']>, string> = {
  'no-pace': 'Not at the current pace',
  'api-off': 'API agents are off',
  'no-subscription': 'Every subscription is paused',
  beyond: 'More than 60 days',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const tokenText = (n: number) => tokens(Math.round(n))!;
const cell = (b: Burn): Cell => ({ cost: money(b.usd)!, tokens: tokenText(b.tokens) });
/** "A", "A and B", "A, B and C". */
const list = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

function backlogSection(b: BacklogProjection, api: UsageHistory['projection']['api'], time: Time): ProjectionSections['backlog'] {
  if (b.tickets === 0 && b.basis === 0) return null;
  if (b.tickets === 0) return { lead: 'Nothing in the backlog.', rows: [], notes: [], detail: '' };
  const left = plural(b.tickets, 'ticket');
  const done = b.tickets === 1 ? "it's" : "they're";
  const pools = [b.subscription, b.api].filter((p) => p !== null);
  let lead: string;
  if (b.basis === 0) lead = `${left} left. There are no finished tickets from the last 90 days to estimate them from yet.`;
  else {
    const usd = pools.reduce((n, p) => n + p.usd, 0);
    const tok = pools.reduce((n, p) => n + p.tokens, 0);
    lead = `${left} left, about ${money(usd)} (${tokenText(tok)}).`;
    if (b.finishAt !== null) lead += ` At the current pace ${done} done by about ${time(b.finishAt)}.`;
  }

  const rows: BacklogRow[] = [];
  const notes: string[] = [];
  const finishes = (p: BacklogPool) => (p.finishAt !== null ? time(p.finishAt) : REASON[p.reason ?? 'beyond']);
  const s = b.subscription;
  if (s) {
    rows.push({ key: 'subscription', billing: 'Subscriptions', left: { cost: `${money(s.usd)} token-equivalent`, tokens: tokenText(s.tokens) }, pace: `${money(s.perHourUsd)} an hour`, finishes: finishes(s) });
    if ((s.limitedBy === 'weekly' || s.limitedBy === 'five-hour') && s.unlimitedAt !== null) {
      notes.push(`Your ${s.limitedBy === 'weekly' ? 'weekly' : '5-hour'} limits hold subscription work back. At the pace alone it would be done by ${time(s.unlimitedAt)}.`);
    }
    for (const u of s.unsized) {
      const i = u.lastIndexOf(' ');
      notes.push(`Ignores ${u.slice(0, i)}'s ${u.slice(i + 1)} limit: there's too little use in this window yet to tell how much it holds.`);
    }
    if (s.unmetered.length) {
      const one = s.unmetered.length === 1;
      notes.push(`${list(s.unmetered)} ${one ? "doesn't" : "don't"} report usage, so Workshop can't hold ${one ? 'it' : 'them'} at your limits. This assumes the current pace holds.`);
    }
  }
  const a = b.api;
  if (a) {
    rows.push({ key: 'api', billing: 'API', left: { cost: money(a.usd)!, tokens: tokenText(a.tokens) }, pace: `${money(a.perHourUsd)} an hour`, finishes: finishes(a) });
    if (a.limitedBy === 'daily' && a.unlimitedAt !== null) {
      const to = a.finishAt !== null ? `to ${time(a.finishAt)}` : 'past 60 days';
      notes.push(`The ${money(api.dailyCapUsd)} API daily limit stretches API work ${to}. Without it, ${time(a.unlimitedAt)}.`);
    }
  }
  if (b.basis > 0 && b.unestimated > 0) notes.push(`${plural(b.unestimated, 'ticket has', 'tickets have')} no estimate yet and ${b.unestimated === 1 ? "isn't" : "aren't"} counted.`);

  const stages = b.byStage.map((x) => `${x.count} ${STAGE_COUNT[x.stage]}`).join(' · ');
  let detail = `${stages}.`;
  if (b.basis > 0) detail += ` Estimated from ${plural(b.basis, 'ticket')} finished in the last 90 days, by size and the stages each ticket has left.`;
  return { lead, rows, notes, detail };
}

export function projectionSections(data: Pick<UsageHistory, 'allowance' | 'projection'>, now: number, time: Time = when): ProjectionSections {
  const { api, subscription } = data.projection;
  const windows = data.allowance.flatMap((a) => subscriptionLines(a, now, time));
  const burn: ProjectionSections['burn'] = data.allowance.map((a) => ({ key: `${a.connectionId}`, name: a.connectionName, cells: [cell(a.burn.fiveHours), cell(a.burn.day), cell(a.burn.perDay)] }));
  if (api.burn.perDay.usd > 0 || api.burn.perDay.tokens > 0) burn.push({ key: 'api', name: 'API', cells: [cell(api.burn.fiveHours), cell(api.burn.day), cell(api.burn.perDay)] });
  const month: Line[] = [];
  if (api.monthToDateUsd > 0 || api.todayUsd > 0) {
    const today = `API: ${money(api.todayUsd)} today.`;
    const limit = money(api.dailyCapUsd);
    let text: string;
    if (api.dailyCapUsd <= 0) text = 'API agents are off: the daily limit is $0.';
    else if (api.todayUsd >= api.dailyCapUsd) text = `${today} API daily limit reached; new API agents start again tomorrow.`;
    else if (api.capAt !== null) text = `${today} At today's pace new API agents stop starting at about ${time(api.capAt)}, when the ${limit} daily limit is reached.`;
    else text = `${today} At today's pace it stays under the ${limit} daily limit today.`;
    month.push({ key: 'api-today', text });
    month.push({
      key: 'api-month',
      text: `API this month: ${money(api.monthToDateUsd)} so far, about ${money(api.monthEndUsd)} by the end of the month at ${money(api.perDayUsd)} a day (last 7 days).`,
    });
  }
  if (data.allowance.length > 0 || subscription.monthToDateUsd > 0) {
    month.push({
      key: 'subscription-month',
      text: `Subscriptions this month: ${money(subscription.monthToDateUsd)} token-equivalent so far, about ${money(subscription.monthEndUsd)} by the end of the month (${tokens(Math.round(subscription.perDayTokens))} a day).`,
    });
  }
  return { backlog: backlogSection(data.projection.backlog, api, time), burn, windows, month };
}
