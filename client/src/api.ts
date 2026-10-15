import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AuthState, Topic } from '../../server/src/api-types.ts';
import { LiveStream } from './live.ts';

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = init.body !== undefined;
  const res = await fetch(`/api${path}`, {
    method: init.method ?? (hasBody ? 'POST' : 'GET'),
    headers: hasBody ? { 'content-type': 'application/json' } : undefined,
    body: hasBody ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth')) window.dispatchEvent(new Event('workshop:signed-out'));
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status}).`);
  return data as T;
}

// One live stream for the whole app. The server sends topic names; views refetch what changed.
const listeners = new Set<{ topics: Set<string>; fn: () => void }>();
let stream: LiveStream | null = null;
let liveState: 'live' | 'reconnecting' = 'live';
const stateWatchers = new Set<() => void>();

function setLiveState(state: 'live' | 'reconnecting') {
  if (state === liveState) return;
  liveState = state;
  for (const w of stateWatchers) w();
}

function notifyAll() {
  for (const l of listeners) l.fn();
}

function liveStream() {
  stream ??= new LiveStream({
    url: () => '/api/events',
    onMessage: (data) => {
      const { topic } = JSON.parse(data) as { topic: Topic };
      for (const l of listeners) if (l.topics.has(topic)) l.fn();
    },
    // After a reconnect, events may have been missed: refresh everything once.
    onReconnect: notifyAll,
    // A closed stream may mean the session ended: say so, rather than retrying quietly forever.
    onClosed: () => {
      api<AuthState>('/auth/state').then(
        (s) => {
          if (!s.authenticated) window.dispatchEvent(new Event('workshop:signed-out'));
        },
        () => {},
      );
    },
    onState: setLiveState,
  });
  return stream;
}

// Hidden tabs hold no connection (browsers allow few per site, shared by every tab); they refetch when shown.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') stream?.stop();
  else if (listeners.size) liveStream().start();
});
window.addEventListener('online', () => stream?.wake());

export function onTopics(topics: Topic[], fn: () => void) {
  if (!topics.length) return () => {};
  let timer: number | undefined;
  const entry = {
    topics: new Set<string>(topics),
    fn: () => {
      clearTimeout(timer);
      timer = window.setTimeout(fn, 250); // coalesce bursts
    },
  };
  listeners.add(entry);
  if (listeners.size === 1 && document.visibilityState !== 'hidden') liveStream().start();
  return () => {
    clearTimeout(timer);
    listeners.delete(entry);
    if (!listeners.size) {
      stream?.stop();
      setLiveState('live');
    }
  };
}

/** Whether the live update stream is connected. */
export function useLiveState() {
  return useSyncExternalStore(
    (fn) => {
      stateWatchers.add(fn);
      return () => stateWatchers.delete(fn);
    },
    () => liveState,
  );
}

const cache = new Map<string, unknown>();

/** Fetches `path`, refetching whenever one of `topics` changes on the server. */
export function useApi<T>(path: string | null, topics: Topic[] = []) {
  const [data, setData] = useState<T | undefined>(() => (path ? (cache.get(path) as T | undefined) : undefined));
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const reload = useCallback(() => {
    if (!path) return;
    const seq = ++latest.current; // a slow, older response must not overwrite a newer one
    api<T>(path).then(
      (d) => {
        if (seq !== latest.current) return;
        cache.set(path, d);
        setData(d);
        setError(null);
      },
      (e: Error) => seq === latest.current && setError(e.message),
    );
  }, [path]);
  useEffect(reload, [reload]);
  const topicKey = topics.join();
  useEffect(() => onTopics(topicKey ? (topicKey.split(',') as Topic[]) : [], reload), [reload, topicKey]);
  return { data, error, reload };
}

/** Re-renders every `ms` so relative times stay current. */
export function useNow(ms = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
