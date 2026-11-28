# 147 — Sync now and Refresh: show real progress

## Context

**Sync now** (Tickets) and **Refresh** (Dashboard) grey their button out for a fixed 1.5 s (`setTimeout(..., 1500)` in `client/src/pages/Tickets.tsx` and `Dashboard.tsx`). The server only schedules the work: `POST /api/sync` calls `syncSoon()`, and `POST /api/refresh` calls `void refreshNow()`. Both answer `202 { ok: true }` at once. If a sync pass is already running, `serial()` only sets `again`, so the click waits behind a pass that can take minutes. You can't tell whether a click is pending, running, or was missed.

Outcome: the server keeps one in-memory progress record for sync passes (scheduled, Sync now, Refresh), publishes a `sync` topic on every change, and serves it at `GET /api/sync`. One shared client component drives both buttons from it: "Sending…", "Waiting for the current check to finish", a progress bar per repository, then usage checks and "Starting work" for Refresh, and "Last synced 2 minutes ago" when idle. Errors are shown, never a silent grey button.

## Approach

All tracking lives in `server/src/scheduler/loop.ts`, next to the passes it describes. `serial()` stays unchanged.

**Record and state.** A module-level `progress: SyncProgress` plus `setProgress(patch)`, which merges the patch and calls `publish('sync')`. `syncProgress()` returns a copy. Two more module variables:

- `requested: 'sync' | 'refresh' | null`: a click not yet picked up by a pass.
- `refreshing: Promise<void> | null`: the refresh in flight.

**Requesting** (`markRequested(kind)`, called by `syncSoon()` and `refreshNow()` before they start any pass):

- If `progress.state` is `running` (a pass is under way), set `state: 'waiting'`, `kind`, `requestedAt: now`. The pass keeps updating `phase`/`repo`/`done`/`total` while the record says `waiting`.
- Otherwise set `state: 'requested'`, `kind`, `requestedAt: now`, `phase: null`, `done: 0`, `total: 0`, `repo: null`.
- Store `requested = kind` (a `refresh` is never downgraded to `sync`).

**The sync pass** (`syncOnce`). Work out the due repositories up front: move the `pollMinutes`/`lastSync` filter out of `syncRepos` into a `dueRepos()` helper, and pass the list to `syncRepos(due)`.

