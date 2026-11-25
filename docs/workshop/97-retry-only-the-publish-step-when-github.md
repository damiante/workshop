# 97 — Retry only the publish step when GitHub fails

## Context

When `publishRun` throws, `drive` calls `fail()`. A GitHub outage longer than Octokit's own retries (three, on 5xx) fails the run, counts a failure on the ticket, and leaves the database on the old stage, so the scheduler starts the same agent again. Workshop pays for the agent twice. Two outages label any ticket `workshop/failed`. And the second agent may decide differently, because `publishRun` already saved some state before it failed (damiante/nightfall#44).

Outcome:

- A temporary GitHub error while publishing leaves the run in `publishing`. Workshop retries only the publish step, after 1, 5 and 15 minutes, then every 30 minutes. It doesn't count a failure, and the agent doesn't run again.
- A retry finishes the same plan. It doesn't post a comment or update the pull request twice, and it doesn't make a different decision.
- After 6 hours of failures, Workshop gives up through `fail()` and raises an alert.
- Any other error (a 4xx, a failed push, an invalid plan) fails the run as it does today.

## Approach

1. **Classify the error in `drive`.** Only errors thrown by `publishRun` are checked. A transient error is one with a numeric `status` of 5xx or 429, or a network error: a `code` (or `cause.code`) such as `ECONNRESET`, `ETIMEDOUT` or `EAI_AGAIN`, or a `TimeoutError`. Octokit turns fetch failures into a `RequestError` with status 500, so those count too. Errors Workshop throws itself have no `status`, so they still fail the run. `HostUnreachable` keeps its own handling.
2. **Keep the run in `publishing` and schedule the retry.** New run columns hold the retry time, the retry count and when the failures started. `drive` writes them, sets `error` to a readable line, and appends the same line to the run log. It doesn't call `fail()`. The ticket keeps `workshop/running`, and the one-run-per-ticket index keeps other agents off it.
3. **The tick re-drives the run when it's due.** `loop.reattachRuns` already re-drives every run in `starting`, `running` or `publishing` that isn't being driven. It now skips `publishing` runs whose retry time is still in the future. No new loop step is needed, and a restart picks up waiting runs the same way.
4. **Freeze the plan and record each finished step.** This is what makes a retry safe. Today `publishRun` calls `planTransition` again from the ticket's current labels, rework and rescue. After a partial publish those have already changed, so a retry can plan something else. For example, a reconcile run whose rescue was already cleared gets "Nothing to reconcile". A comment that was already posted would also be posted again. So the first attempt stores its plan on the run, along with the push report and the names of the steps it has finished. A retry reuses the stored plan and skips the steps that are done. Only the step that was in flight when GitHub failed runs again, and every GitHub call in it is already safe to repeat (see the table below).
5. **Give up after 6 hours.** If an error is transient but the failures started 6 or more hours ago, raise an `error` alert (`publish-failed`, ref `run:<id>`) and call `fail()` with a message that says so. That counts one failure, and the next attempt starts normally.

Waiting runs don't take a host slot. They need the host only for a short `publish` container when the push hasn't finished. Without this, an outage could hold every slot for 6 hours.

Rejected alternative: making every step safe to repeat with no checkpoints. Recomputing the plan from labels that already moved is the root cause of #44-style bugs, and posted comments can't be detected cheaply.

### Steps in `publishRun` and how a retry treats them

| Step | Checkpoint name | On retry |
|---|---|---|
| plan | stored `plan` | reused, never recomputed |
| `publish` container | stored `pushed` | skipped once `pushed` is stored (exit 0, or a rescue branch was reported) |
| rescue: store `tickets.rescue` | — | idempotent DB write |
| rescue: labels / comment | `labels`, `comment` | skipped when done |
| handoff | `handoff` | skipped (otherwise a cleared rescue would change what it describes) |
| blockers | `blockers` | skipped (`addBlocker` is idempotent anyway) |
| create branch | `branch` | skipped (`createBranch` ignores 422 anyway) |
| ui, delete media, rework write, delete branch, clear rescue | — | idempotent, or already best-effort |
| open or update the PR | `pr` | skipped. Without the checkpoint, a recorded `pr_number` would turn "open" into an "Updated after review" comment |
| request review | `review` | skipped when done |
| label edit | `labels` | skipped (`editLabels` filters against the current labels anyway) |
| comment | `comment` | skipped: this is the duplicate the ticket asks about |
| final ticket update, run succeeded, merge | — | idempotent. Merge failures are already caught |

## Changes

### `server/src/db.ts`

Append one migration:

