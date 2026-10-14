# Repository priority (#15)

## Context

Workshop works through every enabled repository's tickets in one queue. That queue is ordered by hand push, then step (`stepPriority`: finish work in flight first), then `updated_at`. You can't say "this repo matters more". We want a priority on each enrolled repo:

- Tickets from a higher-priority repo come before tickets from a lower-priority repo.
- A lower-priority repo's ticket may only start once **every** open ticket in higher-priority repos has at least been classified. A ticket the Classifier held (`blocked`), skipped (`workshop/skip`), asked about (`workshop/needs-info`) or that failed counts as done for this purpose.

## Approach

- **Store an integer `repos.priority`, default 0. Higher goes first.** Repos with equal priority don't hold each other back, so existing setups behave as today. An integer is simpler to store, validate and sort than named levels, and any number of levels is possible.
- **"Unclassified" is a pure test** on a ticket's labels and holds: `nextStep` is the Classifier in `normal` mode (no stage label; not skipped, failed or waiting on a question), and it has no dependency hold (`blockersOf(t)` empty, so the Classifier's `blocked` counts as classified). `stage:reclassify` (delta mode) has already been classified, so it doesn't count. A ticket whose Classifier run is in progress still counts as unclassified until the run publishes.
- **Gate in `buildQueue`.** Before the loop, collect the unclassified eligible tickets (enabled repo, open, allowlisted author) with their repo's priority. For each candidate, a pure `priorityBlock(priority, waiting)` returns a reason when any of them belongs to a repo with a strictly higher priority:
  `Waiting for me/app to be classified first` (several repos joined with `joinRefs`: `Waiting for me/app and me/api to be classified first`).
  The higher-priority repo's own unclassified tickets are never gated by it, so it can always make progress.
- **Order.** Sort: pushed first, then repo priority (descending), then `stepPriority`, then `updated_at` (already the order from SQL; `Array.sort` is stable). So once the higher repo is all classified, its design and implementation work still goes before lower repos' work, as the ticket asks ("processed before"); the gate only forces the classification minimum.
- **Hand pushes and "start now" bypass the gate**, as they bypass the operation mode: they're an explicit request for that ticket. Concretely, the gate is applied where `modeReason` is (`t.push ? null : …`), and `opts.ignoreMode` (used by `launchNow`) skips it too.
- **Dependency holds come first**: `dependencyBlock(...) ?? (t.push ? null : modeReason ?? priorityReason)`, so the queue shows the most useful reason.
- Not gated: API merges (`mergeApproved`, no agent) and resuming paused runs (not new starts).
- **Setting it** goes through the existing `PUT /api/repos/:id` (on `connectionsRouter`, like `enabled` and `image`), plus a number field on the Connections page. Changing it calls `kick()` and publishes `repos`, which the dashboard already listens to, so the queue redraws.

## Changes

### `server/src/db.ts`
- Append the migration `ALTER TABLE repos ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;`.

### `server/src/tickets.ts`
- `RepoRow`: add `priority: number`.
- `repoView`: add `priority: r.priority`.

### `server/src/api-types.ts`
- `RepoView`: add `priority: number` with a doc comment: `Higher goes first. Lower-priority repos wait until every open ticket here has been classified.`

### `server/src/scheduler/gates.ts`
- `export function isUnclassified(labels: string[], open: boolean, blockers: string[]): boolean`: `blockers.length === 0` and `nextStep(parseLabels(labels), open)` is `{ kind: 'agent', agent: 'classifier', mode: 'normal' }`.
- `export function priorityBlock(priority: number, waiting: { repo: string; priority: number }[]): string | null`: the distinct `repo` names (in first-seen order) of entries with `priority > ` the given one, formatted `Waiting for ${joinRefs(names)} to be classified first`, or null.

### `server/src/scheduler/loop.ts`
- `buildQueue`:
  - Run the open-tickets query once (`ORDER BY t.updated_at`) and reuse the rows. Build a repo map once (`all<RepoRow>('SELECT * FROM repos')`) instead of `getRepo` per row.
  - `waiting = rows.filter((t) => isAllowedAuthor(t.author) && isUnclassified(labelsOf(t), true, blockersOf(t))).map((t) => ({ repo: repos.get(t.repo_id)!.full_name, priority: repos.get(t.repo_id)!.priority }))`. Don't skip tickets with an active run here.
  - `priorityReason = opts.ignoreMode ? null : priorityBlock(repo.priority, waiting)`; then `let blockedBy = dependencyBlock(blockersOf(t)) ?? (t.push ? null : modeReason ?? priorityReason);`.
  - Store `repoPriority: repo.priority` on the internal candidate next to `priority` and sort with `Number(b.pushed) - Number(a.pushed) || b.repoPriority - a.repoPriority || a.priority - b.priority`.