- If `due` is empty and nothing was requested and no refresh is in flight, do not touch the record. This covers almost every 60 s tick, so idle instances don't publish `sync` once a minute or claim "Last synced just now" when nothing was read.
- Otherwise take `kind = refreshing ? 'refresh' : requested ?? 'scheduled'`, set `requested = null`, and set `state: 'running', kind, phase: 'sync', done: 0, total: due.length, repo: null, lastError: null`. A pass that starts while a refresh is in flight (its sync's re-run) keeps `kind: 'refresh'`.
- In `syncRepos`, before each repo set `repo: repo.full_name`. After it set `done + 1`. On a failure, keep raising the alert as today, and also add the alert's message (`Couldn't sync <repo>: <message>`) to a list. When the loop ends, join that list with a space into `lastError` (null when it's empty).
- `mergeApproved` and the trailing `allocatePass()` run as today, with `phase` left at `sync` and `repo: null`.
- In a `finally` (so a thrown error can't leave the button stuck), unless a refresh is in flight: if `requested` is set (a click came in during this pass and `serial` will re-run it), set `state: 'waiting'`. Otherwise set `state: 'idle', phase: null, repo: null, lastFinishedAt: now`.

**Refresh** (`refreshNow`) becomes sequential for the record, but keeps today's concurrency for the work:

1. If `refreshing` is set, return it: a second refresh joins the first.
2. `markRequested('refresh')`, then clear `lastSync` and `probeFailedAt`, and start the allowance checks as today. Count them as they settle (`.finally(() => checked++)`). Build the timed wait up front, `withTimeout(Promise.all(checks), REFRESH_PROBE_WAIT_MS).catch(() => {})`, so the 150 s bound still starts at the click.
3. `void allocatePass()` as today, then `await syncPass()`. This is a change: Refresh now waits for its sync. `serial` resolves after any queued re-run, so a refresh waiting behind a long pass resolves after its own sync.
4. If there are checks, set `state: 'running', phase: 'usage', repo: null, done: checked, total: checks.length`. Each settling check after that updates `done`. Then await the timed wait.
5. Set `phase: 'allocate', done: 0, total: 0`, then `await allocatePass()`.
6. In a `finally`: set `refreshing = null`, and `state: 'idle', phase: null, lastFinishedAt: now`. Keep `lastError` from the sync.

Implement steps 2–6 as an inner async function, and assign `refreshing = inner().finally(() => (refreshing = null))`.

**Sync now during a refresh** joins it: `syncSoon()` clears `lastSync` and calls `syncPass()`, the re-run is part of the refresh's `await syncPass()`, and the record stays `kind: 'refresh'`. `markRequested` is skipped while `refreshing` is set.

**Steps inside a repository:** not in this ticket. Counting `listChanged` pages needs a new provider method shape (`paginate.iterator`, plus `Link: rel="last"`), threaded through `syncRepo` and the fakes. That's more than "cheap". The per-repo bar plus the repo name shows that work is moving. This can be a follow-up if large repos look stuck.

**Client.** A presentational `SyncControl` renders the button and a status line from `(record, sending, error, now)`. A thin `SyncButton` wrapper owns the fetching. The text comes from a pure `syncStatus()` so it can be tested without a DOM, matching the existing `client/test/*.tsx` `renderToStaticMarkup` style.

## Changes

### Server

- `server/src/api-types.ts`: add `'sync'` to `Topic`, and add:
  ```ts
  export interface SyncProgress {
    state: 'idle' | 'requested' | 'waiting' | 'running';
    kind: 'sync' | 'refresh' | 'scheduled';
    phase: 'sync' | 'usage' | 'allocate' | null;
    repo: string | null; done: number; total: number;
    requestedAt: number | null; lastFinishedAt: number | null; lastError: string | null;
  }
  ```
  The initial value is `{ state: 'idle', kind: 'scheduled', phase: null, repo: null, done: 0, total: 0, requestedAt: null, lastFinishedAt: null, lastError: null }`.
- `server/src/scheduler/loop.ts`: as in Approach. Export `syncProgress()`. `syncSoon()` and `refreshNow()` call `markRequested` first. `syncSoon()` still returns the `syncPass()` promise (tests use it). Update the doc comments on `syncSoon`, `refreshNow` and `syncOnce`. Add a test-only `resetSyncProgress()` (exported, used by `pipeline.test.ts` `beforeEach`) that restores the initial record and clears `requested`.
- `server/src/http/api.ts`:
  - `GET /sync` → `res.json(syncProgress())`;
  - `POST /sync` → `syncSoon(); res.status(202).json(syncProgress())`;
  - `POST /refresh` → `void refreshNow(); res.status(202).json(syncProgress())`.

  The settings route's `syncSoon()` (line ~155) stays. It shows as `kind: 'sync'`, which is fine.
- `server/src/http/openapi.ts`: add the schema `SyncProgress` (an enum for `state`, `kind` and `phase`, with `phase`, `repo`, `requestedAt`, `lastFinishedAt` and `lastError` nullable). `/sync` becomes `{ get: { summary: 'Progress of the GitHub sync: …', ok: ref('SyncProgress') }, post: { …, status: '202', ok: ref('SyncProgress'), errors: [403] } }`. `/refresh` post gains `ok: ref('SyncProgress')`. Update both summaries to say that progress is at `GET /api/sync`.
- `docs/api.md`: under "Checking now", describe `POST /api/sync`, the new `GET /api/sync` record (states, phases, what `done`/`total` count in each phase, `lastError`), that both POSTs return it, and that the record is in memory (it resets on restart: `lastFinishedAt: null`). Remove "answers 202 at once; … dashboard updates when they do" in favour of this. Note that Refresh now finishes after its sync.
- `server/AGENTS.md`: in the `loop.ts` row, add "keeps the `sync` progress record (`syncProgress`)".

### Client

- `client/src/sync.ts` (new, pure): `syncStatus(p: SyncProgress, now: number): { busy: boolean; text: string; bar: { value: number; max: number } | null }`.
  - `requested` / `waiting` → busy, "Waiting for the current check to finish". For `requested` with no running pass, this is replaced within milliseconds.
  - `running`, `phase: 'sync'` → busy, `Syncing ${repo} (${min(done + 1, total)} of ${total} repos)`, bar `done/total`. With `repo` null (merging and allocating after the repos) → "Finishing the sync", no bar. With `total` 0 → "Syncing tickets", no bar.
  - `running`, `phase: 'usage'` → busy, `Checking Claude usage (${done} of ${total})`, bar.
  - `running`, `phase: 'allocate'` → busy, "Starting work", no bar.
  - `idle` → not busy, `Last synced ${ago(lastFinishedAt, now)}` using `format.ts`'s `ago`, or "Not synced since Workshop started" when `lastFinishedAt` is null.
  - Use "repo" for one and "repos" otherwise.
- `client/src/components/SyncButton.tsx` (new):
  - `SyncControl({ status, lastError, sending, error, label, title, onClick })`: a `div.sync-control` holding a status area (`Progress` from `ui.tsx` with `label` = the status text when there's a bar, otherwise a `span.muted` with the text), then `ErrorNote` for `error`, and `lastError` when idle. The button is disabled when `sending || status.busy`, and its text is "Sending…" while sending, otherwise `label`.
  - `SyncButton({ action: '/sync' | '/refresh', label, title })`:
    - `useApi<SyncProgress>('/sync', ['sync'])` and `useNow()`;
    - local `sending: 'no' | 'posting' | 'reloading'` and `postError`.
    - On click: set `posting` and clear `postError`. Call `api(action, { body: {} })`. On success, `reload()` and set `reloading`. On failure, set `postError` to the message and `sending` to `'no'`.
    - A `useEffect` on `[data, error]` turns `reloading` back to `'no'`, so the button never flashes enabled between the reply and the refetch.
    - Shown error: `postError ?? error`.
    - Before the first `data` arrives, render `SyncControl` as busy with no text.
- `client/src/pages/Tickets.tsx`: remove `syncing` and `sync`, and render `<SyncButton action="/sync" label="Sync now" title="Sync tickets from GitHub now" />` in place of the button.
- `client/src/pages/Dashboard.tsx`: remove `refreshing` and `refresh`, and render `<SyncButton action="/refresh" label="Refresh" title="Sync tickets, check Claude usage and start or resume what's ready, without waiting for the next check" />`. Drop the `api` import if it's no longer used.
- `client/src/theme.css`: `.sync-control`:
  - a row aligned to the end, with a gap and `flex-wrap: wrap`;
  - the meter at a fixed `min-width` (about 14rem) so the header doesn't jump;
  - the status text at the small muted size.

  On phones (<760px) it wraps under the heading, and nothing scrolls sideways.
- `client/AGENTS.md`: add the `sync.ts` and `SyncButton` rows to the Structure table.

A hidden tab: `visibilitychange` restarts the stream, and `onReconnect: notifyAll` refetches every `useApi`, `/sync` included. Check this while building. If showing the tab doesn't trigger `onReconnect`, make `SyncButton` call `reload()` on `visibilitychange` → visible.

## Data and interfaces

- New `GET /api/sync` → `SyncProgress` (read tokens allowed).
- `POST /api/sync` and `POST /api/refresh`: still `202`, body changes from `{ ok: true }` to `SyncProgress`. This is a breaking change for scripts that check `ok`, so note it in `docs/api.md`.
- New SSE topic `sync`.
- No DB change.

## Tests

`server/test/pipeline.test.ts`, new `describe('sync progress')`. Call `resetSyncProgress()` in `beforeEach`. Record snapshots with `bus.on('topic', (t) => t === 'sync' && seen.push(syncProgress()))`, and remove the listener in `afterEach`. Gate `fake.tickets.listChanged` with a promise, the way the "while a GitHub sync is running" block does.

- `syncSoon()` with two enabled repos: the first snapshot is `requested` or `running`. Then `running`/`sync` with `total: 2`, `repo` set and `done` 0 → 1 → 2. The last is `idle` with `lastFinishedAt` set and `kind: 'sync'`.
- While a gated pass runs, a second `syncSoon()` gives `waiting`. After release, the record goes `running` again (the re-run), then `idle`.
- `refreshNow()` with an unchecked subscription, like the "waits on Refresh for the allowance check" test: the phases seen are `sync`, then `usage` (`total: 1`, `done` reaching 1), then `allocate`, then `idle` with `kind: 'refresh'`. Also check that `refreshNow()` resolves only after its sync, and that a second concurrent `refreshNow()` returns the same promise (only one probe runs).
- `listChanged` throws for one of two repos: `lastError` contains `Couldn't sync <that repo>`, the other repo still syncs, and the record ends `idle`.
- `tick()` with no due repos publishes no `sync` topic and leaves `lastFinishedAt` unchanged.
- Existing `refreshNow()` tests keep passing. They now also wait for the sync; their `listChanged` fakes resolve.

`server/test/api.test.ts`:
- `GET /api/sync` returns a record with every field.
- Update "accepts a refresh": the body has a `state` in `requested | waiting | running | idle`. It may already be idle if the fake sync is instant, so assert a `SyncProgress` shape rather than exactly `requested`. Keep the read-token 403.
- Add the same for `POST /api/sync`, plus a read token gets 403 there too.
- The openapi route test covers the new GET.

`client/test/sync.test.tsx` (new):
- `syncStatus` text for idle (with and without `lastFinishedAt`), requested, waiting, `running`/`sync` (with a repo, between repos, and `total: 0`), usage, and allocate, plus `busy` in each.
- `renderToStaticMarkup(<SyncControl …/>)`: the button is disabled with "Sending…" while sending; it's disabled while busy; an error message is shown in a `role="alert"` (the failed POST); `lastError` shows when idle; and the button is enabled when idle.

Run `npm run typecheck` and `npm test`. With the browser, check both pages at desktop and phone widths in both themes. Use a slow fake or a real repo to capture a running state, and save the screenshots to `/work/media/`.

## Risks and open questions

- **Refresh now waits for its sync.** Nothing awaits `refreshNow()` except tests, so only its duration changes. The usage checks and the first allocation still start at once.
- **`waiting` during a scheduled pass:** the bar of the running pass stays hidden behind the "Waiting…" text. That's what the ticket asks for. Showing both is a cheap later tweak.
- **The record is per process and in memory,** so a restart shows "Not synced since Workshop started" until the first pass. This is acceptable for a status hint.
- **A breaking change to the POST response body** (`{ ok: true }` → the record). No known consumer relies on it.
