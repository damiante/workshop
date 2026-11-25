# 93 — Agent progress

## Context

The run view (`client/src/pages/RunView.tsx`) shows status, model, host, start time and run time, but not how close the agent is to the limits that end it: max turns (`agent_classes.max_turns`, passed as `--max-turns`) and the time limit (`agent_classes.timeout_min`, the kill timer in `runContainer`). The transcript also has no numbering, so you can't point at "the turn where it ran the migration".

Outcome:

- A **Progress** panel on the run view: turns used of max turns, time used of the time limit, to-do progress, tool-call count with failures, and the agent's current activity.
- **Turn numbers** in a gutter beside the transcript. Each one links to its turn (`#turn-12`). They never end up in copied text, so selecting and pasting the transcript gives clean text.

## Approach

**Limits are stored on the run, not read live from the agent settings.** `MAX_TURNS` is fixed when the container starts. Reading `agent_classes` in the view would show a wrong limit after someone edits the agent mid-run, and on every finished run afterwards. So the run step writes `max_turns` and `timeout_min` onto the run row when it starts a new `run` container.

**Time used is measured from when the container started.** Each `run` container is one segment. A resumed (paused) run starts a new container, and with it a fresh `--max-turns` count and a fresh timer. A new `runs.step_started_at` column is written in `runContainer` whenever it starts a container. There's one bug to fix along the way. After a server restart, `runContainer` re-attaches to the container and restarts the full timer, so the real limit can run past what the meter shows. With `step_started_at` stored, re-attach arms only the time that's left: `max(0, timeoutMs - (now - step_started_at))`.

**Turns are counted in the client's transcript reducer.** It already folds every log line. No new server state and no change to the log format. A turn is one top-level assistant API response: stream-json lines that share an `assistant` `message.id` belong to one turn, and a line without an id counts as its own turn. Lines with `parent_tool_use_id` are a subagent's and don't count. This matches what `readClaudeLine` treats as the agent's own. The reducer keeps:

- `turns`: the whole run, used for the gutter numbers, which must be unique across segments.
- `segmentTurns`: reset when a `run` line's `container` differs from the last one seen. This is what `--max-turns` limits.
- When a `result` event has `num_turns`, `segmentTurns` takes that value, because Claude Code's own count is authoritative.

**Gutter numbers are rendered with `::before { content: attr(data-turn) }` and `user-select: none`.** Pseudo-element content isn't part of the selection, so copying never picks up numbers or a stray column. Rejected alternative: numbers as real text. Copying would then give `12⏎Bash: npm test` from the grid, which mixes up pasted logs. You can still reference a turn by its link (`…/runs/<id>#turn-12`) or by reading the number.

## Changes

### Server

- `server/src/db.ts`: a new `MIGRATIONS` entry:
  `ALTER TABLE runs ADD COLUMN max_turns INTEGER; ALTER TABLE runs ADD COLUMN timeout_min INTEGER; ALTER TABLE runs ADD COLUMN step_started_at INTEGER;` (nullable; older rows stay null).
- `server/src/runs.ts`: add the three fields to `RunRow` and map them in `toView` (see Data and interfaces).
- `server/src/scheduler/runner.ts`:
  - `runContainer`: when it starts a new container, write `step_started_at: Date.now()` together with `step`/`container_id` (both `setRun` and the `Object.assign(ctx.run, …)`). On re-attach, arm the timer with the time that's left, computed from `ctx.run.step_started_at`. If that's null (rows from before this change), keep the full `timeoutMs`. If the time left is 0, kill the container at once (`timedOut = true`).
  - `runAgent`: before `runContainer`, unless it's re-attaching (`r.step === 'run' && r.container_id`), write `max_turns: agent.max_turns, timeout_min: agent.timeout_min` to the row and `r`. Pass `(r.timeout_min ?? agent.timeout_min) * 60_000` as the timeout. Use the same value in the "Stopped after the N-minute time limit" message and in `describeError`'s `error_max_turns` text (`r.max_turns ?? agent.max_turns`), so the messages match the meter.
- `server/src/api-types.ts`: the `RunView` fields below.
- `server/src/http/openapi.ts`: add the three fields to the `RunView` schema (`nullable(int)`).
- `docs/api.md`: one line for each new `RunView` field, if the file lists RunView fields.

### Client

