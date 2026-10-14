# Manual mode: push a ticket by hand (#1)

## Context

Workshop only starts agents when the operation mode allows it (`modeBlock` in `server/src/scheduler/gates.ts`): never when `paused`, and only within operating hours when `scheduled`. You want to move one ticket along yourself while automatic processing is off, choosing either:

- **Next stage only:** run whatever comes next for the ticket (classify, design, design review, implement, merge) and stop.
- **Until it needs you:** keep going stage after stage, and stop at the first point where Workshop would wait on you anyway: your pull request review, a question (`needs-info`), `skip`, `failed`, or the ticket closing.

A push lifts only the mode gate. Every other gate still applies: dependencies, model settings, allowance, the API cap, free hosts, and one agent per ticket.

## Approach

- **Store the push on the ticket.** New columns `tickets.push` (`'stage'`, `'lifecycle'` or NULL) and `tickets.push_stage` (the stage key when pushed: the stage label, or `'new'` when there is none). The scheduler stays the only thing that launches runs. The push survives restarts, works for API merges (no agent), and makes retries after a failed first attempt behave exactly as they do automatically.
- **The scheduler ends pushes, not the runner.** A pure `pushEnded(push, pushStage, labels, open)` in `gates.ts` says when a push is finished:
  - `nextStep(...)` is null (closed, `needs-info`, `skip`, `failed`, `pr-review`): ended for both scopes. This is the "stop at the review gate" rule. Approving a pull request moves it to `stage:merge`, but the lifecycle push has already ended at `pr-review`, so a paused Workshop doesn't merge until you push again (or turn automatic mode on).
  - `'stage'` and the current stage key differs from `push_stage`: ended, because the stage completed.
  - Otherwise it carries on. A failed first attempt leaves the stage unchanged, so the stage is retried as usual. After the second failure the ticket has `failed`, and the push ends.

  `settlePushes()` in `loop.ts` clears ended pushes at the start of each tick, after sync and before merges and the queue. `publishRun` edits the local label mirror before `settled()` kicks a tick, so a stage push is cleared before the next launch could happen.
- **The mode gate skips pushed tickets.** In `buildQueue`: `modeReason` is ignored when `t.push` is set. Pushed tickets sort ahead of the rest, so a push also jumps the queue when Workshop runs automatically. `tick()` no longer skips its whole launch block when paused. Instead each part checks the push per ticket:
  - `mergeApproved`: when the mode is `paused`, only pushed tickets. In `scheduled` mode, unpushed tickets keep merging outside hours, as they do today.
  - `resumePaused`: a paused run resumes when the mode allows it, or when its ticket is pushed.
  - The queue: unpushed tickets carry `Workshop is paused` and are never picked.
- **Refuse pushes that can't do anything,** with readable 409s (see below), rather than storing a push that ends at once. A stage push while an agent already works on that ticket is refused. A lifecycle push is allowed then, and carries on after the run.

## Changes

### `server/src/db.ts`
Append one migration entry (`db.exec` runs both statements):
```sql
ALTER TABLE tickets ADD COLUMN push TEXT;
ALTER TABLE tickets ADD COLUMN push_stage TEXT;
```

### `server/src/tickets.ts`
- `TicketRow`: `push: 'stage' | 'lifecycle' | null; push_stage: string | null`.
- `export const stageKey = (labels: string[]) => parseLabels(labels).stage ?? 'new'`.
- `setPush(t, push: 'stage' | 'lifecycle' | null)`: writes `push` and `push_stage` (`stageKey(labelsOf(t))`, or NULL when clearing), updates `t`, then publishes `'tickets'` and `'runs'`. The dashboard queue refetches on `runs`.
- `ticketView`: add `push: t.push`.

### `server/src/scheduler/gates.ts`
- `export function pushEnded(push, pushStage, labels, open): boolean`, as above. It imports `nextStep`/`parseLabels` from `workflow/labels.ts`, which is pure, so no cycle.
- `export function pushRefusal(t: { labels: string[]; open: boolean; running: boolean }, scope): string | null`: the reason a push can't start, or null. In order:
  - closed: `This ticket is closed.`
  - `failed`: `Remove the workshop/failed label first, then push it again.`
  - `skip`: `Workshop skipped this ticket. Remove the workshop/skip label first.`
  - `needs-info`: `An agent asked a question. Answer it and remove the workshop/needs-info label first.`
  - `pr-review`: `This is waiting for your review. Approve the pull request or request changes on GitHub first.`
  - scope `stage` and running: `An agent is already working on this stage.`

### `server/src/scheduler/loop.ts`
- `settlePushes()`: `SELECT * FROM tickets WHERE push IS NOT NULL`. Call `setPush(t, null)` where `pushEnded(...)` is true, or where the repo is disabled or the author isn't allowed.
- `tick()`:
  ```ts
  await syncRepos();
  settlePushes();
  const s = getSettings(); const now = Date.now();
  await mergeApproved(s.mode === 'paused');
  resumePaused(s, now);
  const queue = buildQueue(s, now);
  // launch + probes unchanged
  ```