```sql
-- Publishing that failed on a temporary GitHub error and is retried later (#97).
ALTER TABLE runs ADD COLUMN publish_state TEXT;            -- JSON: frozen plan, push report, finished steps
ALTER TABLE runs ADD COLUMN publish_retries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN publish_retry_at INTEGER;      -- when the tick may publish again
ALTER TABLE runs ADD COLUMN publish_failing_since INTEGER; -- first temporary failure, for the 6-hour give-up
```

### `server/src/runs.ts`

Add the four fields to `RunRow`, with one-line doc comments like the others.

### `server/src/scheduler/gates.ts` (pure)

```ts
/** Minutes between publish retries: 1, 5, 15, then every 30. */
const PUBLISH_RETRY_MIN = [1, 5, 15, 30];
export const publishRetryMinutes = (retries: number) => PUBLISH_RETRY_MIN[Math.min(retries, PUBLISH_RETRY_MIN.length - 1)];
/** How long publishing may keep failing on temporary errors before the run fails. */
export const PUBLISH_GIVE_UP_MS = 6 * 3600_000;
const NETWORK_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);
/** A GitHub 5xx or 429, or a network error: worth retrying later rather than failing the run. */
export function isTransient(err: unknown): boolean
```

`isTransient`: when `status` is a number, return `status >= 500 || status === 429`. Otherwise return true when `code` or `cause.code` is in `NETWORK_CODES`, or when `name === 'TimeoutError'`. Guard against non-objects.

### `server/src/scheduler/runner.ts`

- **`errorText(err)`**: move the existing message expression out of `drive`'s catch (`message || (status ? \`GitHub answered HTTP ${status} with no message.\` : String(err))`), so the catch and `deferPublish` share it.
- **`publishRun`**:
  - `interface PublishState { plan: Plan; pushed?: Pushed; done: string[] }`. Read it from `r.publish_state`. If it's absent, call `planTransition` as today, throw on `plan.failure` (before storing anything), then store `{ plan, done: [] }`.
  - Add a local `step(name, fn)` helper. It returns at once if `name` is in `done`. Otherwise it awaits `fn()`, pushes `name` and writes `publish_state` with `setRun`.
  - Push: if `state.pushed` is set, use it and skip the container. Otherwise run the container, and store `pushed` when the exit code is 0 or `pushed.rescued` is set. The reconcile-conflict branch still throws (not transient), as today.
  - Wrap the steps in the table above: `handoff`, `blockers`, `branch`, `pr`, `review`, `labels` and `comment`, plus `labels` and `comment` in the rescue branch. Keep the existing order and comments.
  - In both places where the run ends `succeeded`, also set `error: null` and `publish_retry_at: null`.
- **`openOrUpdatePr`**: drop the trailing `requestReview` call. `publishRun` calls it in its own `review` step: `vcs.requestReview(repo, getTicket(t.id)!.pr_number!, t.author)`.
- **`drive`**: wrap the `publishRun` call:

  ```ts
  try {
    await publishRun(ctx);
  } catch (err) {
    if (err instanceof HostUnreachable || !isTransient(err)) throw err;
    await deferPublish(getRun(runId)!, err);
  }
  ```
- **`deferPublish(r, err)`** (new):
  - Compute `now`, `since = r.publish_failing_since ?? now` and `detail = errorText(err)`.
  - If `now - since >= PUBLISH_GIVE_UP_MS`, give up. Raise `raiseAlert('error', 'publish-failed', \`${ticket ref}: Workshop couldn't publish the ${agent label} agent's work because GitHub kept failing for 6 hours. Last error: ${detail}\`, \`run:${r.id}\`)`, then `await fail(r.id, \`GitHub kept failing for 6 hours, so Workshop stopped trying to publish. Last error: ${detail}\`)`. Return.
  - Otherwise, with `minutes = publishRetryMinutes(r.publish_retries)` and `text = \`GitHub didn't answer (${detail}). Workshop tries publishing again in ${minutes} minute${minutes === 1 ? '' : 's'}.\``, call `setRun(r.id, { error: text, step: null, container_id: null, publish_retries: r.publish_retries + 1, publish_retry_at: now + minutes * 60_000, publish_failing_since: since })`. Then call `appendLog(r.id, { step: 'workshop', stream: 'stdout', text })`.
  - `drive`'s `finally` already calls `settled()`, and the tick that follows skips the run until it's due.

### `server/src/scheduler/loop.ts`

- `reattachRuns`: export it (for the test), and select ``SELECT * FROM runs WHERE ${RUNNING_SQL} AND (publish_retry_at IS NULL OR publish_retry_at <= ?)`` with `Date.now()`.
- `hostLoads`: count busy runs with ``WHERE ${RUNNING_SQL} AND publish_retry_at IS NULL``, so waiting runs don't hold a slot.

### Docs

