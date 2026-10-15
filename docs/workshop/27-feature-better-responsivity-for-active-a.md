# Live updates without refreshing (#27)

## Context

The dashboard's Running card and the sidebar's plan usage bars go stale until you reload the page. Sometimes that lasts minutes. Meanwhile the run page next to them shows "Agent finished" right away. The goal is a client that stays live without refreshes.

What the code does today:

- **The server already publishes these changes.** Every run row change goes through `setRun` (`server/src/scheduler/runner.ts:57`), which calls `publish('runs')`. Every usage reading goes through `recordProbe` or `recordLimit`, which call `publish('allowance')`. `Layout` listens to `allowance` and `runs`; `Dashboard` listens to both as well. The earlier fix on this branch (a trailing publish after a throttled activity update, plus one when the agent finishes) is still correct, but it only covers activity text, and it can't explain stale views that last longer than 3 seconds.
- **The client's single topic stream never recovers.** `client/src/api.ts` opens one `EventSource('/api/events')` per page load and never replaces it:
  - An `EventSource` closes for good (`readyState === CLOSED`, no retry) when a reconnect gets a non-200 answer. Examples are a reverse proxy's 502 while Workshop restarts or its image updates, or a 401. `source` stays non-null, so `connect()` never runs again and every view goes quietly stale.
  - A half-open connection (laptop sleep, Wi-Fi change, NAT or proxy idle drop) delivers nothing, and the browser never notices. The server's 25-second heartbeat is an SSE comment (`: ping`), which JavaScript can't see, so the client can't detect it either.
  - The run page works because `RunView` opens a fresh `EventSource` for the log each time you navigate to it. That is exactly the symptom in the ticket.
- **Smaller gaps that cause the same kind of staleness:**
  - `useApi` lets an older, slower response overwrite a newer one.
  - `/api` responses have no `Cache-Control` header.
  - Some state changes with the clock and is never published: operating hours opening or closing (`withinHours`), a usage-limit block expiring (`blockedUntil`), and the queue's `blockedBy` reasons that depend on them.
  - Daily cleanup deletes old runs without publishing.
  - Each tab also keeps a log stream open for finished runs. On plain HTTP/1.1 the browser allows only 6 connections per origin across all tabs, so a few open tabs can starve new requests.

## Approach

Make the event stream self-healing and observable, and publish the remaining clock-driven changes. No new transport or dependency: SSE and the topic bus stay.

