import { useEffect, useState } from 'react';
import type { SyncProgress } from '../../../server/src/api-types.ts';
import { api, useApi, useNow } from '../api.ts';
import { syncStatus, type SyncStatus } from '../sync.ts';
import { SyncControl } from './SyncControl.tsx';

/** Sync now or Refresh: posts `action`, then follows the server's sync progress until it's idle again. */
export function SyncButton({ action, label, title }: { action: '/sync' | '/refresh'; label: string; title?: string }) {
  const { data, error, reload } = useApi<SyncProgress>('/sync', ['sync']);
  const now = useNow();
  const [sending, setSending] = useState<'no' | 'posting' | 'reloading'>('no');
  const [postError, setPostError] = useState<string | null>(null);
  // Stays "Sending…" until the record is fetched again, so the button never flashes enabled in between.
  useEffect(() => setSending((s) => (s === 'reloading' ? 'no' : s)), [data, error]);
  const click = () => {
    setSending('posting');
    setPostError(null);
    api(action, { body: {} }).then(
      () => {
        setSending('reloading');
        reload();
      },
      (e: Error) => {
        setPostError(e.message);
        setSending('no');
      },
    );
  };
  const status: SyncStatus = data ? syncStatus(data, now) : { busy: !error, text: '', bar: null };
  return <SyncControl status={status} lastError={data?.lastError ?? null} sending={sending !== 'no'} error={postError ?? error} label={label} title={title} onClick={click} />;
}
