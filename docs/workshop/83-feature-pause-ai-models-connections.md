# Design: pause AI model connections (#83)

## Context

The branch already has **Pause** and **Resume** on Claude connections (`connections.paused`, `PUT /api/connections/:id/paused`). A paused subscription is left out of the subscription order in `buildQueue`. So far only new launches skip it: running agents and paused runs keep the connection they started on, and an API-billed agent whose connection is paused waits in the queue.

Review feedback from the owner: pausing is for managing **subscription plans**, not agents.

- If a subscription is paused and the agent can carry on with the same model on another subscription, move it to that subscription.
- If it can't be moved, abort the agent and start a new one, without advancing the ticket's stage.
- API-billed agents aren't affected by pausing. Pause only controls subscription use.

## Approach

### When the moves happen

A run moves when it's between segments: at a turn boundary for a running agent, or while it's `paused` for any other reason. A Claude session is a file on the run's volume (`CLAUDE_CONFIG_DIR=/work/.claude`), and `--resume` sends the whole conversation to the API again. So a session can continue under another account's `CLAUDE_CODE_OAUTH_TOKEN`. The workspace and session stay on the same volume and host, as they do now.

The connection's `paused` flag is the only stored request, so no new column is needed to carry it, and it survives a restart. Resuming the connection before the move happens cancels the move, the same way **Keep working** cancels a pause you asked for.

### 1. A running agent stops at its next turn boundary

`runAgent` (`scheduler/runner.ts`) uses the pause code it already has. `wantPause()` gets a third kind, `'connection'`, which it checks after `'manual'` and before `'threshold'`:

```ts
if (r.billing === 'subscription' && getConnection(r.model_connection_id)?.paused)
  return { kind: 'connection', reason: `${conn.name} was paused`, resetsAt: null };
```

The existing rules still apply: stop at `claude.boundary`, wait up to `PAUSE_GRACE_MS` for open tools, ignore replayed lines. The run is parked as `paused` with `pause_reason = 'connection'`, and `drive`'s `finally` calls `settled()` → `kick()`, so the next tick decides straight away (step 3).

To act right away when the agent is already between turns, add `export function connectionPaused(connectionId)` in `runner.ts`. For each `starting`/`running` subscription run on that connection, it appends the workshop log line "`<name>` was paused. The agent moves to another subscription after its current step." and calls `pauseSignals.get(id)?.()`. The `PUT /connections/:id/paused` route calls it when `paused` is true.

A run still in `prepare` moves at the first boundary of its `run` step. That costs at most one turn on the paused subscription, and the session exists by then, so `--resume` works.

### 2. Choosing the subscription to move to

Add one helper in `scheduler/loop.ts` and use it in `buildQueue`, `resumePaused` and `resumeNow`:

```ts
/** Claude subscriptions that could run `model` for `provider`, in your order, unpaused, with what holds each back. */
function subscriptionPool(s: Settings, now: number, provider: string, model: string)
```

It takes the current `subscriptions` filter (not paused, has `subscription` billing) and adds `c.provider === provider` and `modelsOf(c).models().some((m) => m.id === model)`. `pickSubscription(pool)` then chooses. With `null` (no unpaused subscription offers the model), the run **can't be moved**.

The rule: a run can be moved when such a subscription exists, even if it's held back right now (over your limits, or still being checked). The moved run then waits as `paused` until that subscription's allowance lets it go on. That keeps the agent's work, and a new agent would wait for the same subscription anyway. Abort only when no candidate exists.

### 3. Paused runs: `resumePaused` moves them or aborts them

At the top of the loop in `resumePaused`, before the `manual` skip, handle any subscription run whose `model_connection_id` is paused:

- `pick` exists: call `switchConnection(r.id, pick.id)` (new, in `runner.ts`). Then go on with the checks below, using the re-read row.
- No `pick`:
  - `manual`: `continue`. It waits for you, and **Resume** explains what's wrong (step 4).
  - Anything else: abort (step 5), then `continue`.

`switchConnection(runId, toId)`:

