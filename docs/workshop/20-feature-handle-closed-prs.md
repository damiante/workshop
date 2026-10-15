# Handle closed pull requests and closed issues (#20)

## Context

Two ways of abandoning a ticket leave loose ends today:

- **You close Workshop's pull request without merging.** `stopAfterClosedPr` (`server/src/scheduler/merge.ts`) adds `workshop/skip`, clears the stage and comments, but the issue stays open forever.
- **You close the issue yourself.** `syncRepo` (`server/src/scheduler/sync.ts`) stops an active run, and `syncReviews` drops the stage of tickets at `pr-review`/`merge`. Stage labels at other stages, `workshop/needs-info`, Workshop's open pull request and its branch all stay behind.

Outcome:

- Closed PR → the issue is closed as **not planned**, with Workshop's labels cleared and a comment saying so.
- Issue closed by you → Workshop stops any run, clears its labels, closes its open PR (with a comment on the PR) and deletes the branch it created. A PR that was merged (GitHub closed the issue through "Closes #n") is still handled as a merge, never as an abandonment.

## Approach

- **Closed PR.** `stopAfterClosedPr` removes the stage labels, `running` and `needs-info`, closes the issue with reason `not_planned`, sets `state = 'closed', pr_status = 'closed'`, and comments: `The pull request was closed without merging, so Workshop closed this issue as not planned. Reopen the issue to start again from classification.` No more `workshop/skip`: a closed issue already gets no work (`nextStep(…, open = false)`), and reopening it is the natural way back. The branch is kept: it's the head of your closed PR, and GitHub offers its own "Delete branch" / "Restore branch" there.
  Because the local row is set to closed before the next sync, the sync doesn't see an open → closed transition and doesn't run the manual-close cleanup on top.
