import type { AgentName, RunStatus, Stage } from '../../server/src/api-types.ts';

export const AGENT_LABEL: Record<AgentName, string> = {
  classifier: 'Classifier',
  design: 'Design',
  'design-review': 'Design adversary',
  implement: 'Implementation',
  merge: 'Merge',
};

export const STAGE_TEXT: Record<Stage, string> = {
  design: 'Design',
  'design-review': 'Design review',
  implement: 'Implementation',
  'pr-review': 'Your review',
  merge: 'Merge',
  reclassify: 'Re-classify changes',
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

export const money = (usd: number | null) => (usd === null ? null : `$${usd.toFixed(2)}`);

export function tokens(n: number | null) {
  if (n === null) return null;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M tokens`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k tokens`;
  return `${n} tokens`;
}