- sets `model_connection_id = toId` and `switched_from = <old id>`;
- for pause reasons other than `manual`, also sets `pause_reason = 'connection'` and `resets_at = null`, because the old connection's limit reset doesn't apply to the new one;
- appends "Moved from `<old>` to `<new>` because `<old>` is paused.";
- publishes `runs`.

Further changes in `resumePaused`:

- A `'connection'` pause skips the operation mode and hours check (`modeReason`). The agent was already running, so moving it isn't a new start.
- The existing allowance check (now on the new connection) and the host-slot check still apply. A `'connection'` pause whose connection was resumed before the tick simply resumes on the same connection.

### 4. `resumeNow` (manual pauses)

Before the allowance check, if the run is subscription-billed and its connection is paused:

- with a `pick`, call `switchConnection` and check the new connection's allowance;
- without one, answer 409 with "`<name>` is paused and no other Claude subscription offers `<model>`. Resume a subscription on the Connections page first."

### 5. Abort and start again

`stopRun(runId, reason, false)` already does what an abort needs:

- sets the run to `cancelled`;
- kills any container;
- clears `workshop/running`;
- doesn't count a failure or add labels.

The ticket's labels don't change, so the next `buildQueue` offers the same stage again with the same `attempt`. The new run waits in the queue with "Every Claude subscription is paused…" until a subscription can run it.

Reason text: "`<name>` was paused and no other Claude subscription offers `<model>`, so Workshop stopped this agent. A new one starts this stage again when a subscription is free." Add a `workshop` log line with the same text before stopping. The old volume is removed by the daily cleanup, which already handles cancelled runs.

### 6. A session that won't continue on the new account

It's untested whether every session resumes cleanly under another account. Thinking-block signatures are the main doubt. As a safety net, `runAgent` reads `r.switched_from`:

- On the first turn boundary of the segment, it clears the column (`setRun(r.id, { switched_from: null })`).
- If the segment ends with no boundary and would fail (no result, or `res.isError`), it calls `stopRun(r.id, "Couldn't continue the session on <new>, so Workshop starts this stage again.", false)` and returns `false` instead of throwing. So the attempt isn't counted as a failure, which matches "abort and start a new one".

### 7. API billing is unaffected

- Remove the `conn!.paused ? …` branch for `cls.billing === 'api'` in `buildQueue`: API agents use their connection's key whether or not it's paused.
- `wantPause` and `resumePaused` only look at subscription runs, so API runs never move or stop.
- The Pause button appears only on connections that have a subscription token, or that are already paused, so they can still be resumed.

## Changes

**Server**

- `server/src/db.ts`: new migration: `ALTER TABLE runs ADD COLUMN switched_from INTEGER; -- the Claude connection a run just moved off; cleared at its first turn boundary`.
- `server/src/runs.ts`:
  - add `switched_from: number | null` to `RunRow`;
  - update the `pause_reason` comment.
- `server/src/api-types.ts`:
  - `PauseReason` adds `'connection'`, and its doc comment explains that the run is moving to another subscription;
  - the `ConnectionView.paused` comment says "subscription agents don't use it; API-billed agents still use its key".
- `server/src/http/openapi.ts`: `pauseReason` enum adds `'connection'`.
- `server/src/scheduler/runner.ts`:
  - the `'connection'` kind in `wantPause`/`PauseFor`;
  - `connectionPaused()` and `switchConnection()`;
  - in `runAgent`: clear `switched_from` at the first boundary, and the step-6 fallback;
  - update the comment on `resume`.
- `server/src/scheduler/loop.ts`:
  - `subscriptionPool`, used by `buildQueue`; the queue also checks the model now;
  - the API-paused block removed;
  - `resumePaused` and `resumeNow` changed as described in steps 3 and 4;
  - import `stopRun` and `switchConnection`.
- `server/src/http/connections.ts`: in the paused route, after `setConnectionPaused`, call `connectionPaused(conn.id)` when pausing; `kick()` stays.

**Client**

- `client/src/pages/Connections.tsx`:
  - show the button when `isModel && ('oauthToken' in c.secrets || c.paused)`;
  - note copy: "Paused: subscription agents use your other subscriptions, and running ones move over after their current step. API-billed agents still use its API key. Its settings are kept.";
  - blurb: unchanged.
