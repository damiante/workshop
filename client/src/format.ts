import type { AgentName, RunStatus, RunView, Stage, TicketView } from '../../server/src/api-types.ts';

export const AGENT_LABEL: Record<AgentName, string> = {
  classifier: 'Classifier',
  design: 'Design',
  'design-review': 'Design adversary',
  implement: 'Implementation',
  'code-review': 'Code reviewer',
  merge: 'Merge',
};

export const STAGE_TEXT: Record<Stage, string> = {
  design: 'Design',
  'design-review': 'Design review',
  implement: 'Implementation',
  'code-review': 'Code review',
  'pr-review': 'Your review',
  merge: 'Merge',
  reclassify: 'Re-classify changes',
  reconcile: 'Reconcile pushed work',
};

export const RUN_STATUS: Record<RunStatus, { label: string; tone: Tone }> = {
  starting: { label: 'Preparing', tone: 'running' },
  running: { label: 'Working', tone: 'running' },
  publishing: { label: 'Publishing', tone: 'running' },
  paused: { label: 'Paused for usage limit', tone: 'attention' },
  succeeded: { label: 'Done', tone: 'ok' },
  failed: { label: 'Failed', tone: 'error' },
  cancelled: { label: 'Stopped', tone: 'idle' },
  lost: { label: 'Lost', tone: 'error' },
};

export type Tone = 'ok' | 'attention' | 'error' | 'idle' | 'running';

/** What a ticket's status line says on the Tickets page, or null when it has nothing to flag. */
export function ticketStatus(t: Pick<TicketView, 'activeRunId' | 'failed' | 'needsInfo' | 'skipped'>): { tone: Tone; text: string } | null {
  if (t.activeRunId) return { tone: 'running', text: 'Agent working' };
  if (t.failed) return { tone: 'error', text: 'Stopped after failures' };
  if (t.needsInfo) return { tone: 'attention', text: 'Waiting for your answer' };
  if (t.skipped) return { tone: 'idle', text: 'Skipped' };
  return null;
}

/** A run's status label, telling a pause you made, or a move off a paused subscription, apart from one for usage. */
export function runStatus(run: Pick<RunView, 'status' | 'pauseReason'>): { label: string; tone: Tone } {
  if (run.status === 'paused' && run.pauseReason === 'manual') return { label: 'Paused by you', tone: 'attention' };
  if (run.status === 'paused' && run.pauseReason === 'connection') return { label: 'Paused: subscription paused', tone: 'attention' };
  return RUN_STATUS[run.status];
}

export function duration(from: number, to = Date.now()) {
  const minutes = Math.max(0, Math.round((to - from) / 60_000));
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

export function ago(ms: number | null, now = Date.now()) {
  if (!ms) return 'never';
  return `${duration(ms, now)} ago`.replace('under a minute ago', 'just now');
}

export const clock = (ms: number) =>
  new Date(ms).toLocaleString([], Math.abs(ms - Date.now()) < 20 * 3600_000 ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' });

/** A time that may be weeks away: `clock` within 6 days, otherwise with the date, e.g. "Mon 7 Dec, 14:00". */
export const when = (ms: number, now = Date.now()) =>
  Math.abs(ms - now) < 6 * 86400_000 ? clock(ms) : new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export const money = (usd: number | null) => (usd === null ? null : `$${usd.toFixed(2)}`);

export function tokens(n: number | null) {
  if (n === null) return null;
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B tokens`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M tokens`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k tokens`;
  return `${n} tokens`;
}
