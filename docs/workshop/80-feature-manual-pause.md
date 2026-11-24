# Design: pause a run by hand (#80)

## Context

Workshop already pauses runs on its own: at a usage limit (`pause_reason = 'limit'`) and, since #78, at the next turn boundary once usage goes over the Settings thresholds (`'threshold'`). A paused run frees its host slot (`RUNNING_SQL` leaves out `paused`), keeps its volume and Claude session, and `resumePaused` in `scheduler/loop.ts` brings it back with `claude --resume` on the same host.

The owner wants to do this on demand: pause an unimportant run so its host slot goes to an important ticket, then resume it later. Outcome:

- **Pause** on the run page. The agent is stopped at its next turn boundary and parked as `paused` with `pause_reason = 'manual'`. Its host slot is free straight away.
- A manual pause **never resumes by itself**. **Resume** on the run page continues the same Claude session.
- Pause also works on a run that's already paused for usage. It then stays paused after the limit resets, so it doesn't take back the slot.

## Approach

Reuse the threshold pause in `runAgent` (`server/src/scheduler/runner.ts`) and add a second trigger: a pause request stored on the run.

1. **Request.** `POST /api/runs/:id/pause` calls the new `requestPause(runId)` in `runner.ts`:
   - `starting` or `running`: set `runs.pause_requested_at = now`, append a `workshop` log line ("Pause requested from Workshop. The agent stops after its current step."), and call the run's in-memory pause signal if `runAgent` is driving it. A request made while the run is `starting` takes effect at the first turn boundary of the `run` step. By then the session exists, so `--resume` works.
   - `paused` for `limit` or `threshold`: set `pause_reason = 'manual'` and keep `resets_at`. Nothing else changes.
   - `paused` for `manual`: do nothing.
   - `publishing`: 409, "The agent has finished and is publishing its work, so it can't be paused."
   - Ended runs: 409, "This run has already ended."
   - Unknown id: 404.

   The request is stored in the database, not only in memory, so it survives a restart. `drive` re-attaches the run, and the first new line checks the column.

2. **Stop at a boundary.** In `runAgent`, generalise `overThreshold()` into `wantPause()`. It returns `{ kind: 'manual' | 'threshold', reason, resetsAt }` and checks the manual request first, because a manual pause must win. The manual check is `!claude.result && getRun(r.id)?.pause_requested_at`, and it gives reason `'you paused it'` and `resetsAt: null`. The existing logic stays as it is:
   - pause at `claude.boundary`;
   - while tools are open, start the `PAUSE_GRACE_MS` timer, which re-checks `wantPause()` when it fires;
   - ignore replayed lines.

   `pausedFor` gains the `kind`. The paused write becomes `setRun(r.id, { status: 'paused', step: 'run', container_id: null, resets_at: pausedFor.resetsAt, pause_reason: pausedFor.kind, pause_requested_at: null })`.

   A request should act straight away if the agent is already between turns. `runAgent` therefore registers a callback in a module-level `pauseSignals: Map<string, () => void>` and deletes it in the `finally` block. The callback:
   - returns if `pausedFor` is already set;
   - pauses if the last line was a boundary (`claude.boundary`);
   - otherwise starts the grace timer if tools are open.

   If none of these applies, the next line decides. The agent is then mid-generation, and the next line is either a tool call or the result.

   If the result arrives first, the run publishes as normal. The `publishing` `setRun` clears `pause_requested_at`.

3. **Never auto-resume.** `resumePaused` skips runs with `pause_reason = 'manual'`.

4. **Resume.** `POST /api/runs/:id/resume` calls the new `resumeNow(runId)` in `scheduler/loop.ts`, which works like `launchNow`:
   - `running` or `starting` with a pending request: clear `pause_requested_at`, so the run keeps working (the "Keep working" button). The grace timer re-checks `wantPause()` and finds nothing.
   - `paused` with `pause_reason = 'manual'`: the operation mode and hours are ignored, because the click is the permission. Then:
     - the run's own host must be healthy and have a free slot. Otherwise 409: "`<host>` has no free agent slot. Pause or stop another agent there, or resume this one when a slot frees up.";
     - a subscription run must pass `allowanceBlock`. Otherwise 409 `Can't resume yet: <block>.`, and on `'Checking allowance'` also start `probeAllowance`;
     - then `resume(runId)`, append a `workshop` log line ("Resumed from Workshop."), and `kick()`.
   - Anything else: 409, "Only a run you paused can be resumed."

   Resume doesn't queue: if it can't resume now, it says why and the owner tries again. This is the same contract as **Start now** (`launchNow`). See the open questions.