- **Manual close.** In `syncRepo`, detect the transition (`existing?.state === 'open' && t.state === 'closed'`), and after the upsert (and the existing `stopRun`) call a new `cleanUpClosedIssue(getTicket(existing.id)!)` in `merge.ts`:
  1. Find the PR: `t.pr_number ?? (t.branch ? await vcs.findPullRequest(ref, t.branch) : null)`.
  2. If there is one, read `pullRequestState`. `merged` → `await finishMerged(t)` and return (the merge path owns this). `open` → `commentOnPullRequest(…, 'The issue was closed, so Workshop closed this pull request.')`, then `closePullRequest`. Record `pr_status = 'closed'` unless merged.
  3. If `t.branch` is set (only Workshop's `createBranch` sets it), `deleteBranch(ref, t.branch)`.
  4. `editLabels(t, [], [...moveTo(labelsOf(t), null).remove, label.running, label.needsInfo])`. Size, `skip` and `failed` stay: they're your signals, and harmless on a closed issue.
  No comment on the issue (as today: "stop quietly").
  Wrap the call in `try/catch`; on failure `raiseAlert('warning', 'close-cleanup', \`Couldn't tidy up after ${repo.full_name}#${n} was closed: ${message}\`, \`ticket:${id}\`)` and carry on with the rest of the sync, like `syncBlockers` does per ticket. The row is already closed, so it isn't retried; the alert tells you what to tidy by hand. Retrying by deferring the upsert was rejected: the upsert would then overwrite the labels `editLabels` just removed with the stale remote list.
- Only allowlisted authors' tickets reach this code (the existing `isAllowedAuthor` filter), and a ticket first seen already closed (`existing` undefined) has nothing to clean.
- The existing `else if (t.state === 'closed') move = moveTo(…, null)` in `syncReviews` stays as a fallback; after the cleanup it finds no stage and skips the ticket.

## Changes

### `server/src/providers/types.ts`
- `TicketSource.close(repo, number, reason?: 'completed' | 'not_planned')`, doc: `Defaults to completed.`
- `VcsHost`: add `closePullRequest(repo: RepoRef, number: number): Promise<void>` and `deleteBranch(repo: RepoRef, branch: string): Promise<void>` (doc: `Missing branches are ignored.`).

### `server/src/providers/github/index.ts`
- `close`: pass `state_reason: reason ?? 'completed'`. The 422 fallback stays.
- `closePullRequest`: `PATCH /repos/{owner}/{repo}/pulls/{pull_number}` with `state: 'closed'`.
- `deleteBranch`: `DELETE /repos/{owner}/{repo}/git/refs/{ref}` with `ref: \`heads/${branch}\``; ignore 404 and 422 (already gone), using the file's `status(err)` helper.

### `server/src/scheduler/merge.ts`
- `stopAfterClosedPr`: as described above. It doesn't stop runs itself: `runner.ts` imports `merge.ts`, so `merge.ts` must not import `runner.ts`. `advanceMerge` only runs when no agent is active, and `syncReviews` handles the other case (below).
- New `export async function cleanUpClosedIssue(t: TicketRow)`: as described above.

### `server/src/scheduler/sync.ts`
- In the `syncRepo` loop, after `stopRun`, call `cleanUpClosedIssue` on the open → closed transition inside `try/catch` with the alert.
- In `syncReviews`, before `stopAfterClosedPr(t)`: `const active = activeRunId(t.id); if (active) await stopRun(active, 'The pull request was closed.', false);` (a Merge agent may be resolving a conflict on that PR).

### Docs
- `docs/design/workflow.md`: replace the "Pull request closed without merging" bullet (line ~71): `Workshop closes the issue as not planned and comments; reopen the issue to start again from classification.` Add a bullet: `**Issue closed by you:** Workshop stops any run, clears its labels, closes its open pull request and deletes the branch it created.` The table row "Closed … → Nothing" is unchanged.
- `README.md` line ~117: `Closing the issue stops work on it, and Workshop closes its pull request and deletes its branch. Closing the pull request closes the issue as not planned.`

## Data and interfaces

No schema, HTTP API or OpenAPI changes. Provider interfaces change as above; the GitHub App already has pull request and contents write permission.

## Tests

In `server/test/pipeline.test.ts` (fakes: add `closePullRequest: vi.fn(async () => {})`, `deleteBranch: vi.fn(async () => {})` to `fake.vcs` and `close: vi.fn(async () => {})` to `fake.tickets` in `beforeEach`; reset `branch = NULL, state = 'open', pr_status = NULL` on ticket 1 there too):

- Update "stops (rather than starting over) when you close the pull request": expects `close(…, 3, 'not_planned')`, labels removed without adding `skip`, comment containing `closed without merging`, row `state = 'closed'`, and `closePullRequest`/`deleteBranch` not called.
- Closed PR at `merge` stage with an active run: the run ends `cancelled`.
- Update "drops the stage when you close the issue without merging" (ticket open locally, PR open, `branch` set): `commentOnPullRequest` and `closePullRequest(…, 7)` called, `deleteBranch(…, 'workshop/3-…')` called, stage removed, `fake.tickets.comment` not called.
- Manual close at `implement` with `needs-info`, no PR, a branch: labels cleared, branch deleted, no PR calls.
- Manual close where the PR is merged ("Closes #n"): `finishMerged` path (`pr_status = 'merged'`), no `closePullRequest`, no `deleteBranch`.
- Manual close where `closePullRequest` throws: an alert of kind `close-cleanup` is raised and `syncRepo` still completes (`repos.synced_at` updated).
- A ticket already closed locally that changes again: no cleanup calls.

Run `npm run typecheck` and `npm test`.

## Risks and open questions

- Deleting the branch is irreversible from Workshop's side (GitHub keeps the commits reachable from the closed PR, so "Restore branch" still works there). It only touches a branch recorded in `tickets.branch`, which Workshop created.
- Reopening an abandoned ticket keeps its old `pr_number`, so the next implementation comments on the closed PR rather than opening a new one. This already happens today when you remove `workshop/skip` after closing a PR; leave it for a follow-up ticket.
- The closed-PR path keeps the branch, the manual-close path deletes it. If the owner prefers the branch deleted in both cases, call `deleteBranch` at the end of `stopAfterClosedPr` too.