- `server/AGENTS.md`, Run lifecycle: add a bullet. A temporary GitHub error in `publishRun` (`isTransient`) keeps the run `publishing` with `publish_retry_at`, and `reattachRuns` re-drives it when due. `publish_state` freezes the plan and records finished steps, so new side effects in `publishRun` must go inside a `step(...)` unless they're idempotent. After 6 hours it goes through `fail()` with a `publish-failed` alert. Also amend the `fail()` bullet: temporary publish errors never reach it.
- `docs/design/workflow.md`, "Failures, pauses and stops": add "**GitHub failing while publishing** (5xx, rate limit, network) isn't a failed attempt. The run waits in publishing and Workshop retries only the publish step (after 1, 5 and 15 minutes, then every 30). After 6 hours it counts as a failure and raises an alert."

## Data and interfaces

- Four new `runs` columns (above). No API or `api-types.ts` change: the run view already shows `status: 'publishing'` and `error`, and the error text says when the next try is.
- New alert kind `publish-failed` (ref `run:<id>`).

## Tests

`server/test/gates.test.ts`:

- `isTransient`: true for `{ status: 502 }`, `{ status: 500 }` and `{ status: 429 }`, for `{ code: 'ECONNRESET' }` and `{ cause: { code: 'EAI_AGAIN' } }`, and for a `TimeoutError`. False for `{ status: 422 }`, `{ status: 403 }`, a plain `Error` and a string.
- `publishRetryMinutes(0..5)` gives `1, 5, 15, 30, 30, 30`.

`server/test/pipeline.test.ts` (import `reattachRuns` from `../src/scheduler/loop.ts`):

1. **`setLabels` throws a 502 once.** Use an Implementation run, with `mockImplementationOnce` rejecting `Object.assign(new Error(''), { status: 502 })`. Wait until the run is `publishing` with `publish_retry_at` set. Check that:
   - `error` contains "GitHub answered HTTP 502" and "again in 1 minute";
   - `failures` is 0, and the run log has the line;
   - `reattachRuns()` starts nothing while the retry time is in the future (`FakeEnv` has no second `run` step queued, and the status is still `publishing`).

   Then set `publish_retry_at` to the past and call `reattachRuns()`. Wait for `succeeded` and check that:
   - the labels moved to `code-review`, and `error` is null;
   - `comment` was called exactly once with "Next: code review.";
   - the publish container ran once.
2. **Steps that finished aren't repeated.**
   - In a Code review with no findings, after `implement`, make `requestReview` reject with a 503 once. After the retry, `openPullRequest` was called once and `commentOnPullRequest` never. `requestReview` was called twice, and the ticket ends on `pr-review` with `handoff` null.
   - In an Implementation run, make `comment` reject with a 503 once. After the retry, the publish container ran once and `setLabels` moved the stage once. `comment` was called twice (the failed call and the retry), and the run is `succeeded`.
3. **A 4xx still fails.** `setLabels` rejects with `{ status: 422 }`. The run ends `failed` with `failures` 1, as today.
4. **Give-up.** Put a run in `publishing` with a result and `publish_failing_since = Date.now() - 6 * 3600_000 - 1`. Make `setLabels` throw a 502 and call `drive(id)`. Check that:
   - the run is `failed` and its error mentions 6 hours;
   - a `publish-failed` alert exists;
   - `failures` is 1.
5. **Update the existing test** "retries a review whose label edit failed after storing the rework…" (about line 1231). Its 502 now defers the publish instead of failing the run. Change the first half: assert `publishing` with `failures` 0, restore `setLabels`, make the run due and call `reattachRuns()`, then continue as before from the "sent back" assertions. Keep a 4xx (`{ status: 422 }`) variant of the old flow, so the stored-rework path for a real failure stays covered. The "exhausted review" test throws a plain `Error`, so it still fails and needs no change.

Run `npm run typecheck` and `npm test`.

## Risks and open questions

- **A failed `git push` isn't classified.** The publish container exits 1 after its own three attempts, and that can't be told apart from a rejected push. It still fails the run as today. A follow-up could have `entrypoint.sh` report a network failure with its own exit code.
- **Labels edited by hand during an outage.** The frozen plan still applies its own label edit when GitHub comes back, which could leave two stage labels. You can cancel the waiting run from the run view (`stopRun` handles `publishing`), and `workflow.md`'s rules about hand edits apply. This is acceptable for a rare case.
- **"Count only agent failures toward `MAX_ATTEMPTS`."** In this design, temporary GitHub errors never count, and the 6-hour give-up counts once. Permanent publish errors (4xx, a failed push, "no commits") still count, as the ticket's 4xx test asks. Nothing else changes.
- **Runs in `publishing` from before the upgrade** have no `publish_state`. They plan on their first attempt, exactly as today.
