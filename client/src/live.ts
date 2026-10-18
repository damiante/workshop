/** The parts of EventSource that LiveStream uses, so it can be tested without a browser. */
export interface SourceLike {
  readyState: number;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: string; lastEventId: string }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  addEventListener(type: string, fn: (e: { data: string }) => void): void;
  close(): void;
}

export interface LiveOptions {
  /** Re-read on each connect (the log stream appends ?after=). */
  url: () => string;
  open?: (url: string) => SourceLike;
  onMessage: (data: string, lastEventId: string) => void;
  /** After a drop (or a stop and start), once the new source opens: events may have been missed. */
  onReconnect?: () => void;
  /** The source closed for good (the browser won't retry); LiveStream reconnects itself. */
  onClosed?: () => void;
  /** The server sent `end`: the stream stops and doesn't reconnect. */
  onEnd?: () => void;
  onState?: (state: 'live' | 'reconnecting') => void;
}

export const SILENCE_MS = 40_000;
export const MAX_BACKOFF_MS = 30_000;
const WATCHDOG_MS = 10_000;
const OPEN = 1;
const CLOSED = 2;

/**
 * An EventSource that keeps itself alive. The browser gives up for good after some errors and never
 * notices a connection that silently died, so this reconnects with backoff and watches for silence
 * (the server sends a `ping` event every 15 seconds).
 */
export class LiveStream {
  private opts: LiveOptions;
  private source: SourceLike | null = null;
  private started = false;
  private opened = false; // has any source opened since the first start
  private lastSeen = 0;
  private backoff = 1000;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private watchdog: ReturnType<typeof setInterval> | undefined;

  constructor(opts: LiveOptions) {
    this.opts = opts;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.lastSeen = Date.now();
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastSeen > SILENCE_MS) this.reconnect();
    }, WATCHDOG_MS);
    this.connect();
  }

  stop() {
    this.started = false;
    clearInterval(this.watchdog);
    clearTimeout(this.retry);
    this.source?.close();
    this.source = null;
  }

  /** Reconnects now if the source isn't open or has gone quiet. */
  wake() {
    if (!this.started) return;
    if (this.source?.readyState !== OPEN || Date.now() - this.lastSeen > SILENCE_MS) this.reconnect();
  }

  private reconnect() {
    clearTimeout(this.retry);
    this.source?.close();
    this.source = null;
    this.lastSeen = Date.now();
    this.opts.onState?.('reconnecting');
    this.connect();
  }

  private connect() {
    const source = (this.opts.open ?? ((u) => new EventSource(u) as unknown as SourceLike))(this.opts.url());
    this.source = source;
    const seen = () => {
      if (this.source === source) this.lastSeen = Date.now();
    };
    source.onopen = () => {
      if (this.source !== source) return;
      seen();
      this.backoff = 1000;
      this.opts.onState?.('live');
      if (this.opened) this.opts.onReconnect?.();
      this.opened = true;
    };
    source.onmessage = (e) => {
      if (this.source !== source) return;
      seen();
      this.opts.onMessage(e.data, e.lastEventId);
    };
    source.addEventListener('ping', seen);
    source.addEventListener('end', () => {
      if (this.source !== source) return;
      this.stop();
      this.opts.onEnd?.();
    });
    source.onerror = () => {
      if (this.source !== source) return;
      this.opts.onState?.('reconnecting');
      if (source.readyState !== CLOSED) return; // the browser retries by itself
      this.opts.onClosed?.();
      source.close();
      this.source = null;
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.started && this.connect(), wait);
    };
  }
}

/** Calls fn once, `ms` after the first call of a burst; calls in between join it. */
export function coalesce(fn: () => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    call() {
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        fn();
      }, ms);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

/** Whether a failed request is worth retrying: network errors and 5xx, not 4xx. */
export function retryable(e: unknown): boolean {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status !== 'number' || status >= 500;
}

export function retryDelay(attempt: number): number {
  return Math.min(2000 * 2 ** attempt, MAX_BACKOFF_MS);
}
