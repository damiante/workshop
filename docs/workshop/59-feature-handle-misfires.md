# Handle misfires: safe enrolment and a skip that removes the ticket (#59)

## Context

Some repositories use GitHub Issues for things Workshop must not touch, such as blog posts. Two gaps let Workshop act on them:

1. **Enrolment starts work at once.** `repos.selection` defaults to `'all'` (#5), so ticking a repository on the Connections page syncs it and queues every open ticket from an allowed author.
2. **`workshop/skip` doesn't fully take a ticket out.** Skip already keeps the ticket out of the queue (`nextStep` returns null), and `settlePushes` ends a hand push. But a skipped ticket still shows on the Tickets board in its stage column. A run that is in progress or paused when you add the label on GitHub carries on and publishes. Sync also keeps processing its pull request review (moving it to `merge` or `reclassify`). It can also still appear under **Needs you**.

Outcome:
- A newly enrolled repository works only on nominated tickets until you choose otherwise.
- Adding `workshop/skip` on GitHub takes the ticket out on the next sync, whether scheduled or from **Sync now**: any run on it stops, a push is cleared, its PR review is no longer processed, and it leaves the board and Needs you. Removing the label brings it back, as it does today.

## Approach

**1. Enrol in "Only nominated tickets".** Repository rows are created disabled by `POST /repos/refresh`. From now on that insert writes `selection = 'nominated'`. A migration also sets `selection = 'nominated'` on every repository that is currently disabled. A repository that is on keeps its setting. The insert's `ON CONFLICT` update doesn't touch `selection`, so a refresh never overrides your choice. Turning a repository on already creates the `workshop/nominated` label (it's in `LABEL_DEFS`), so you can nominate tickets straight away.

Why not a new "disabled" mode? "Only nominated tickets" already means "sync, but do nothing until I say so", and the ticket allows either option. SQLite can't change a column default without rebuilding the table, so the default is set where rows are inserted. The column default `'all'` stays, which keeps test fixtures that insert repositories directly unchanged.

**2. Skip in sync, the same way closing is handled.** `syncRepo` already stops the active run when an issue is closed. It will do the same when the incoming labels include `workshop/skip`. The existing gates then cover everything else: the queue, merges and pushes are all driven by `nextStep`, which returns null for skip. `tick()` runs `settlePushes()` straight after sync, so the push is cleared in the same tick. `syncReviews` skips open tickets that have the skip label. On the board, skipped tickets are hidden from every filter except **Skipped**. That filter stays so you can find a ticket again and un-skip it through **Change status**. `attentionOf` returns null for skipped tickets, so they leave Needs you as well.

## Changes

### `server/src/db.ts`
Append a migration:
```sql
-- New repositories only work on nominated tickets until you choose otherwise (#59).
UPDATE repos SET selection = 'nominated' WHERE enabled = 0;
```

### `server/src/http/connections.ts`
In `POST /repos/refresh`, add `selection` to the insert column list with the literal `'nominated'`: `INSERT INTO repos (vcs_connection_id, full_name, default_branch, private, url, selection) VALUES (?, ?, ?, ?, ?, 'nominated')`. Leave `ON CONFLICT … DO UPDATE` as it is.

### `server/src/scheduler/sync.ts`
- In `syncRepo`, change the stop condition to:
  ```ts
  const stopReason = t.state === 'closed' ? 'The ticket was closed.' : t.labels.includes(label.skip) ? `The ticket was labelled ${label.skip}.` : null;
  const active = existing && stopReason ? activeRunId(existing.id) : null;
  if (active) await stopRun(active, stopReason!, false);
  ```
  `stopRun` covers paused runs too (`ACTIVE_STATUSES`). Use `hold = false`, because the skip label already holds the ticket.
- In `syncReviews`, after `parseLabels`, add `if (state.skip && t.state === 'open') continue; // you took it out of Workshop`. Closed tickets still go through, so merging or closing on GitHub tidies up as before.

### `server/src/tickets.ts`
- `attentionOf`: add `'skipped'` to the `Pick`, and start with `if (v.skipped) return null;`.
- `ticketView`: pass `skipped: state.skip` to the call: `attentionOf({ ...state, skipped: state.skip, prStatus: …, activeRunId: … })`.

### `client/src/pages/Tickets.tsx`
- Give the `All`, `Needs you`, `Running` and `Failed` filters `!t.skipped &&` in their `match`. `Skipped` stays `(t) => t.skipped`. The board columns use `shown`, so skipped cards disappear from the default view.
- Add a short note under the filter row, shown only while the **Skipped** filter is selected: `Workshop leaves skipped tickets alone. To bring one back, remove the workshop/skip label or use Change status.` (a `<p className="muted small">`).

### `client/src/pages/Connections.tsx`
Update the help text above the repository list to: `Workshop only works on repositories you turn on. Turning one on creates its workshop/ labels on GitHub. A new repository only works on tickets you nominate with the workshop/nominated label. Switch it to all open tickets when you're ready.`

### Docs
- `README.md` (line ~101): say that a newly enrolled repository starts with nominated tickets only, and that adding `workshop/skip` removes a ticket from Workshop until you remove the label.
- `docs/design/workflow.md`:
  - Line ~95: the default for new repositories is nominated only. Repositories already on keep their setting.
  - In the label table, the `workshop/skip` row: adding it stops any run, clears a push and hides the ticket on the next sync.
- `server/src/http/openapi.ts` / `docs/api.md`: if `selection` has a description, note that new repositories start as `nominated`. There are no shape changes.

## Data and interfaces

- One migration (data only, no schema change). No API shape changes. `RepoView.selection` is now `'nominated'` for newly listed repositories.
- No new labels or settings.

## Tests

Write each test first and check that it fails.

- `server/test/api.test.ts`:
  - `describe('repository enrolment')`: with the fake VCS's `listRepos` returning a new repository, `POST /api/repos/refresh` lists it with `selection: 'nominated'`. Set an existing row to `'all'`, refresh again, and check that it is still `'all'`. If the API tests can't fake `listRepos` easily, test the migration instead: insert a disabled repository with `'all'`, run the migration's SQL, and expect `'nominated'`.
- `server/test/pipeline.test.ts`, in `describe('sync')`:
  - `describe('when you add workshop/skip')`:
    - With an active run (`status = 'running'`, and `'paused'` as a second case) on ticket 1, and `listChanged` returning `remote({ labels: [..., label.skip] })`: after `syncRepo`, the run is `cancelled` with an error mentioning `workshop/skip`, `env.kill` was called, and `workshop/failed` was **not** added.
    - With `stage:pr-review`, a PR, the skip label and `pullRequestState` returning `approved`: no `setLabels` call moving the ticket to `merge`.
    - With a push set (`setPush(t, 'lifecycle')`) and the skip label synced: `settlePushes()` clears it. This may already pass; keep it as a regression test.
- `server/test/workflow.test.ts`, in `describe('attentionOf')`: `attentionOf({ ...base, stage: 'pr-review', failed: true, skipped: true })` is null. Update `base` to include `skipped: false`.
- Client: the filter change is a one-line predicate, so no reducer test is needed. Check it in the browser instead. Run the dev server with a seeded skipped ticket and confirm that it is missing from **All** and listed under **Skipped**. Save a screenshot to `/work/media/`.

Run `npm run typecheck` and `npm test`.

## Risks and open questions

- **Disabled repositories are reset to nominated.** A repository that was set to "all", turned off, and is turned on again after this change comes back as nominated. That is the safe direction, and the select shows the setting right after you turn the repository on.
- **Stopping during `publishing`.** A skip label that arrives while a run is publishing kills the publish container mid-push. Closing the issue already does this. The branch may be left half-updated, but labels on a skipped ticket no longer matter.
- **Change status while a run is active** is still refused (`409`). Skipping from the Workshop UI mid-run means stopping the run first, as today. Skipping on GitHub stops it automatically on the next sync.
- Skipped tickets stay reachable on the board through the **Skipped** filter. They are hidden by default rather than removed from the list entirely, so you can un-skip them without going to GitHub.
