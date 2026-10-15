import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveStream, MAX_BACKOFF_MS, coalesce, retryDelay, retryable, SILENCE_MS, type LiveOptions, type SourceLike } from '../src/live.ts';

class FakeSource implements SourceLike {
  readyState = 0;
  onopen: SourceLike['onopen'] = null;
  onmessage: SourceLike['onmessage'] = null;
  onerror: SourceLike['onerror'] = null;
  closed = false;
  private handlers = new Map<string, (e: { data: string }) => void>();
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, fn: (e: { data: string }) => void) {
    this.handlers.set(type, fn);
  }
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  fail(final: boolean) {
    this.readyState = final ? 2 : 0;
    this.onerror?.({});
  }
  emit(type: string, data = '{}') {
    this.handlers.get(type)?.({ data });
  }
}

let sources: FakeSource[];
const calls = { reconnect: 0, closed: 0, end: 0, messages: [] as string[], states: [] as string[] };
const make = (over: Partial<LiveOptions> = {}) =>
  new LiveStream({
    url: () => '/events',
    open: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s;
    },
    onMessage: (d) => calls.messages.push(d),
    onReconnect: () => calls.reconnect++,
    onClosed: () => calls.closed++,
    onEnd: () => calls.end++,
    onState: (s) => calls.states.push(s),
    ...over,
  });
const last = () => sources[sources.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  sources = [];
  Object.assign(calls, { reconnect: 0, closed: 0, end: 0, messages: [], states: [] });
});
afterEach(() => vi.useRealTimers());

describe('LiveStream', () => {
  it('reconnects after a closed source with growing backoff, reset once open', () => {
    const live = make();
    live.start();
    last().open();
    last().fail(true);
    expect(calls.closed).toBe(1);
    vi.advanceTimersByTime(999);
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(2);
    last().fail(true);
    vi.advanceTimersByTime(1999);
    expect(sources).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sources).toHaveLength(3);
    last().open();
    last().fail(true);
    vi.advanceTimersByTime(1000);
    expect(sources).toHaveLength(4);
    live.stop();
  });

  it('caps the backoff', () => {
    const live = make();
    live.start();
    for (let i = 0; i < 10; i++) {
      last().fail(true);
      vi.advanceTimersByTime(MAX_BACKOFF_MS);
    }
    const n = sources.length;
    last().fail(true);
    vi.advanceTimersByTime(MAX_BACKOFF_MS);
    expect(sources).toHaveLength(n + 1);
    live.stop();
  });

  it('calls onReconnect on the second open, not the first', () => {
    const live = make();
    live.start();
    last().open();
    expect(calls.reconnect).toBe(0);
    last().fail(true);
    vi.advanceTimersByTime(1000);
    last().open();
    expect(calls.reconnect).toBe(1);
    expect(calls.states.at(-1)).toBe('live');
    live.stop();
  });

  it('leaves a browser-retried error alone', () => {
    const live = make();
    live.start();
    last().open();
    last().fail(false);
    vi.advanceTimersByTime(5000);
    expect(sources).toHaveLength(1);
    expect(calls.closed).toBe(0);
    expect(calls.states.at(-1)).toBe('reconnecting');
    live.stop();
  });

  it('reconnects after silence, but not while pings arrive', () => {
    const live = make();
    live.start();
    last().open();
    for (let t = 0; t < SILENCE_MS * 2; t += 15_000) {
      vi.advanceTimersByTime(15_000);
      last().emit('ping');
    }
    expect(sources).toHaveLength(1);
    vi.advanceTimersByTime(SILENCE_MS + 10_000);
    expect(sources).toHaveLength(2);
    expect(sources[0].closed).toBe(true);
    live.stop();
  });

  it('wakes at once when the source is closed or stale, not when live', () => {
    const live = make();
    live.start();
    last().open();
    live.wake();
    expect(sources).toHaveLength(1);
    last().readyState = 0;
    live.wake();
    expect(sources).toHaveLength(2);
    last().open();
    vi.setSystemTime(Date.now() + SILENCE_MS + 1);
    live.wake();
    expect(sources).toHaveLength(3);
    live.stop();
  });

  it('stops cleanly, and a later start counts as a reconnect', () => {
    const live = make();
    live.start();
    last().open();
    live.stop();
    expect(sources[0].closed).toBe(true);
    vi.advanceTimersByTime(SILENCE_MS * 3);
    expect(sources).toHaveLength(1);
    expect(calls.closed).toBe(0);
    expect(calls.states).not.toContain('reconnecting');
    live.start();
    expect(sources).toHaveLength(2);
    last().open();
    expect(calls.reconnect).toBe(1);
    live.stop();
  });

  it('stop cancels a pending reconnect', () => {
    const live = make();
    live.start();
    last().fail(true);
    live.stop();
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(1);
  });

  it('stops for good on end', () => {
    const live = make();
    live.start();
    last().open();
    last().emit('end');
    expect(calls.end).toBe(1);
    vi.advanceTimersByTime(SILENCE_MS * 3);
    expect(sources).toHaveLength(1);
  });

  it('re-reads the url on reconnect and passes messages through', () => {
    let after = -1;
    const live = make({ url: () => `/log${after >= 0 ? `?after=${after}` : ''}`, onMessage: (d, id) => (after = Number(id), calls.messages.push(d)) });
    live.start();
    last().open();
    last().onmessage?.({ data: 'a', lastEventId: '4' });
    last().fail(true);
    vi.advanceTimersByTime(1000);
    expect(last().url).toBe('/log?after=4');
    expect(calls.messages).toEqual(['a']);
    live.stop();
  });
});

describe('coalesce', () => {
  it('calls once, 250 ms after the first call of a burst', () => {
    const fn = vi.fn();
    const c = coalesce(fn, 250);
    c.call();
    vi.advanceTimersByTime(100);
    c.call();
    vi.advanceTimersByTime(100);
    c.call();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('is not postponed by a steady flow of calls', () => {
    const fn = vi.fn();
    const c = coalesce(fn, 250);
    for (let t = 0; t < 2000; t += 100) {
      c.call();
      vi.advanceTimersByTime(100);
    }
    expect(fn.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it('cancel stops a pending call', () => {
    const fn = vi.fn();
    const c = coalesce(fn, 250);
    c.call();
    c.cancel();
    vi.advanceTimersByTime(1000);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('retry helpers', () => {
  it('retries network errors and 5xx, not 4xx', () => {
    expect(retryable(new Error('Failed to fetch'))).toBe(true);
    expect(retryable({ status: 502 })).toBe(true);
    expect(retryable({ status: 404 })).toBe(false);
    expect(retryable({ status: 401 })).toBe(false);
  });

  it('backs off from 2 seconds up to the cap', () => {
    expect([0, 1, 2].map(retryDelay)).toEqual([2000, 4000, 8000]);
    expect(retryDelay(20)).toBe(MAX_BACKOFF_MS);
  });
});