- `mergeApproved(pushedOnly: boolean)`: `if (pushedOnly && !t.push) continue;`.
- `resumePaused`: move the mode check into the loop. Skip the run when `modeBlock(...)` is set and the run's ticket has no push (`getTicket(r.ticket_id)?.push`).
- `buildQueue`:
  - `let blockedBy = dependencyBlock(blockersOf(t)) ?? (t.push ? null : modeReason);`
  - `Candidate` gains `pushed: boolean`.
  - Sort with `Number(b.pushed) - Number(a.pushed) || a.priority - b.priority`.
- `queueView`: pass `push: c.ticket.push`.

### `server/src/http/api.ts`
- `POST /tickets/:id/push`, with the body `{ scope: 'stage' | 'lifecycle' }`:
  - Ticket missing, repo disabled, or author not allowed: 404 `Ticket not found.`
  - `check(['stage','lifecycle'].includes(scope), 'Choose "stage" or "lifecycle".')`.
  - `pushRefusal` gives a reason: 409 with that message.
  - Otherwise `setPush`, then `kick()`. Respond with `ticketView(...)`.
- `DELETE /tickets/:id/push`: `setPush(t, null)`, then respond with `ticketView`. It doesn't stop a running agent; Stop in the run view still does that.

### `server/src/api-types.ts`
- `export type Push = 'stage' | 'lifecycle'`.
- `TicketView.push: Push | null`, documented as "Set while you've pushed this ticket by hand".
- `QueueItem.push: Push | null`.

### `client/src/pages/Tickets.tsx`
In `Card`:
- When `t.push` is null and `t.next` is set (and, for the stage button, there's no `activeRunId`), show two small buttons: **Run next stage** and **Run until it needs you**. They call `api(`/tickets/${t.id}/push`, { body: { scope } })`.
- When `t.push` is set, show `Pushed: next stage only` or `Pushed: until it needs you`, and a **Cancel push** button (`method: 'DELETE'`).
- Show errors under the card with `ErrorNote`. Disable the buttons while a request is in flight. The list refetches on the `tickets` topic.

### `client/src/pages/Dashboard.tsx`
- In the queue list, show `Pushed by you` next to items with `q.push`.

### Docs
- `docs/design/workflow.md`: add a "Pushing a ticket by hand" section covering the two scopes, the end rule, that only the mode gate is lifted, and the queue priority.
- `README.md`: one sentence where the operation modes are described.

## Data and interfaces

- DB: `tickets.push TEXT`, `tickets.push_stage TEXT` (nullable, new migration).
- API: `POST /api/tickets/:id/push {scope}` returns `TicketView`; `DELETE /api/tickets/:id/push` returns `TicketView`. Errors are `{ error }` with 404, 400 or 409.
- Types: `Push`, `TicketView.push`, `QueueItem.push`.
- No settings change: `mode` keeps its meaning for unpushed tickets.

## Tests

Run `npm run typecheck` and `npm test`.

**`server/test/gates.test.ts`**
- `pushEnded`:
  - stage push ends when the stage changes (`new`→`design`, `design`→`implement`, `reclassify`→`implement`), and not while the stage is unchanged;
  - lifecycle push carries on through stage changes;
  - both end at `pr-review`, `needs-info`, `failed`, `skip` and closed.
- `pushRefusal`: each message, and null for a pushable ticket. A lifecycle push is allowed while running; a stage push isn't.

**`server/test/pipeline.test.ts`** (mode `paused` via `saveSettings`)
- An unpushed ticket's `blockedBy` is `Workshop is paused`. After `setPush(t, 'stage')` it's null, and the ticket sorts first.
- A stage push on a new ticket: the classifier run succeeds (`stage:design`), `settlePushes` (or `tick()`) clears the push, and the queue shows the ticket paused again.
- A lifecycle push: after the classifier succeeds the push stays, and the design step is unblocked. Once the ticket reaches `stage:pr-review`, the push is cleared.
- A failed first attempt keeps a stage push; the second failure clears it.
- Paused mode: `mergeApproved` merges a pushed `stage:merge` ticket and leaves an unpushed one alone.
- A dependency hold still blocks a pushed ticket (`Depends on #2`).

**`server/test/api.test.ts`**
- POST a push on a seeded ticket: 200 with `push` set. A bad scope gives 400, an unknown ticket 404, and a `pr-review` ticket 409 with the review message. DELETE clears the push.

## Risks and open questions

- **Allowance and API cap still apply to pushes.** That's deliberate (fail closed), but a pushed ticket can sit at "5-hour allowance at 90%". The queue shows why. Bypassing those limits would be a separate setting.
- **Classifier `blocked` keeps a stage push** (labels don't change). It runs once the blockers close, which matches "run the next stage", but the push may wait a long time. Cancel push handles it.
- **Behaviour change in `paused` mode:** `tick()` now builds the queue while paused. Only pushed tickets can launch, which `buildQueue`'s per-ticket reason enforces. Add a test that a paused Workshop with no pushes launches nothing.
