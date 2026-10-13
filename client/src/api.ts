import { useCallback, useEffect, useState } from 'react';
import type { Topic } from '../../server/src/api-types.ts';

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

// One EventSource for the whole app. The server sends topic names; views refetch what changed.
let source: EventSource | null = null;
const listeners = new Set<{ topics: Set<string>; fn: () => void }>();

function connect() {
  source = new EventSource('/api/events');
  source.onmessage = (event) => {
    const { topic } = JSON.parse(event.data) as { topic: Topic };
    for (const l of listeners) if (l.topics.has(topic)) l.fn();
  };
  // After a reconnect, events may have been missed: refresh everything once.
  let opened = false;
  source.onopen = () => {
    if (opened) for (const l of listeners) l.fn();
    opened = true;
  };
}

export function onTopics(topics: Topic[], fn: () => void) {
  if (!topics.length) return () => {};
  if (!source) connect();
  let timer: number | undefined;
  const entry = {
    topics: new Set<string>(topics),
    fn: () => {
      clearTimeout(timer);
      timer = window.setTimeout(fn, 250); // coalesce bursts
    },
  };
  listeners.add(entry);
  return () => {
    clearTimeout(timer);
    listeners.delete(entry);
  };
}

const cache = new Map<string, unknown>();

/** Fetches `path`, refetching whenever one of `topics` changes on the server. */
export function useApi<T>(path: string | null, topics: Topic[] = []) {
  const [data, setData] = useState<T | undefined>(() => (path ? (cache.get(path) as T | undefined) : undefined));
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    if (!path) return;
    api<T>(path).then(
      (d) => {
        cache.set(path, d);
        setData(d);
        setError(null);
      },
      (e: Error) => setError(e.message),
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