- `client/src/transcript.ts`:
  - `Transcript` gains `turns: number`, `segmentTurns: number`, `toolCalls: number`, `toolErrors: number`, plus private trackers `turnId: string | null` and `container: string | null`.
  - `Item` gains an optional `turn?: number`, set only on the **first** item each new turn produces: a `say` or `tool` item. If a turn produces only a TodoWrite, there's no item, so the number is skipped in the gutter but still counted.
  - In `case 'assistant'`, when `!event.parent_tool_use_id` and `event.message?.id !== t.turnId` (or there's no id), increment `turns` and `segmentTurns`, then tag the next pushed item.
  - When a `run` step's `entry.container` differs from `t.container`, reset `segmentTurns` and `t.turnId`.
  - Count `toolCalls` per top-level `tool_use` (TodoWrite excluded), and `toolErrors` when a result has `is_error`.
  - `case 'result'`: if `typeof event.num_turns === 'number'`, set `segmentTurns = event.num_turns`.
- `client/src/components/ui.tsx`: add `Progress({ label, value, max, text })`. It reuses the `.meter`/`.meter-track`/`.meter-fill` markup and adds `over` when `value >= max`. No threshold mark. `role="meter"` with `aria-valuenow`/`aria-valuemax`. The existing `Meter` stays allowance-specific.
- `client/src/pages/RunView.tsx`:
  - **Progress panel** (`<Panel title="Progress">`), placed above the to-do panel. It shows once the transcript has a turn or the run is in its `run` step. It has compact rows, and the rows shown depend on what's known:
    - **Turns**: `<Progress>` with `segmentTurns` of `run.maxTurns`, text "37 of 100". If the run has more than one segment (`turns > segmentTurns`), add ", 52 in all". When `maxTurns` is null (old run), the text is just "37 turns" with no bar.
    - **Time limit**: only while `status === 'running' && step === 'run'` and `stepStartedAt`/`timeoutMin` are set. `<Progress>` with elapsed minutes of `timeoutMin`, text "24 of 60 min" (whole minutes), using `now` from `useNow`. Use `useNow(10_000)`, which the page already has.
    - **To-dos**: "3 of 7 done", when `todos.length`.
    - **Tool calls**: "84", or "84, 3 failed".
    - **Now**: `run.activity` while active. RunView receives it but doesn't show it today.
  - **Turn gutter**: wrap every transcript item in `<div className="line" id={item.turn ? `turn-${item.turn}` : undefined}>` holding `<a className="turn-no" href={`#turn-${n}`} data-turn={n} aria-label={`Turn ${n}`} />` (an empty `<span className="turn-no" />` when there's no number) and the existing `ItemView`.
  - **Hash handling**: if `location.hash` matches `#turn-N` when the page loads, or once that item has streamed in, scroll it into view once and `setFollowing(false)`, so the auto-scroll doesn't jump away. Clicking a number only changes the hash, and the browser scrolls. Also turn following off in a `hashchange` listener.
- `client/src/theme.css`:
  - `.transcript .line { display: grid; grid-template-columns: 4ch minmax(0, 1fr); column-gap: 8px; }`. The `.transcript` flex `gap` moves onto the line wrappers unchanged.
  - `.turn-no { font-family: var(--mono); font-size: 12px; color: var(--muted); text-align: right; user-select: none; text-decoration: none; padding-top: 6px; }` (aligned with the summary's padding), `.turn-no::before { content: attr(data-turn); }`, and `.turn-no:hover` underlined.
  - `.transcript .line:target > :last-child { outline: 1px solid var(--accent); border-radius: var(--radius); }`, a subtle highlight for the linked turn. No new colour tokens.
  - Under 760px: `grid-template-columns: 3ch minmax(0, 1fr)`.
  - Step headers (`.step`) keep their bottom border in the content column, so numbers line up.

## Data and interfaces

`RunView` (in `api-types.ts`, documented for the API):

```ts
/** The turn limit the agent's current or last session ran with; null for runs from before Workshop recorded it. */
maxTurns: number | null;
/** The time limit in minutes for each agent session (it restarts when a paused run resumes); null for older runs. */
timeoutMin: number | null;
/** When the current step's container started: the time limit counts from here. */
stepStartedAt: number | null;
```

DB: three nullable `INTEGER` columns on `runs` (epoch ms for `step_started_at`). No change to the log format or `LogEntry`.

## Tests

- `client/test/transcript.test.ts`:
  - Lines sharing a `message.id` are one turn, and the first item carries `turn: 1`.
  - A new id gives turn 2.
  - Subagent lines (`parent_tool_use_id`) don't count.
  - Lines without ids count one each.
  - A `container` change resets `segmentTurns` but not `turns`.
  - `result.num_turns` overrides `segmentTurns`.
  - `toolCalls`/`toolErrors` are counted, and TodoWrite doesn't count as a tool call.
- `server/test/pipeline.test.ts`:
  - A run records `max_turns`, `timeout_min` and `step_started_at`, and `GET /runs/:id` (or `runView`) exposes them.
  - Re-attach regression: with `step_started_at` set further back than the time limit, re-attaching kills the container and fails with the time-limit message, instead of granting a fresh timer. Use fake timers or a 1-minute `timeout_min` with `step_started_at` backdated.
- Browser check (Playwright), at desktop and 375px widths in both themes:
  - The Progress panel renders.
  - Gutter numbers line up with tool summaries and prose.
  - Selecting across several turns and copying (`page.evaluate(() => getSelection().toString())`) contains no turn numbers.
  - Opening `#turn-N` scrolls to and outlines that turn.
  - Save screenshots to `/work/media/`.
- Run `npm run typecheck` and `npm test`.

## Risks and open questions

- **Turn count definition.** Counting distinct `message.id`s matches how Claude Code counts against `--max-turns` as far as the stream shows. `num_turns` corrects the segment count once the result arrives. If the live count drifts by one from Claude's, the meter is slightly off, but no behaviour depends on it.
- **Time-limit change on re-attach** is a behaviour change: a run whose server restarted near its limit will now be stopped on time instead of getting a fresh full limit. That's the intended limit, but it's new.
- **Paused runs.** The bars show the current segment, because that's what both limits apply to. The "in all" suffix keeps the run-wide turn total visible. Time used across all segments isn't shown, because the run-time figure in the header already covers it.
- **#92** also edits the transcript area. Whichever lands second rebases the `.line` wrapper around its own item changes.
- Not included: "last output N minutes ago" (stall detection). It would need timestamps on log lines, a format change best left to its own ticket.
