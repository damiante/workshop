# Live updates without refreshing (#27)

## Context

The dashboard's Running card and the sidebar's plan usage bars go stale until you reload the page. Sometimes that lasts minutes. Meanwhile the run page next to them shows "Agent finished" right away. The goal is a client that stays live without refreshes.

## Dashboard and run page compared

The owner confirmed that the run page's log reliably shows new lines, and asked whether the dashboard now uses the same method. With this branch, the **connection** is the same, but **what an event carries** is different, and some of that difference can't be removed.

| | Run page log | Dashboard (Running card, usage bars) |
|---|---|---|
| Stream | `GET /api/runs/:id/log`, one per open run page | `GET /api/events`, one per tab, shared by every view |
| Server side | `openSse`: `ping` on open and every 15 s, `no-cache, no-transform` | the same `openSse` |
| Client side | a `LiveStream` (backoff, 40 s watchdog, released while hidden) | a `LiveStream` with the same settings |
| What an event carries | the data itself: one log line with its index | only a topic name (`runs`, `allowance`, …) |
| After an event | the line is appended; nothing else can fail | `onTopics` waits out a 250 ms debounce, then `useApi` refetches `/api/overview` |
| After a drop | reconnects with `?after=<last index>` and replays exactly what it missed | reconnects and refetches every view once |
| What it shows | everything Claude prints, as it prints it | the run's **status** and last tool call, which only change at step boundaries |

So the dashboard adds a second step that the log doesn't have: a refetch after each event. On this branch, that step still has three weaknesses the log stream doesn't share:

- **A failed refetch is never retried.** If `/api/overview` fails (a network blip, a proxy 502 during a restart, a timeout), `useApi` stores the error. The Dashboard ignores the error once it has data, so the card keeps its old content until the *next* event, which may be minutes away. After a drop, the log stream retries until it has caught up.
- **The debounce can postpone indefinitely.** `onTopics` restarts its 250 ms timer on every event. The Dashboard listens to 8 topics, so with several agents running (each publishing `runs` up to every 3 seconds, plus `tickets`, `allowance` and `connections`), a steady stream of events closer than 250 ms apart keeps pushing the refetch back.
- **The card means something different from "The agent finished."** That transcript line is Claude's `result` event. After it, the container still has to exit, and then the run is `publishing` (push, pull request, labels, comment) until it settles. The card correctly lists the run until then, but it says "Working", with the last tool call as activity, until the container exits. To someone watching both screens, that looks like lag.

**Why the dashboard can't be aligned completely.** The log is one append-only sequence per run: each event is self-contained, and an index is enough to resume. The dashboard shows derived state from several tables: the queue with its gate reasons, hosts, needs-you, alerts and the allowance meters. The server computes these in `/api/overview`. To push data, the server would have to send the whole overview to every tab on every event (up to every 3 seconds per running agent), or the client would have to repeat the server's gate logic. Pushing only the Running card would give the page two sources of truth for the same response, and they could arrive out of order. Notify-then-refetch is the right model here.

**What aligns instead are the guarantees.** The transport is already shared (above). Approach items 8 to 10 give the refetch step the log stream's properties: it retries until it succeeds, its delay is bounded, and the card shows the moment the agent finishes, just as the log does.

What the code does today:

