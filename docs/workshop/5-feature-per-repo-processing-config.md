# Per-repo processing: whole backlog or nominated tickets (#5)

## Context

Once a repository is on, Workshop works through every open ticket from an allowed author. You want a second option for a repository: Workshop still syncs it, but only works on the tickets you nominate. All other tickets are left alone.

## Approach

- **A per-repo setting.** The new column `repos.selection` holds `'all'` (the default, which keeps today's behaviour) or `'nominated'`. You set it in the repository row on the Connections page.
- **Nominate with a label.** Labels already hold the state, so a nomination is the label `workshop/nominated`. You can add it on GitHub, or press **Nominate** on the ticket card. Workshop never removes this label. To withdraw a nomination, remove the label.
- **One pure predicate.** `inScope(selection, labels)` in `scheduler/gates.ts` returns true for `'all'`, or when the labels include `workshop/nominated`. Every place that decides whether to start work checks it, the same way the author allowlist is checked:
  - `buildQueue`: an out-of-scope ticket is skipped (`continue`), not shown with a reason. A large backlog must not fill the dashboard queue.
  - `mergeApproved`: skip.
  - `settlePushes`: clear the push.
  - Push API: refuse with a 409.
- **Sync stays the same.** Every allowed author's ticket is still mirrored, so adding the label (which changes `updated_at`) is picked up on the next sync. The Tickets page can then list the tickets you might nominate.
- **Work already started is left alone.** A run that is in progress or paused finishes its current stage (`resumePaused` doesn't change). After that, an out-of-scope ticket is not queued again. Use Stop in the run view to stop sooner.

Why not a nominated-tickets list stored in Workshop? A label is visible on GitHub and can be edited there like every other `workshop/` state, and it needs no new table.

## Changes

### `server/src/db.ts`
Add a new migration at the end:
```sql
ALTER TABLE repos ADD COLUMN selection TEXT NOT NULL DEFAULT 'all';
```

### `server/src/api-types.ts`
- `export type RepoSelection = 'all' | 'nominated'`.
- `RepoView.selection: RepoSelection`.
- `TicketView.nominated: boolean | null`: null when the repo works on its whole backlog, otherwise whether this ticket has the label.

### `server/src/workflow/labels.ts`
- `label.nominated = 'workshop/nominated'`.
- Add a `LABEL_DEFS` entry: colour `7a6a53`, description `Workshop: work on this ticket when its repository only takes nominated tickets`.

### `server/src/scheduler/gates.ts`
- `export function inScope(selection: RepoSelection, labels: string[]): boolean`.

### `server/src/tickets.ts`
- `RepoRow.selection: RepoSelection`. `repoView` passes it through.
- `export const ticketInScope = (t: TicketRow, repo: RepoRow) => inScope(repo.selection, labelsOf(t))`.
- `ticketView`:
  - `nominated`: `repo.selection === 'nominated' ? labels.includes(label.nominated) : null`.
  - When the ticket is out of scope and `step` is set, `next` is `'Not nominated'`. This is checked before the dependency and step text.

### `server/src/scheduler/loop.ts`
- `buildQueue`: get the repo first (`const repo = getRepo(t.repo_id)!`, which is reused in the `out.push`). Then `if (!ticketInScope(t, repo)) continue;`, next to the author check.
- `mergeApproved`: `continue` when the ticket isn't in scope.
- `settlePushes`: add `!inScope(repo.selection, labelsOf(t))` to the conditions that clear a push.

### `server/src/http/api.ts`
- `POST /tickets/:id/push`: after `pushableTicket`, when `!ticketInScope(t, repo)`, return 409 `This repository only works on nominated tickets. Nominate this ticket first.`
- New `PUT /tickets/:id/nominated` with the body `{ nominated: boolean }`:
  - Look up the ticket with `pushableTicket`.
  - `check(typeof nominated === 'boolean', 'Say whether to nominate the ticket.')`.
  - `check(repo.selection === 'nominated', 'This repository works on its whole backlog, so tickets don\'t need nominating.', 409)`.
  - Call `editLabels(t, nominated ? [label.nominated] : [], nominated ? [] : [label.nominated])`.
  - When nominating, call `kick()`. Respond with `ticketView(t, repo)`.
  - The label is changed on GitHub first and then locally, so a GitHub error surfaces through the existing error handler and the mirror stays as it was.

### `server/src/http/connections.ts` (`PUT /repos/:id`)
- Accept `selection`, validated with `check(selection === 'all' || selection === 'nominated', 'Choose "all" or "nominated".')`.
- When the value is `'nominated'` and the repo is enabled, run `ensureLabels(repoRef(repo), LABEL_DEFS)` before saving. Repositories turned on before this change don't have the new label yet. Then `UPDATE repos SET selection = ?`.
- `publish('repos')` (already there), plus `publish('tickets')` and `publish('runs')`, because ticket `next` text and the queue change.

### `client/src/pages/Connections.tsx` (`RepoRow`)
When the repo is enabled, show a `<select>` labelled `Tickets to work on` with these options:
- `All open tickets`
- `Only nominated tickets`

Changing it calls `onChange(repo.id, { selection })`. Update the help text above the list to: `Workshop only works on repositories you turn on. Turning one on creates its workshop/ labels on GitHub. For a repository set to nominated tickets, add the workshop/nominated label to the tickets you want worked on.`

### `client/src/pages/Tickets.tsx`
- New `NominateControls` in `Card`:
  - `t.nominated === false` and the ticket is open: a **Nominate** button.
  - `t.nominated === true`: the muted text `Nominated` and a **Withdraw nomination** button.
  - Both call `PUT /tickets/:id/nominated`. Busy and error handling follow `PushControls`.
- Hide `PushControls` while `t.nominated === false`.

### Docs
- `docs/design/workflow.md`: add `workshop/nominated` to the labels table, and add a short "Nominated tickets only" section covering the setting, the label, that withdrawing doesn't stop a run in progress, and that the author allowlist still applies.
- `README.md`: one sentence where turning repositories on is described.

## Data and interfaces

- DB: `repos.selection TEXT NOT NULL DEFAULT 'all'`, added by a new migration. Existing repositories keep working on their whole backlog.
- New label: `workshop/nominated`. It's created when a repo is turned on, or when it's switched to nominated tickets.
- API:
  - `PUT /api/repos/:id` accepts `selection`.
  - New `PUT /api/tickets/:id/nominated {nominated}` returns a `TicketView`.
  - `POST /api/tickets/:id/push` can return a 409 for tickets that aren't nominated.
- Types: `RepoSelection`, `RepoView.selection`, `TicketView.nominated`.

## Tests

Run `npm run typecheck` and `npm test`.

- `server/test/gates.test.ts`: `inScope` is true for `'all'` without the label, false for `'nominated'` without it, and true for `'nominated'` with it.
- `server/test/pipeline.test.ts` (seed repo, `UPDATE repos SET selection = 'nominated'`):
  - A new ticket without the label is not in `buildQueue()`. It appears once its labels include `workshop/nominated`.
  - With `selection = 'all'`, the same ticket is queued, as before.
  - `mergeApproved` leaves a `stage:merge` ticket without the label alone and merges one with the label.
  - `settlePushes` clears a push on a ticket whose label was removed.
  - `ticketView(...).next` is `Not nominated`, and `nominated` is `false`, then `true` once labelled, and `null` for an `'all'` repo.
- `server/test/api.test.ts`:
  - `PUT /repos/:id {selection: 'bad'}` returns 400.
  - `PUT /tickets/:id/nominated` returns 409 on an `'all'` repo, and 400 for a non-boolean body.
  - `POST /tickets/:id/push` returns 409 with the nomination message for an un-nominated ticket in a `'nominated'` repo.
  - For calls that reach GitHub (`ensureLabels`, `setLabels`), test success in `pipeline.test.ts` with the fake provider, if `api.test.ts` has no fake.

## Risks and open questions

- **Switching an active repo to nominated tickets** stops further stages for in-flight tickets that don't have the label, including ones waiting at `pr-review` to merge. That's consistent, but it may surprise you. The Tickets page shows `Not nominated` on them, and one click on Nominate resumes them.
- **The default for newly enabled repos is `'all'`,** to match today's behaviour. If you'd rather new repos start with nominated tickets only, change the column default. That is a one-line change.
- **Sync still reads the whole backlog** of a nominated-only repo, and blockers are fetched for its tickets. This costs the same API calls as today, which is acceptable.