5. **Freeing the slot.** Nothing new is needed. When `runAgent` returns after a pause, `drive`'s `finally` calls `settled()`, which runs `kick()`, so the next tick launches the next queued ticket (for example one the owner prioritised or pushed). Stop, closing the ticket, and `workshop/skip` already end paused runs through `stopRun`.

### Effect on the agent, its context and usage

- **Context.** Nothing is lost. The session (`CLAUDE_CONFIG_DIR` on the volume) and the workspace are kept, and `--resume` reloads the whole conversation with the entrypoint's "Continue the task…" message. The task prompt isn't rebuilt, so comments added while the run was paused aren't seen. The base branch may also have moved; `publish` already merges remote commits.
- **Work lost.** Pausing waits for every top-level tool call to return, so tools are never cut off. The model reply being generated when the container is killed is thrown away and regenerated after resume: a few thousand output tokens at most.
- **Usage on resume.** The prompt cache will have expired by the time the run resumes (Anthropic's cache lasts 5 minutes to 1 hour). The first request after resuming therefore writes the whole conversation to the cache again: a one-time cost of roughly the context size, at the cache-write price (on API billing) or as subscription usage. Later turns are cached as usual. Pausing itself costs nothing. This cost appears in the docs and as a short note on the paused run page. It doesn't justify a confirmation dialog.
- **Limits per segment.** Each segment gets a fresh `--max-turns`, timeout (`timeout_min`) and, for API billing, `--max-budget-usd`. This is already true of limit pauses.
- **API spend accounting.** A killed segment prints no `result`, so its cost doesn't reach `runs.cost_usd` or the spend ledger. Until now this only affected subscription runs, where it was acceptable. A manual pause of an **API-billed** run undercounts real money, and with it the daily API cap (`apiSpendSince`). The amount is whatever that segment spent. The pause stays allowed for API runs, since freeing the host matters regardless of billing. This gap is documented and listed under the risks.

## Changes

**Server**

- `server/src/db.ts`: a new migration at the end, `ALTER TABLE runs ADD COLUMN pause_requested_at INTEGER; -- while starting/running: when you asked to pause at the next turn boundary`.
- `server/src/runs.ts`: add `pause_requested_at: number | null` to `RunRow`. `toView` sets `pauseRequested: (r.status === 'starting' || r.status === 'running') && r.pause_requested_at != null`. Update the `pause_reason` comment.
- `server/src/api-types.ts`:
  - `PauseReason = 'limit' | 'threshold' | 'manual'`;
  - `RunView.pauseRequested: boolean`;
  - update the doc comment.
- `server/src/scheduler/runner.ts`:
  - `requestPause`, `pauseSignals`, `wantPause` and `pausedFor.kind`, as in the Approach;
  - clear `pause_requested_at` in `resume()` and in the `publishing` `setRun`;
  - update the comment on `resume`.
- `server/src/scheduler/loop.ts`: `resumePaused` skips `'manual'`. Add `export function resumeNow(runId: string)`.
- `server/src/http/api.ts`: add `POST /runs/:id/pause` and `POST /runs/:id/resume`. Both answer with `runView(id)`.
- `server/src/http/openapi.ts`:
  - add both routes (errors 403, 404, 409);
  - add `'manual'` to `pauseReason`'s enum;
  - add `pauseRequested: { type: 'boolean' }` to `RunView`.
- `agent/entrypoint.sh`: change the comment "Paused by a usage limit" to "Paused (usage or by hand)". No behaviour change.

**Client**

- `client/src/format.ts`: add `runStatus(run: Pick<RunView, 'status' | 'pauseReason'>)`. It returns `{ label: 'Paused by you', tone: 'attention' }` for manual pauses and `RUN_STATUS[run.status]` otherwise. Use it everywhere `RUN_STATUS[...]` is read from a run: `Dashboard.tsx`, `RunView.tsx`, `Runs.tsx`, `Ticket.tsx`.
- `client/src/pages/RunView.tsx`: buttons sit before **Stop**, and one error state (rename `stopError` to `actionError`) covers all of them.
  - `starting`/`running` without a request: **Pause** (plain button).
  - `starting`/`running` with `pauseRequested`: **Keep working**, which posts to `/resume`, and the detail line "Pauses after the current step".
  - `paused` for `limit`/`threshold`: **Keep paused**, which posts to `/pause`, with the title "Stay paused after the limit resets, until you resume it".
  - `paused` for `manual`: **Resume** (`primary`), with the detail line "Paused by you. Resuming continues the same conversation; its first step re-reads the conversation so far, which uses some extra usage."
- `client/src/pages/Dashboard.tsx` (`RunLine`): for manual pauses show "waits for you to resume", and for a pending request show "pauses after the current step". No buttons here.

**Docs**

- `docs/api.md`: one example each for pause and resume, plus a short paragraph covering:
  - pausing happens at the next turn boundary;
  - a manual pause never resumes by itself;
  - resume ignores the mode and hours but needs a free slot on the run's host and the allowance, otherwise 409;
  - resume on a run with a pending request cancels the request.
- `docs/design/architecture.md` (the pause paragraph near line 69), `README.md` (the "Usage limits" bullet): add manual pausing and the resume cost.
- `server/AGENTS.md`, "Run lifecycle": `pause_reason` now includes `manual`, and `pause_requested_at` is the pending request.

## Data and interfaces

- DB: `runs.pause_requested_at INTEGER NULL` (epoch ms). `runs.pause_reason` may now be `'manual'`.
- API:
  - `POST /api/runs/:id/pause` and `POST /api/runs/:id/resume`: no body, answer `RunView`, 404 or 409 with `{ error }`;
  - `RunView.pauseRequested: boolean`;
  - `PauseReason` gains `'manual'`.
- Both routes go on `apiRouter`, so API tokens can use them (for scripts that pause background work).

## Tests

`server/test/pipeline.test.ts`: a new `describe('pausing by hand')` next to `'pausing at the usage thresholds'`, reusing its fake stream helpers.

1. A request during a tool call doesn't kill the container until the `tool_result` line. The run then ends `paused`, with `pause_reason: 'manual'`, `resets_at: null`, `pause_requested_at: null`, `container_id: null`, and without the running label. A queued ticket then launches on the freed slot.
2. A request while the last line was a boundary pauses straight away, through the signal and with no further line.
3. A request during a long open tool call pauses after `PAUSE_GRACE_MS` (fake timers).
4. If the result arrives before the boundary, the run publishes and succeeds, and `pause_requested_at` is cleared.
5. A request made while the run is `starting` is honoured at the first boundary of the run step.
6. `resumePaused` never resumes a manual pause: mode `always`, allowance fine, host free.
7. Pausing a `threshold` or `limit` paused run turns it `manual` and keeps `resets_at`. After the reset time, `resumePaused` leaves it alone.
8. `resumeNow`:
   - resumes with `resumes + 1` and `RESUME=1` in the run container's env, even while Workshop is paused;
   - 409 when the host has no free slot;
   - 409 on an allowance block;
   - 409 for a run that isn't paused by hand.
9. `resumeNow` on a running run with a pending request clears it, and the next boundary doesn't pause.

`server/test/api.test.ts`:
- both routes return 404 for an unknown id;
- `/pause` returns 409 for an ended run;
- `/pause` on a running run sets `pauseRequested: true` in the response.

The OpenAPI test checks that the routes are listed.

Run `npm run typecheck` and `npm test`. Then build and run the app with a seeded paused run and a seeded running run, and use Playwright to screenshot the run page in each state (Pause, Keep working, Keep paused, Resume) at desktop and phone widths, in both themes. Save the screenshots to `/work/media/`.

## Risks and open questions

- **API spend undercount** for manually paused API runs, as described above. Option (not in this design): sum the per-call `message.usage` from `assistant` lines and price it. Workshop has no price table, so this is left out.
- **Resume doesn't queue.** If the host is busy, the owner has to click Resume again later. The alternative is a "resume when a slot frees" flag that `resumePaused` honours before the queue. This would be a small follow-up if waiting proves annoying.
- **Long pauses** keep the volume (disk) on the host and keep the ticket's one-run slot. The ticket's labels can't be changed until the run is resumed or stopped, which is the existing paused-run rule. Nothing expires a manual pause.
- **A long single tool call with no output** (a 20-minute build) delays the pause until it returns. **Stop** is still there for anything urgent.