1. **Visible heartbeat.** The server sends a named event (`event: ping`) once when the stream opens and then every 15 seconds, instead of the `: ping` comment.
2. **A client stream supervisor** (`client/src/live.ts`, pure and testable). It owns the one `EventSource` and:
   - reconnects itself whenever the source is `CLOSED`, with backoff of 1, 2, 4… seconds up to 30, reset once a connection opens;
   - runs a watchdog: if nothing (ping or topic) arrives for 40 seconds, it closes the source and reconnects;
   - wakes on `visibilitychange` (becoming visible) and `online`: if the source isn't open, or has been silent for more than 40 seconds, it reconnects now;
   - after every reconnect that follows a drop, refetches every subscribed view once (today's behaviour, now also covering manual reconnects);
   - checks the session when the source closes, by calling `GET /api/auth/state`. If `authenticated` is false, it dispatches `workshop:signed-out` rather than retrying forever;
   - opens when the first listener subscribes and closes when the last one leaves, so signing out doesn't leave a stream retrying in the background;
   - reports `live | reconnecting`, so the sidebar can show a quiet note when updates are paused.
3. **`useApi` ignores out-of-order responses**, using a request counter per hook instance.
4. **`Cache-Control: no-store` on every `/api` response.** This rules out the browser or proxy caching the user suspected. The SSE endpoints send `no-cache, no-transform`, so proxies don't compress or buffer them.
5. **The run log stream can resume after a full reconnect.** A new `EventSource` doesn't send `Last-Event-ID`, so `GET /runs/:id/log` also accepts `?after=<index>`. `RunView` uses the same supervisor (watchdog included) and passes the last index it saw. For a finished run, the server sends `event: end` after the replay and the client closes the stream. That frees the connection.
6. **Clock-driven publishes in the scheduler tick.** A pure `clockTopics(prev, next)` compares a small snapshot (`withinHours`, each connection's `blockedUntil`, and the queue's `[ticketId, blockedBy]` pairs) with the previous tick's and returns the topics to publish: `settings`, `allowance` and `tickets`. `cleanup` publishes `runs` when it deletes any. A tick runs every 60 seconds, so these views lag the clock by at most a minute. That's fine, since the underlying gates are only evaluated per tick anyway.

Not chosen:

- **Polling as a fallback.** The watchdog already detects a dead stream within 40 seconds without the extra load.
- **WebSockets.** Same failure modes, plus more code.
- **Sharing one stream across tabs** (Web Locks plus `BroadcastChannel`). Closing finished log streams covers the common case. See Risks.

## Changes

### `server/src/events.ts`
- `openSse`: headers become `'cache-control': 'no-cache, no-transform'`. After `retry: 3000`, write `event: ping\ndata: {}\n\n` immediately. Replace the comment heartbeat with the same `event: ping` frame every 15 seconds (`HEARTBEAT_MS = 15_000`, exported for tests).
- Return value: keep `send(data, id?)`, and add an optional `event` name: `send(data, id?, event?)` writes `event: <name>\n` first when given.

### `server/src/app.ts`
- Before the `/api` routers: `app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); })`. `openSse` overrides it for streams, because `writeHead` headers win.

### `server/src/http/api.ts`
- `GET /runs/:id/log`: `after = Number(req.get('last-event-id') ?? req.query.after ?? -1)`, with non-numeric values treated as -1. After replaying the lines, if the run's status isn't one of `ACTIVE_STATUSES` (from `runs.ts`), call `send({}, undefined, 'end')` and `res.end()` without subscribing. Otherwise subscribe as today.
  - There's a race when a run ends between the replay and the next publish. It's harmless: the stream stays open, the client sees `runs` and refetches, and the next visit gets `end`.

### `server/src/http/openapi.ts`
- `/events` summary: mention the `ping` event every 15 seconds.
- `/runs/{id}/log`: document the `after` query parameter and the `end` event for finished runs.

### `server/src/scheduler/gates.ts`
- `export interface ClockState { withinHours: boolean; blocks: string; queue: string }`. The strings are JSON fingerprints, so the comparison stays trivial.
- `export function clockTopics(prev: ClockState | null, next: ClockState): Topic[]`. It returns `[]` when `prev` is null (first tick after boot: the browsers fetched fresh data anyway). Otherwise it adds `'settings'` if `withinHours` differs, `'allowance'` if `blocks` differs and `'tickets'` if `queue` differs.

### `server/src/scheduler/loop.ts`
- Module `let clock: ClockState | null = null;`. At the end of the `try` in `tick()`, build `next`:
  - `withinHours: withinHours(s, new Date())`;
  - `blocks: JSON.stringify(allowanceViews().map((a) => [a.connectionId, a.blockedUntil]))`;
  - `queue: JSON.stringify(queue.map((c) => [c.ticket.id, c.blockedBy]))`, from the `queue` the tick already built.

  Then publish each topic from `clockTopics(clock, next)` and set `clock = next`.
- `cleanup`: count the deleted runs and `publish('runs')` if there are any.

### `client/src/live.ts` (new)
A small class with no DOM globals, so it can be tested in Node:

```ts
export interface SourceLike { readyState: number; onopen: ((e: unknown) => void) | null; onmessage: ((e: { data: string; lastEventId: string }) => void) | null; onerror: ((e: unknown) => void) | null; addEventListener(type: string, fn: (e: { data: string }) => void): void; close(): void }
export interface LiveOptions {
  url: () => string;                         // re-read on each connect (the log stream appends ?after=)
  open?: (url: string) => SourceLike;        // default: (u) => new EventSource(u)
  onMessage: (data: string, lastEventId: string) => void;
  onReconnect?: () => void;                  // after a drop, once the new source opens
  onClosed?: () => void;                     // the source closed for good (api.ts checks the session)
  onEnd?: () => void;                        // server sent `end`; the stream stops for good
  onState?: (state: 'live' | 'reconnecting') => void;
}
export class LiveStream { constructor(opts: LiveOptions); start(): void; stop(): void; wake(): void }
```

- `start()` opens the source and starts the watchdog interval (every 10 seconds, checking `Date.now() - lastSeen > 40_000`).
- Any `open`, `message` or `ping` sets `lastSeen`.
- `onerror` sets the state to `reconnecting`. If `readyState === 2` (CLOSED), it calls `onClosed`, then schedules a reconnect after the current backoff.
- `onopen` resets the backoff, sets the state to `live`, and calls `onReconnect` if this isn't the first open.
- The `end` listener calls `stop()`, then `onEnd`.
- `wake()` reconnects immediately (backoff reset) if the source isn't OPEN or `lastSeen` is stale.
- Constants: `SILENCE_MS = 40_000`, `MAX_BACKOFF_MS = 30_000`.

### `client/src/api.ts`
- Replace `source`/`connect()` with a lazily created `LiveStream` for `/api/events`:
  - `onMessage`: parse `{ topic }` and notify listeners as today.
  - `onReconnect`: call every listener's `fn`.
  - `onClosed`: `api<AuthState>('/auth/state').then((s) => { if (!s.authenticated) window.dispatchEvent(new Event('workshop:signed-out')); }, () => {})`.
  - `onState`: store the state and notify `useLiveState` subscribers.
- `onTopics`: start the stream when `listeners` goes from 0 to 1, and stop it when the set empties again.
- Register `visibilitychange` (when `document.visibilityState === 'visible'`) and `online` listeners once, at module level, calling `stream?.wake()`.
- `export function useLiveState(): 'live' | 'reconnecting'`: `useSyncExternalStore` over the stored state.
- `useApi.reload`: `const seq = ++latest.current;` and apply the result or error only if `seq === latest.current` (`latest = useRef(0)`).

### `client/src/pages/RunView.tsx`
- Replace the raw `EventSource` with `new LiveStream({ url: () => `/api/runs/${id}/log${last >= 0 ? `?after=${last}` : ''}`, onMessage: (data, lastEventId) => { last = Number(lastEventId); addEntry(...) } })`, with `let last = -1` inside the effect. Keep the `requestAnimationFrame` batching. Call `start()` in the effect and `stop()` in its cleanup.
- Wire `visibilitychange` to `wake()` inside the same effect, removing the listener in the cleanup.
- Update the comment about `Last-Event-ID`.

### `client/src/components/Layout.tsx`
- `const live = useLiveState();`. When it has been `reconnecting` for more than 5 seconds (a timer in a `useEffect`, so brief blips don't flash), show `<span className="muted small">Live updates paused. Reconnecting…</span>` in the sidebar under the allowance meters. On phones it sits wherever the meters sit in the bottom bar; if there's no room, hide it under 760px with the existing media query. No new colours, no animation.

### Docs
- `client/AGENTS.md`, data flow: the stream reconnects itself (watchdog, backoff, wake on visibility); `useApi` drops out-of-order responses; the log stream resumes with `?after=` and closes on `end`.
- `server/AGENTS.md`: the `events.ts` row mentions the visible `ping` heartbeat. Under Invariants: "Any state change a view shows must `publish` its topic. Clock-driven state goes through `clockTopics` in the tick."

## Data and interfaces

- No schema change and no new topic.
- `GET /api/events`: adds `event: ping` frames (`data: {}`) on open and every 15 seconds. Consumers using `onmessage` don't see them.
- `GET /api/runs/:id/log`: new optional `?after=<index>`, with the `Last-Event-ID` header taking precedence. A finished run's stream ends with `event: end` and closes.
- Every `/api` response carries `Cache-Control: no-store`; SSE responses carry `no-cache, no-transform`.

## Tests

Server (`npm test --workspace server`):

- `test/gates.test.ts`, `clockTopics`:
  - null `prev` returns `[]`;
  - each field change returns its topic;
  - no change returns `[]`;
  - several changes return several topics.
- `test/api.test.ts`. For the streams, start the app with `app.listen(0)`, read with `fetch` plus a reader, and abort:
  - `GET /api/overview` has `cache-control: no-store`;
  - `GET /api/events` returns `content-type: text/event-stream`, `cache-control` containing `no-transform`, and its first chunks include `event: ping`;
  - `GET /api/runs/:id/log` for a run inserted as `succeeded`, with a log of two lines written via `appendLog`, replays both and ends with `event: end`, and the response finishes;
  - the same request with `?after=0` replays only the second line;
  - for a `running` run, the stream stays open (the read hasn't finished after replay, then abort).
- `test/pipeline.test.ts`: keep the existing throttled-activity test. If the loop is already exercised there, add a test that `cleanup` publishes `runs` when it deletes an old run; otherwise put it in `api.test.ts` with direct rows.

Client (`npm test --workspace client`), new `client/test/live.test.ts` with `vi.useFakeTimers()` and a fake `SourceLike` factory recording each opened URL:

- a CLOSED error reconnects after 1 second, then 2 seconds, and the backoff resets after `onopen`;
- `onReconnect` is called on the second open, not the first;
- 40 seconds without messages closes the source and opens a new one; regular `ping`s prevent that;
- `wake()` reconnects at once when the source is closed or stale, and does nothing when it's live;
- `onClosed` fires on a CLOSED error; `end` stops the stream with no reconnect, and `onEnd` fires;
- `url()` is re-read on reconnect (so `?after=` follows the last id).

Then `npm run typecheck` and `npm test` from the root. A manual check: open the dashboard, restart the server behind a proxy (or kill `dev:server` for 10 seconds), and confirm the sidebar note appears and the Running card updates without a reload once a run finishes.

## Risks and open questions

- **The diagnosis is inferred, not reproduced** against the owner's deployment, which we can't see. These fixes cover every way we found for the stream to die silently. The sidebar note makes any remaining gap visible: if views go stale while it says nothing, the stream is alive but events are missing, which points to a publish gap rather than transport.
- **HTTP/1.1 connection limit.** On plain HTTP the browser allows 6 connections per origin, shared by all tabs, and each Workshop tab holds one or two streams. Closing finished log streams helps. HTTPS through a proxy (as the README recommends) usually means HTTP/2, which removes the limit. If it still bites, a follow-up can share one stream across tabs with Web Locks plus `BroadcastChannel`.
- **Clock-driven changes lag by up to a tick (60 seconds).** That's acceptable, because launches follow the same tick.
- **#25** adds the settings topic and the pending buttons for operation modes. This design doesn't touch those buttons. If #25 lands first, `clockTopics`' `settings` publish fits alongside it unchanged.
