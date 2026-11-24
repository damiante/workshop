# Design: pause running agents at the usage thresholds (#78)

## Context

The 5-hour and weekly thresholds in Settings (`fiveHourMax`, `weeklyMax`) only gate launches: `allowanceBlock` in `server/src/scheduler/gates.ts` stops new runs, but a running agent carries on until it finishes. A long Implementation run can use the rest of the 5-hour window after the threshold has been crossed, which is the headroom the owner wanted to keep for their own Claude use.

Outcome: when a subscription run's usage goes over a threshold, Workshop stops the agent at the next turn boundary and parks it as `paused`, as it already does for a real usage limit. It resumes in the same Claude session once usage is back under the thresholds: when the window resets, or as soon as the owner raises the threshold.

Mid-run detection works: every `rate_limit_event` in the run's stream-json carries `unifiedWindows`, `readClaudeLine` keeps the latest one in `claude.usage`, and `runAgent` already records it (#27). No new probe is needed.

## Approach

1. **Detect.** In `runAgent`'s line callback, judge the latest reading against the thresholds with a new pure helper `thresholdBlock` (extracted from `allowanceBlock`, so launches and pauses use the same rule, `>`). Two readings count, and either one being over is enough:
   - this run's `claude.usage`;
   - the connection's stored reading (`allowanceOf`), if it's fresh (`ALLOWANCE_MAX_AGE_MS`). Other runs and probes on the same account update it.

   Only `billing === 'subscription'` runs are checked, and only while no structured result has arrived.
2. **Stop at a turn boundary.** `claude -p` takes no input once started, so Workshop can't ask it to stop. It can choose *when* to kill the container. `readClaudeLine` tracks the top-level tool calls still open: it adds `tool_use` ids from `assistant` lines and removes `tool_result` ids from `user` lines, ignoring lines with a non-null `parent_tool_use_id` (subagent traffic). A **boundary** is a top-level `user` line after which no tool calls are open. Every tool has then finished and its result is in the session file, so the work is consistent. At each boundary, if `thresholdBlock` says over, kill the container (`env.kill`).

   A long subagent (Task tool) never reaches a boundary, and it keeps using allowance meanwhile. So when the threshold is first seen to be over while tools are still open, start a grace timer (`PAUSE_GRACE_MS = 10 * 60_000`). When it fires, kill anyway. Clear it at the next boundary or when the run ends. If the result arrives first, the run finishes and publishes as usual: nothing is left to resume.
3. **Pause.** After the container exits, `runAgent` sees that it killed the run for the threshold (a local `pausedFor` holding `{ reason, resetsAt }`). If there's no structured result, it sets the run to `paused` with `pause_reason = 'threshold'` and `resets_at` = the reset time of the window that's over (null if unknown), then calls `markRunning(ticket, false)`. Do this check right after the `getRun(...).status !== 'running'` check, before the OOM and exit-137 handling, so the kill isn't reported as a failure or a killed container. Record spend if a result exists (it won't, usually).
4. **Resume.** In `resumePaused` (`loop.ts`), a `threshold` pause skips the `resets_at > now` check. It resumes when `allowanceBlock` returns null: after the reset, or once the thresholds are raised. Everything else is unchanged: the mode check, probing while the reading is `Checking allowance`, and the same host with a free slot. `resume()` clears `pause_reason`. The existing `RESUME=1` path (`--resume`, "Continue the task from where you stopped") already handles a killed session.

After a restart, re-attach drives `runAgent` again with an empty open-tool set. The check simply runs at the next top-level `user` line, so nothing extra is needed.

This is always on, with no new setting. It's what the thresholds are for, and the help text says so.

Rejected: killing the moment the threshold is crossed. That's simpler, but it interrupts a tool mid-way (a half-run build or commit), which the ticket asks to avoid. The grace timer limits the cost of waiting.

## Changes

- `server/src/db.ts`: new migration at the end of `MIGRATIONS`:
  `ALTER TABLE runs ADD COLUMN pause_reason TEXT; -- while paused: 'limit' (Claude refused) or 'threshold' (your Settings limit)`.
- `server/src/runs.ts`: `RunRow.pause_reason: 'limit' | 'threshold' | null`. `toView` adds `pauseReason`.
- `server/src/api-types.ts`: `RunView.pauseReason: 'limit' | 'threshold' | null`.
- `server/src/providers/anthropic/index.ts`:
  - `ClaudeRun.openTools?: string[]`: top-level tool calls without a result yet;
  - `readClaudeLine` maintains it as described (`assistant` blocks of `type: 'tool_use'` carry `id`; `user` lines have `message.content[]` with `type: 'tool_result'` and `tool_use_id`);
  - export `endsTurn(line: string, run: ClaudeRun): boolean`, or have `readClaudeLine` set `run.boundary = true` on a boundary line and false otherwise. Pick whichever keeps the runner simplest; the parsing stays in this file.
