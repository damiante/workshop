import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { SyncProgress } from '../../server/src/api-types.ts';
import { SyncControl } from '../src/components/SyncControl.tsx';
import { syncStatus, type SyncStatus } from '../src/sync.ts';

const now = Date.UTC(2026, 10, 28, 12);
const idle: SyncProgress = { state: 'idle', kind: 'scheduled', phase: null, repo: null, done: 0, total: 0, requestedAt: null, lastFinishedAt: null, lastError: null };
const p = (over: Partial<SyncProgress>): SyncProgress => ({ ...idle, ...over });
const running = (over: Partial<SyncProgress>) => p({ state: 'running', kind: 'refresh', ...over });

describe('syncStatus', () => {
  it('says when the last sync finished when idle', () => {
    expect(syncStatus(p({ lastFinishedAt: now - 2 * 60_000 }), now)).toEqual({ busy: false, text: 'Last synced 2 min ago', bar: null });
    expect(syncStatus(p({ lastFinishedAt: now - 10_000 }), now).text).toBe('Last synced just now');
    expect(syncStatus(idle, now)).toEqual({ busy: false, text: 'Not synced since Workshop started', bar: null });
  });

  it('waits while requested or queued behind a running pass', () => {
    for (const state of ['requested', 'waiting'] as const) {
      expect(syncStatus(p({ state, kind: 'sync' }), now)).toEqual({ busy: true, text: 'Waiting for the current check to finish', bar: null });
    }
  });

  it('counts repositories while syncing', () => {
    expect(syncStatus(running({ phase: 'sync', repo: 'damiante/dnd-campaigner', done: 2, total: 12 }), now)).toEqual({
      busy: true,
      text: 'Syncing damiante/dnd-campaigner (3 of 12 repos)',
      bar: { value: 2, max: 12 },
    });
    expect(syncStatus(running({ phase: 'sync', repo: 'me/app', done: 0, total: 1 }), now).text).toBe('Syncing me/app (1 of 1 repo)');
    expect(syncStatus(running({ phase: 'sync', repo: null, done: 12, total: 12 }), now)).toEqual({ busy: true, text: 'Finishing the sync', bar: null });
    expect(syncStatus(running({ phase: 'sync', total: 0 }), now)).toEqual({ busy: true, text: 'Syncing tickets', bar: null });
  });

  it('counts usage checks, then starts work, on Refresh', () => {
    expect(syncStatus(running({ phase: 'usage', done: 1, total: 2 }), now)).toEqual({ busy: true, text: 'Checking Claude usage (1 of 2)', bar: { value: 1, max: 2 } });
    expect(syncStatus(running({ phase: 'allocate' }), now)).toEqual({ busy: true, text: 'Starting work', bar: null });
  });
});

describe('SyncControl', () => {
  const render = (over: { status?: SyncStatus; lastError?: string | null; sending?: boolean; error?: string | null } = {}) =>
    renderToStaticMarkup(
      <SyncControl status={syncStatus(p({ lastFinishedAt: now }), now)} lastError={null} sending={false} error={null} label="Sync now" onClick={() => {}} {...over} />,
    );
  const button = (html: string) => html.match(/<button[^>]*>[^<]*<\/button>/)![0];

  it('is enabled when idle', () => {
    const html = render();
    expect(button(html)).toBe('<button>Sync now</button>');
    expect(html).toContain('Last synced just now');
  });

  it('says Sending… and is disabled before the server replies', () => {
    expect(button(render({ sending: true }))).toBe('<button disabled="">Sending…</button>');
  });

  it('is disabled with a progress bar while busy', () => {
    const html = render({ status: syncStatus(running({ phase: 'sync', repo: 'me/app', done: 1, total: 3 }), now) });
    expect(button(html)).toBe('<button disabled="">Sync now</button>');
    expect(html).toContain('role="meter"');
    expect(html).toContain('Syncing me/app (2 of 3 repos)');
    expect(html).not.toContain('meter-fill over');
  });

  it('shows a failed request', () => {
    const html = render({ error: 'Read tokens can only read.' });
    expect(html).toContain('<p class="notice error" role="alert">Read tokens can only read.</p>');
    expect(button(html)).toBe('<button>Sync now</button>');
  });

  it("shows the last pass's sync failures when idle", () => {
    expect(render({ lastError: 'Couldn’t sync me/app: Bad credentials' })).toContain('role="alert">Couldn’t sync me/app: Bad credentials</p>');
    expect(render({ lastError: 'x', status: syncStatus(p({ state: 'waiting' }), now) })).not.toContain('role="alert"');
  });
});