- **The server already publishes these changes.** Every run row change goes through `setRun` (`server/src/scheduler/runner.ts:57`), which calls `publish('runs')`. Every usage reading goes through `recordProbe` or `recordLimit`, which call `publish('allowance')`. `Layout` listens to `allowance` and `runs`; `Dashboard` listens to both as well. The earlier fix on this branch (a trailing publish after a throttled activity update, plus one when the agent finishes) is still correct, but it only covers activity text, and it can't explain stale views that last longer than 3 seconds.
- **The run page's evidence doesn't show the topic stream is working.** "The agent finished." on the run page is a transcript entry (`client/src/transcript.ts:103`, the agent's `result` line) from the run's *log* stream (`/api/runs/:id/log`), not a `runs` refetch. So the run page and the Running card are fed by different connections, and the ticket only tells us that the log connection worked.
- **Browser connection starvation is the leading suspect for "stale until refresh".** Express serves HTTP/1.1. Opened directly (`http://host:3000` on a LAN, which the README allows), the browser allows 6 connections per host, shared by every tab in the profile, and an `EventSource` holds one for as long as it's open. Each Workshop tab holds the topic stream, and a run page also holds that run's log stream. The log stream never closes, even for a run that finished hours ago. Three tabs on run pages use all 6 connections. Five dashboard tabs use 5, which leaves every `fetch` queued behind one slot. In that state topic events still arrive, but the refetches they trigger wait in the browser's queue. They finish late ("takes longer") or not at all, until a reload closes that tab's streams and frees its slots ("or a refresh"). The same thing explains the usage bars: the `allowance` event arrives, but `/overview` can't be fetched.
- **The client's single topic stream never recovers.** `client/src/api.ts` opens one `EventSource('/api/events')` per page load and never replaces it:
  - An `EventSource` closes for good (`readyState === CLOSED`, no retry) when a reconnect gets a non-200 answer. Examples are a reverse proxy's 502 while Workshop restarts or its image updates, or a 401. `source` stays non-null, so `connect()` never runs again and every view goes quietly stale.
  - A half-open connection (laptop sleep, Wi-Fi change, NAT or proxy idle drop) delivers nothing, and the browser never notices. The server's 25-second heartbeat is an SSE comment (`: ping`), which JavaScript can't see, so the client can't detect it either.
  - The run page works because `RunView` opens a fresh `EventSource` for the log each time you navigate to it. That is exactly the symptom in the ticket.
- **Smaller gaps that cause the same kind of staleness:**
  - `useApi` lets an older, slower response overwrite a newer one.
  - `/api` responses have no `Cache-Control` header.
  - Some state changes with the clock and is never published: operating hours opening or closing (`withinHours`), a usage-limit block expiring (`blockedUntil`), and the queue's `blockedBy` reasons that depend on them.
  - Daily cleanup deletes old runs without publishing.
  - A run reports its subscription usage only once: `runner.ts` calls `recordProbe` on the *first* `rate_limit_event` (`!hadUsage`). Later events update `claude.usage` in memory, but nothing records them, so the plan usage bars stay at the run-start reading for the whole run, which can last up to the agent's timeout. No transport fix can show a reading the server never stores.

## Approach

Keep each tab's connection use small, make the event stream self-healing and observable, and publish or record the remaining changes. No new transport or dependency: SSE and the topic bus stay.

0. **Hidden tabs release their streams.** When `document.visibilityState` becomes `hidden`, the topic stream and the run log stream close at once. When the tab becomes visible again, they reopen, and the topic stream refetches every subscribed view (the log resumes with `?after=`). Background tabs then hold no connections, so the 6-connection budget is shared only by tabs you can see. Combined with item 5, a visible tab holds one stream, or two while it shows an active run.

1. **Visible heartbeat.** The server sends a named event (`event: ping`) once when the stream opens and then every 15 seconds, instead of the `: ping` comment.
2. **A client stream supervisor** (`client/src/live.ts`, pure and testable). It owns the one `EventSource` and:
   - reconnects itself whenever the source is `CLOSED`, with backoff of 1, 2, 4… seconds up to 30, reset once a connection opens;
   - runs a watchdog: if nothing (ping or topic) arrives for 40 seconds, it closes the source and reconnects;
   - has `stop()` and `start()`, which the callers use for item 0 (a `start()` after a `stop()` counts as a reconnect, so views refetch);
   - wakes on `online`: if the source isn't open, or has been silent for more than 40 seconds, it reconnects now;
   - after every reconnect that follows a drop, refetches every subscribed view once (today's behaviour, now also covering manual reconnects);
   - checks the session when the source closes, by calling `GET /api/auth/state`. If `authenticated` is false, it dispatches `workshop:signed-out` rather than retrying forever;
   - opens when the first listener subscribes and closes when the last one leaves, so signing out doesn't leave a stream retrying in the background;
   - reports `live | reconnecting`, so the sidebar can show a quiet note when updates are paused.
3. **`useApi` ignores out-of-order responses**, using a request counter per hook instance.
4. **`Cache-Control: no-store` on every `/api` response.** This rules out the browser or proxy caching the user suspected. The SSE endpoints send `no-cache, no-transform`, so proxies don't compress or buffer them.
5. **The run log stream can resume after a full reconnect.** A new `EventSource` doesn't send `Last-Event-ID`, so `GET /runs/:id/log` also accepts `?after=<index>`. `RunView` uses the same supervisor (watchdog included) and passes the last index it saw. For a finished run, the server sends `event: end` after the replay and closes the stream. For a run that is still active, the server also listens for `runs` on the topic bus, and once the run leaves `ACTIVE_STATUSES` it sends `end` and closes. Every log stream is released when its run finishes, even if the page stays open.
6. **Runs record every usage change.** In `runner.ts`, call `recordProbe` whenever a `rate_limit_event` changes either window's `pct` or `resetsAt` from the last reading this run recorded, at most once every 30 seconds per run, plus a final record when the run's container exits if anything is still unrecorded. Each record publishes `allowance` as today. Samples are pruned after 8 days already, and change-only recording keeps the table small.
7. **Clock-driven publishes in the scheduler tick.** A pure `clockTopics(prev, next)` compares a small snapshot (`withinHours`, each connection's `blockedUntil`, and the queue's `[ticketId, blockedBy]` pairs) with the previous tick's and returns the topics to publish: `settings`, `allowance` and `tickets`. `cleanup` publishes `runs` when it deletes any. A tick runs every 60 seconds, so these views lag the clock by at most a minute. That's fine, since the underlying gates are only evaluated per tick anyway.
8. **Refetches retry until they succeed, like the log stream reconnects.** When a `useApi` refetch fails with a network error or a 5xx, it retries after 2, 4, 8… seconds, up to 30 seconds, until it succeeds, a newer request replaces it, or the component unmounts. Errors that a retry won't fix (4xx, including 401, which already signs out) aren't retried.
9. **Bounded coalescing.** `onTopics` throttles instead of debouncing: the first event of a burst schedules a refetch in 250 ms, and further events before then join it. Events that arrive while that refetch is in flight schedule one more, and `useApi`'s request counter keeps the newest response. The card then updates at most about 250 ms plus one request after any change.
10. **The card shows when the agent finishes.** When the runner reads Claude's `result` line, it sets the run's activity to the same words the transcript uses ("The agent finished.", or "The agent stopped with an error.") and publishes `runs` straight away, bypassing the 3-second activity throttle. The card then says the same as the log at the same moment. It moves on to "Publishing" once the container exits, and leaves the Running card when the run settles.

Not chosen:

- **Polling as a fallback.** The watchdog already detects a dead stream within 40 seconds without the extra load.
- **WebSockets.** Same failure modes, plus more code.
- **Pushing the Running card's data on the event stream** (a `runs` event carrying the active runs). See "Why the dashboard can't be aligned completely" above. It would add a second source of truth to the page for the same response. Items 8 to 10 remove the failures the extra step adds.
- **Sharing one stream across tabs** (Web Locks plus `BroadcastChannel`). Releasing hidden tabs and closing finished log streams cover the common case with much less code. See Risks.
- **Folding the log stream into `/api/events`** (one connection per tab). This saves a connection only while an active run is on screen, and it costs a per-connection subscription protocol.

## Changes

### `server/src/events.ts`
- `openSse`: headers become `'cache-control': 'no-cache, no-transform'`. After `retry: 3000`, write `event: ping\ndata: {}\n\n` immediately. Replace the comment heartbeat with the same `event: ping` frame every 15 seconds (`HEARTBEAT_MS = 15_000`, exported for tests).
- Return value: keep `send(data, id?)`, and add an optional `event` name: `send(data, id?, event?)` writes `event: <name>\n` first when given.

### `server/src/app.ts`
- Before the `/api` routers: `app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); })`. `openSse` overrides it for streams, because `writeHead` headers win.

### `server/src/http/api.ts`
- `GET /runs/:id/log`: `after = Number(req.get('last-event-id') ?? req.query.after ?? -1)`, with non-numeric values treated as -1. After replaying the lines, if the run's status isn't one of `ACTIVE_STATUSES` (from `runs.ts`), call `send({}, undefined, 'end')` and `res.end()` without subscribing. Otherwise subscribe to `logBus` as today, and also to `bus` `'topic'`. On `'runs'`, if `getRun(id)` is gone or not active, send `end` and `res.end()`. The `openSse` close callback removes both listeners.
  - `setRun` publishes `runs` for the final status change, after the last log line has been appended, so `end` never cuts off the tail of the log.

### `server/src/http/openapi.ts`
- `/events` summary: mention the `ping` event every 15 seconds.
- `/runs/{id}/log`: document the `after` query parameter and the `end` event for finished runs.

### `server/src/scheduler/runner.ts`
- In the `run` step's stdout callback, replace the `!hadUsage` check. Keep `let recorded = ''` and `let recordedAt = 0`. When `claude.usage` is set and `JSON.stringify(claude.usage) !== recorded` and `Date.now() - recordedAt >= 30_000`, call `recordProbe` and update both. After `runContainer` returns, record once more if `JSON.stringify(claude.usage) !== recorded`. Only subscription runs with a `model_connection_id` record, as today.

- Also in that stdout callback: keep `let finished = false`. The first time `claude.result` is set, set `finished = true`, then `activity.set(r.id, claude.result.isError ? 'The agent stopped with an error.' : 'The agent finished.')`, `clearTimeout(trailing)`, `trailing = undefined`, `lastPublished = Date.now()` and `publish('runs')`. The existing `activity.delete(r.id)` after the container exits stays.

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

- `start()` opens the source and starts the watchdog interval (every 10 seconds, checking `Date.now() - lastSeen > 40_000`). It does nothing if already started. A `start()` after an earlier open calls `onReconnect` when the new source opens.
- `stop()` closes the source and clears every timer (watchdog and pending reconnect). It doesn't call `onClosed` or change the state to `reconnecting`.
- Any `open`, `message` or `ping` sets `lastSeen`.
- `onerror` sets the state to `reconnecting`. If `readyState === 2` (CLOSED), it calls `onClosed`, then schedules a reconnect after the current backoff.
- `onopen` resets the backoff, sets the state to `live`, and calls `onReconnect` if this isn't the first open.
- The `end` listener calls `stop()`, then `onEnd`.
- `wake()` reconnects immediately (backoff reset) if the source isn't OPEN or `lastSeen` is stale.
- Constants: `SILENCE_MS = 40_000`, `MAX_BACKOFF_MS = 30_000`.

### `client/src/live.ts`, additions for the refetch step
Pure helpers, tested in Node like `LiveStream`:

```ts
/** Calls fn once, `ms` after the first call of a burst; calls in between join it. */
export function coalesce(fn: () => void, ms: number): { call(): void; cancel(): void };
/** Whether a failed request is worth retrying: network errors and 5xx, not 4xx. */
export function retryable(e: unknown): boolean; // true unless e has a numeric `status` below 500
export function retryDelay(attempt: number): number; // min(2000 * 2 ** attempt, MAX_BACKOFF_MS)
```

`retryable` checks a `status` property rather than `instanceof ApiError`, so `live.ts` doesn't import `api.ts`, whose module-level listeners need a DOM.

### `client/src/api.ts`
- Replace `source`/`connect()` with a lazily created `LiveStream` for `/api/events`:
  - `onMessage`: parse `{ topic }` and notify listeners as today.
  - `onReconnect`: call every listener's `fn`.
  - `onClosed`: `api<AuthState>('/auth/state').then((s) => { if (!s.authenticated) window.dispatchEvent(new Event('workshop:signed-out')); }, () => {})`.
  - `onState`: store the state and notify `useLiveState` subscribers.
- `onTopics`: start the stream when `listeners` goes from 0 to 1, and stop it when the set empties again.
- Register `visibilitychange` and `online` listeners once, at module level. Hidden: `stream?.stop()`. Visible: `stream?.start()` if there are listeners. `online`: `stream?.wake()`. Don't open the stream at all while the page loads hidden.
- `export function useLiveState(): 'live' | 'reconnecting'`: `useSyncExternalStore` over the stored state.
- `onTopics`: `entry.fn` becomes `coalesce(fn, 250).call` (keep the `cancel` for the unsubscribe), instead of the clear-and-restart timer.
- `useApi.reload`: on failure, if `retryable(e)` and `seq === latest.current`, set a retry timer (`retry = useRef<number>()`) for `retryDelay(attempt++)` that repeats the same request, still checking `seq`. Each new `reload` clears the pending retry. The mount effect's cleanup increments `latest.current` and clears the timer, so an unmounted view stops retrying. `setError` behaves as today.
- `useApi.reload`: `const seq = ++latest.current;` and apply the result or error only if `seq === latest.current` (`latest = useRef(0)`).

### `client/src/pages/RunView.tsx`
- Replace the raw `EventSource` with `new LiveStream({ url: () => `/api/runs/${id}/log${last >= 0 ? `?after=${last}` : ''}`, onMessage: (data, lastEventId) => { last = Number(lastEventId); addEntry(...) } })`, with `let last = -1` inside the effect. Keep the `requestAnimationFrame` batching. Call `start()` in the effect and `stop()` in its cleanup.
- Wire `visibilitychange` in the same effect: hidden calls `stop()`, visible calls `start()`. `onEnd` sets a local `ended = true` so a later visible event doesn't reopen a finished run's log. Remove the listener in the cleanup.
- Update the comment about `Last-Event-ID`.

### `client/src/components/Layout.tsx`
- `const live = useLiveState();`. When it has been `reconnecting` for more than 5 seconds (a timer in a `useEffect`, so brief blips don't flash), show `<span className="muted small">Live updates paused. Reconnecting…</span>` in the sidebar under the allowance meters. On phones it sits wherever the meters sit in the bottom bar; if there's no room, hide it under 760px with the existing media query. No new colours, no animation.

### Docs
- `client/AGENTS.md`, data flow: the stream reconnects itself (watchdog, backoff, wake on visibility); `useApi` drops out-of-order responses; the log stream resumes with `?after=` and closes on `end`.
- `client/AGENTS.md`, data flow: add one line on the two models: the log pushes data and resumes by index; views get topic notices and refetch, coalesced at most 250 ms, with failed refetches retried. Keep both on `LiveStream`.
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
  - for a `running` run, updating its status to `succeeded` and calling `publish('runs')` ends the stream with `event: end`;
- `test/pipeline.test.ts`:
  - a run whose stdout has two `rate_limit_event`s with different utilization, 30 seconds apart under fake timers or with the clock mocked, leaves two probe samples, and the latest `allowanceOf` matches the second event. Two identical events leave one sample;
  - a run whose stdout ends with a `result` line: a `bus` listener that reads `runViews()` on each `runs` topic sees the run with `status: 'running'` and `activity: 'The agent finished.'` (proves the card shows it before the container exits). With `is_error: true`, it sees `'The agent stopped with an error.'`;
  - keep the existing throttled-activity test.
  - if the loop is already exercised there, a test that `cleanup` publishes `runs` when it deletes an old run (otherwise in `api.test.ts` with direct rows).

Client (`npm test --workspace client`), new `client/test/live.test.ts` with `vi.useFakeTimers()` and a fake `SourceLike` factory recording each opened URL:

- a CLOSED error reconnects after 1 second, then 2 seconds, and the backoff resets after `onopen`;
- `onReconnect` is called on the second open, not the first;
- 40 seconds without messages closes the source and opens a new one; regular `ping`s prevent that;
- `wake()` reconnects at once when the source is closed or stale, and does nothing when it's live;
- `stop()` closes the source, and no reconnect or watchdog fires afterwards. A later `start()` opens a new source and calls `onReconnect` once it opens;
- `onClosed` fires on a CLOSED error; `end` stops the stream with no reconnect, and `onEnd` fires;
- `url()` is re-read on reconnect (so `?after=` follows the last id).
- `coalesce`: three calls 100 ms apart call `fn` once, 250 ms after the first call. Calls that keep arriving every 100 ms for 2 seconds still call `fn` about every 250 ms (this is the starvation bug in the old debounce). `cancel()` stops a pending call;
- `retryable`: true for a plain `Error` (network) and for `{ status: 502 }`, false for `{ status: 404 }` and `{ status: 401 }`;
- `retryDelay`: 2000, 4000, 8000… capped at `MAX_BACKOFF_MS`.

Then `npm run typecheck` and `npm test` from the root. Manual checks: open five Workshop tabs over plain `http://` (three of them on run pages), and confirm the visible dashboard's Running card still updates when a run finishes. Then open the dashboard, restart the server behind a proxy (or kill `dev:server` for 10 seconds), and confirm the sidebar note appears and the Running card updates without a reload once a run finishes.

Manual check for the comparison: open the dashboard and a run page side by side on an active run. When the transcript shows "The agent finished.", the card should show the same text within about a second, then "Publishing", then leave the Running card when the run settles. Stop the server for 10 seconds while a refetch is due: the card should catch up within about 30 seconds of the server's return, with no event needed.

## Risks and open questions

- **The diagnosis is inferred, not reproduced** against the owner's deployment, which we can't see. These fixes cover every way we found for the stream to die silently. The sidebar note makes any remaining gap visible: if views go stale while it says nothing, the stream is alive but events are missing, which points to a publish gap rather than transport.
- **HTTP/1.1 connection limit.** Once hidden tabs release their streams and finished log streams close, only several visible windows side by side, each on an active run, can reach 6. HTTPS through a proxy (as the README recommends) usually means HTTP/2, which removes the limit. If it still bites, a follow-up can share one stream across tabs with Web Locks plus `BroadcastChannel`.
- **A quick way for the owner to confirm the cause:** with several Workshop tabs open over plain HTTP, the browser's network panel shows dashboard refetches stuck as "Pending" or "Stalled" while the topic stream's EventStream tab still receives events. If that's what happened, the hidden-tab release fixes it.
- **Reopen cost on tab switches.** Each switch back to a Workshop tab refetches its views once (about four small requests on the dashboard). That's cheap, and it's what makes the tab correct on sight.
- **Clock-driven changes lag by up to a tick (60 seconds).** That's acceptable, because launches follow the same tick.
- **The two models stay different by design.** If the dashboard still lags after items 8 to 10, while the sidebar note is quiet and refetches aren't stuck as Pending, the next step is to push the Running card's data on the `runs` event (see Not chosen). This design doesn't build that.
- **#25** adds the settings topic and the pending buttons for operation modes. This design doesn't touch those buttons. If #25 lands first, `clockTopics`' `settings` publish fits alongside it unchanged.

## Review

Design review against the code at `bd2b62f`. Each criticism, its fix, and whether the body above adopts it.

1. **The diagnosis relied on evidence that doesn't support it.** The design read "the run page shows *Agent finished*" as proof that the run page's `runs` updates worked. That text is a transcript item built from the log stream's `result` line (`client/src/transcript.ts:103`). It says nothing about the topic stream or `useApi`. *Fix:* say so in Context, and rank the causes again. **Adopted.**
2. **Connection starvation was listed as a risk, but it fits the symptoms best.** It explains all three things the owner reports. Refetches are slow when a few slots are free and never finish when none are. A reload fixes it reliably, because the reload closes that tab's streams. The usage bars fail the same way. A dead stream explains staleness, but not "takes longer". Today every run page keeps a log stream open forever, including for finished runs, and background tabs keep all their streams. *Fix:* hidden tabs close their streams and reopen with a refetch when shown (Approach 0). The server also closes a log stream once its run finishes, not only when the run had already finished on connect (Approach 5). **Adopted.**
3. **The `end` event only covered runs that had already finished when the page opened.** A page opened while the run was active kept its log connection after the run ended, and that's the usual case. *Fix:* the log handler also listens for `runs` on the topic bus and ends the stream once the run is no longer active. This also removes the race the design accepted. **Adopted.**
4. **The usage bars have a server-side gap the design missed.** `runner.ts` records the subscription usage only on a run's first `rate_limit_event` (`!hadUsage`). During a long run the bars freeze at the run-start reading, whatever the client does. The owner asked for the bars to stay live. *Fix:* record whenever the reading changes, at most every 30 seconds per run, plus once when the container exits (Approach 6), with a pipeline test. **Adopted.**
5. **`wake()` on `visibilitychange` became redundant**, because becoming visible now restarts the stream. *Fix:* visibility drives `stop()`/`start()`, and `wake()` stays for `online`. `stop()` and `start()` semantics are spelled out so they can be tested (no `onClosed`, no state flip, timers cleared, `onReconnect` on restart). **Adopted.**
6. **A finished run's log could reopen when the tab is shown again.** With visibility restarting the log stream, a run that already sent `end` would reconnect and replay nothing on every tab switch. *Fix:* `RunView` keeps an `ended` flag set by `onEnd`. Paused runs count as active, so their stream stays open, and a resumed run keeps streaming without reopening. **Adopted.**
7. **The design isn't verified against the deployment.** *Fix:* add a check the owner can do in the network panel: refetches stuck as Pending/Stalled while EventStream still receives events. Also add a manual multi-tab test. The sidebar note still covers the dead-stream case. **Adopted.**
8. **Detecting stalled fetches in the client** (for example, a "Waiting for the server…" note when a refetch takes more than 10 seconds) would make starvation visible too. **Not adopted:** it adds state to every `useApi`, and once hidden tabs release their streams, starvation needs several visible windows side by side. It's easy to add later if the manual check shows it's still needed.
9. **Folding the log stream into `/api/events`, or sharing one stream across tabs** would cut connections further. **Not adopted:** both are much more code (a subscription protocol, or leader election with Web Locks and `BroadcastChannel`) for the case that remains after items 2 and 3. Kept under "Not chosen" and Risks.
10. **Checked and found sound:** `Cache-Control: no-store` before the routers doesn't affect the static bundle (hashed assets keep `maxAge: '1h'`, and `index.html` goes through `sendFile`). `useApi`'s request counter is enough for out-of-order responses. `clockTopics` covers `withinHours`, expiring `blockedUntil` and queue reasons, which are the only clock-driven fields in `/overview`. `cleanup` is the only other path that writes `runs` without `setRun`. No change.

### Second review (PR feedback from @damiante)

The owner confirmed that the run page's log reliably shows new lines while the dashboard doesn't, and asked whether the dashboard now uses the same method as the run page.

11. **Compared the two paths** (Context, "Dashboard and run page compared"). Both now use the same transport, `openSse` plus `LiveStream`. The log pushes data and resumes by index. The dashboard gets topic notices and refetches.
12. **The refetch step had weaknesses the log doesn't have:** failed refetches weren't retried, the debounce could postpone a refetch indefinitely, and the card didn't reflect Claude's `result` until the container exited. *Fix:* Approach items 8 to 10, with tests. **Adopted.**
13. **Full alignment (pushing dashboard data) is not adopted.** The dashboard shows derived state from several tables, so it would mean sending the whole overview to every tab on every event, or repeating server logic in the client. Kept as the next step under Risks if lag remains.