- `server/src/scheduler/gates.ts`: `thresholdBlock(w: { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null }, s: Settings, now: number): { reason: string; resetsAt: number | null } | null`. It holds the two `used(...) > max` checks and the existing messages (`5-hour allowance at 72%, resets 14:00`). `allowanceBlock` calls it for its last two checks, with identical output.
- `server/src/scheduler/runner.ts`, `runAgent`:
  - the over-threshold check (both readings), boundary kill, grace timer and `pausedFor`, as in Approach 1 to 3;
  - get the container id with `getRun(r.id)!.container_id`, and kill it through `ctx.env.kill`;
  - set `activity` to e.g. "Pausing: 5-hour allowance at 72%." when the stop is requested, and `publish('runs')`;
  - the existing usage-limit pause sets `pause_reason: 'limit'`, and `resume()` sets `pause_reason: null`.
- `server/src/scheduler/loop.ts`, `resumePaused`: `if (r.pause_reason !== 'threshold' && r.resets_at && r.resets_at > now) continue;`.
- `server/src/http/openapi.ts`: add `pauseReason: nullable(str)` (or an enum, if the file has a helper for one) to the RunView schema. `docs/api.md`: mention the field, if it lists RunView fields.
- `client/src/pages/Dashboard.tsx` and `client/src/pages/RunView.tsx`: for `pauseReason === 'threshold'`, show "resumes when usage is under your limit" (Dashboard) or "Resumes when usage is under your limit" (RunView), followed by `, by {clock(resetsAt)}` when `resetsAt` is set. Otherwise keep the current text. Keep the `RUN_STATUS.paused` label.
- `client/src/pages/Settings.tsx`: update the threshold help texts to "No new agents start above this, and running agents pause after their current step until usage drops back under it." Keep the sentence about Claude's 90% warning on the 5-hour field.
- `docs/design/architecture.md` ("Reading the 5-hour and weekly allowance"): add a bullet saying that a run over a threshold pauses at its next turn boundary and resumes below it. Also correct "first `rate_limit_event`": every event carries the windows. `server/AGENTS.md`, run lifecycle: `paused` waits for a usage limit to reset *or for usage to drop under the thresholds*.

## Data and interfaces

- DB: `runs.pause_reason TEXT NULL`. Existing paused rows are null and behave as `limit`.
- API: `RunView.pauseReason` (`'limit' | 'threshold' | null`), in the OpenAPI document.
- No new settings.

## Tests

- `server/test/claude-stream.test.ts`:
  - `openTools` and the boundary across parallel tool calls: two `tool_use` blocks, then one result (not a boundary), then the other (a boundary);
  - subagent lines with a `parent_tool_use_id` don't count.
- `server/test/gates.test.ts`:
  - `thresholdBlock` returns the right reason and `resetsAt` for 5-hour and for weekly, and null when under or when the window has reset;
  - the existing `allowanceBlock` tests still pass unchanged.
- `server/test/pipeline.test.ts` (fake host; `kill` is already faked, so make it record the id and end the fake container's stream):
  - **Pauses at the boundary.** A subscription run streams a `rate_limit_event` with 5-hour usage over `fiveHourMax`, then an `assistant` `tool_use`. `kill` isn't called yet. The matching `user` `tool_result` follows and `kill` is called. The run is then `paused`, `pause_reason = 'threshold'`, `resets_at` = the five-hour `resetsAt`, the ticket isn't running, `failures` is unchanged and no `container-killed` alert is raised.
  - **Finishes if it can.** A run over the threshold whose `result` arrives before any boundary publishes normally.
  - **API runs ignore it.** An `api` run over the threshold isn't killed.
  - **Grace timer.** With fake timers and a tool still open after 10 minutes, `kill` is called.
  - **Resume.** A threshold pause with `resets_at` in the future resumes on a tick once a fresh reading is under the threshold, or after raising `fiveHourMax`. It stays paused while still over. A `limit` pause still waits for `resets_at`.
- Run `npm run typecheck` and `npm test`.

## Risks and open questions

- **Spend for the stopped segment.** A killed `claude -p` prints no `result` line, so that segment's notional cost and tokens aren't added to the run or the spend ledger. This is acceptable for subscription runs. Note it in a code comment.
- **Waiting costs a little.** Usage keeps rising until the boundary: one model response, plus up to 10 minutes of a subagent. The thresholds are meant as headroom, so this is within their purpose.
- **Resume wobble.** If usage sits right at the threshold, a run may resume and pause again after one step. Each resume is one cheap `--resume` call, and the gate's `>` and the stop's `>` agree, so it can't loop without usage changing. No hysteresis for now.
- **Stream shape.** The open-tool tracking relies on `tool_use.id`, `tool_result.tool_use_id` and `parent_tool_use_id` in stream-json. These are standard fields, but the fixtures should be copied from real output when possible, and the fields re-checked when Claude Code is bumped (add them to the list in `server/AGENTS.md`). If the fields are missing, no boundary is ever found, and the grace timer still pauses the run.