### `server/src/http/connections.ts`
- `PUT /repos/:id`: accept `priority`. When defined, `const p = int(priority, 'Priority', -100, 100)`, then `run('UPDATE repos SET priority = ? WHERE id = ?', p, repo.id)` and `kick()` (import from `../scheduler/loop.ts`, beside `syncSoon`).

### `client/src/pages/Connections.tsx`
- `RepoRow`, when enabled: a second small form beside the image form, same pattern: `<input type="number" step={1} min={-100} max={100} className="small" style={{ width: 80 }} aria-label={`Priority for ${repo.fullName}`} …>` and a `Save priority` button, sending `{ priority: Number(value) }`. Keep the state as a string so the field can be cleared while typing.
- Show `Priority N` as a `tag` next to the name when it isn't 0, so the list is readable at a glance.
- Repos panel help text, appended: `Repositories with a higher priority go first: a lower one waits until every open ticket in the higher ones has been classified.`

### Docs
- `docs/design/workflow.md`: in the scheduling/queue section, a short paragraph on repo priority, the classification gate, and that pushes bypass it.
- `README.md`: one sentence where enabling repositories is described.
- `docs/api.md` / `openapi.ts`: no change; repo settings stay session-only, like `enabled` and `image`.

## Data and interfaces

- DB: `repos.priority INTEGER NOT NULL DEFAULT 0` (new migration at the end of `MIGRATIONS`).
- `RepoView.priority: number`.
- `PUT /api/repos/:id` body accepts `priority` (whole number, -100 to 100). Out of range or non-integer gives 400 `Priority must be a whole number from -100 to 100.`
- `QueueItem.blockedBy` carries the new reason; no shape change.

## Tests

Run `npm run typecheck` and `npm test`.

**`server/test/gates.test.ts`**
- `isUnclassified`: true for no labels; false with a stage label (including `reclassify`), with `skip`, `needs-info` or `failed`, when closed, and when `blockers` is non-empty.
- `priorityBlock`: null for an empty list, for equal and for lower priorities; one higher repo gives `Waiting for me/api to be classified first`; two tickets in one repo name it once; two repos are joined with "and".

**`server/test/pipeline.test.ts`** (uses `buildQueue` with the existing seeded repo `me/app`; add a second enabled repo `me/api` and set priorities with `UPDATE repos`)
- `me/api` priority 1 with an unclassified ticket, `me/app` priority 0 with a ticket at `stage:implement`: the `me/app` candidate has `blockedBy` `Waiting for me/api to be classified first`, and the `me/api` ticket comes first and is not held by the gate.
- Once the `me/api` ticket has `stage:design` (or `workshop/skip`, or a stored `blocked_by`), the `me/app` ticket is no longer held, and the `me/api` design step still sorts before the `me/app` implement step.
- Equal priorities: neither holds the other; order is as before (step priority).
- A pushed `me/app` ticket isn't held by the gate and sorts first.
- `launchNow` on the held `me/app` ticket starts it (`ignoreMode` skips the gate).
- An unclassified `me/api` ticket by a non-allowlisted author, or in a disabled repo, doesn't hold `me/app`.

**`server/test/api.test.ts`**
- `PUT /api/repos/:id` with `{ priority: 3 }` returns `priority: 3` in the view; `{ priority: 1.5 }` and `{ priority: 500 }` give 400 with the message above.

## Risks and open questions

- **Strict gate can stall a lower repo** if a higher repo's unclassified ticket can't be classified (for example the Classifier has no model, or that run keeps failing until `workshop/failed`). Failed tickets stop counting, so it is bounded by `MAX_ATTEMPTS`; a missing model blocks everything anyway. Accepted.
- **Classifier runs in flight** keep the gate closed, so with several host slots a lower repo can't start alongside a higher repo's classification. This follows the ticket's "at least classified" rule literally. If it proves too slow, relaxing it to "classified or being classified" is a one-line change in the `waiting` filter.
- **Tickets page** (`ticketView.next`) doesn't show the priority reason, because it needs a view over all repos; the dashboard queue does. Accepted to keep `ticketView` per-ticket.
- **API exposure:** priority can't be set with an API token, consistent with the other repo settings. If scripted control is wanted later, move the repo routes to `apiRouter` as a separate change.
