import type { SyncProgress } from '../../server/src/api-types.ts';
import { ago } from './format.ts';

export interface SyncStatus {
  /** A sync or refresh is requested, waiting or running, so another click wouldn't do anything. */
  busy: boolean;
  text: string;
  bar: { value: number; max: number } | null;
}

const repos = (n: number) => (n === 1 ? 'repo' : 'repos');

/** What the Sync now and Refresh buttons say about the server's sync progress record. */
export function syncStatus(p: SyncProgress, now: number): SyncStatus {
  if (p.state === 'requested' || p.state === 'waiting') return { busy: true, text: 'Waiting for the current check to finish', bar: null };
  if (p.state === 'idle') return { busy: false, text: p.lastFinishedAt ? `Last synced ${ago(p.lastFinishedAt, now)}` : 'Not synced since Workshop started', bar: null };
  if (p.phase === 'usage') return { busy: true, text: `Checking Claude usage (${p.done} of ${p.total})`, bar: { value: p.done, max: p.total } };
  if (p.phase === 'allocate') return { busy: true, text: 'Starting work', bar: null };
  if (!p.total) return { busy: true, text: 'Syncing tickets', bar: null };
  if (!p.repo) return { busy: true, text: 'Finishing the sync', bar: null };
  return { busy: true, text: `Syncing ${p.repo} (${Math.min(p.done + 1, p.total)} of ${p.total} ${repos(p.total)})`, bar: { value: p.done, max: p.total } };
}