- `client/src/pages/Dashboard.tsx` and `RunView.tsx`: for `pauseReason === 'connection'`, show "moving to another Claude subscription" (Dashboard) and "Moving to another Claude subscription" (RunView).

**Docs**

- `docs/design/architecture.md`: rewrite the Pause bullet to cover moving running and paused runs, aborting when nothing can take over, the session safety net, and API billing being unaffected. Change "A paused run resumes on the subscription it started on" to "…unless that subscription is paused".
- `docs/design/workflow.md` ("Failures, pauses and stops"): add a bullet: "**A paused subscription** moves its agents to the next subscription at a turn boundary. If none offers the model, the run is cancelled without counting as a failure, and the stage starts again."

## Data and interfaces

- New column `runs.switched_from` (nullable integer). It isn't in `RunView`.
- `PauseReason`: `'limit' | 'threshold' | 'manual' | 'connection'`, in the API types and the OpenAPI enum.
- `PUT /api/connections/:id/paused` stays session-only and unchanged. It now also moves running agents.
- Behaviour change: API-billed agents are no longer held back by a paused connection.

## Tests

`server/test/pipeline.test.ts`, with the fake Docker host and the existing `subscription order` and `pausing at the usage thresholds` setups (a second subscription connection, `reading()`, `setConnectionPaused`):

1. **Running agent moves.**
   - Start a subscription run on A and emit a `tool_use`. Pause A (`setConnectionPaused` plus `connectionPaused`), then emit the `tool_result`.
   - Expect the run `paused`/`'connection'` and its container killed.
   - After `resumePaused`, expect `model_connection_id = B`, `resumes = 1`, `RESUME=1`, and the launch env holding B's token only.
2. **Between turns.** The agent is already at a boundary when A is paused: it stops at once.
3. **Resumed in time.** Pause A, then resume A before the boundary: the agent carries on, and nothing moves.
4. **Held-back target.** B is over the thresholds: the run moves to B and stays paused. Once B is under the thresholds, it resumes.
5. **Can't be moved.**
   - The only subscription is paused, or B lacks a custom model the run uses: after the tick, the run is `cancelled` with the reason text, `tickets.failures` is unchanged, and the labels are unchanged.
   - Resume A: `buildQueue` offers the same agent and stage, and it launches.
6. **Paused runs.**
   - A `limit` pause on a paused A moves to B: `resets_at` is cleared and it resumes when B allows it.
   - A `manual` pause moves only on `resumeNow`. With no subscription to move to, `resumeNow` gives 409 with the message, and the run isn't cancelled.
7. **Session fallback.** After a move, the resumed segment exits with no boundary and no result: the run is `cancelled`, not `failed`, and `failures` is unchanged. After a boundary, the same exit fails as usual.
8. **API billing.**
   - Replace the API half of `skips a paused subscription, and holds API agents on a paused connection`: an API agent on paused A launches with A's key.
   - A running API run on paused A isn't stopped.

`server/test/api.test.ts`: the existing paused-route test stays.

Check the client in the browser:

- the button shows only on connections with a subscription token;
- the new note copy appears;
- a run paused for `'connection'` shows its text.

Save screenshots to `/work/media/`.

Run `npm run typecheck` and `npm test`.

## Risks and open questions

- **Resuming on another account** is assumed to work because sessions are local files. Step 6 limits the damage if it doesn't. If moves fail often in practice, the fallback turns every move into an abort.
- **Aborting loses the agent's work**: local commits and session on the old volume, because only `publish` pushes. This is the behaviour the owner asked for, and it happens only when no other subscription offers the model.
- **One more turn on the paused subscription.** The agent stops at a turn boundary and gets up to `PAUSE_GRACE_MS` for open tools, so the paused subscription is used a little longer. Pausing during a long subagent call can take up to 10 minutes to act.
- **Prompt cache.** A move costs one cache write of the conversation on the new account. This is the same cost as resuming after a pause (#80).
- **Spend per connection.** A killed segment prints no result, so the ledger only sees segments that finish. The finishing segment's cost is recorded against the connection the run ends on (`recordSpend` reads `r.model_connection_id`).
