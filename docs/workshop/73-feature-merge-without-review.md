# Merge without review (#73)

## Context

Today every pull request waits in `stage:pr-review` until you approve it on GitHub. For new projects you'd rather let a batch of tickets run overnight and read the pull requests afterwards. This adds a per-repository **Merge without review** setting, off by default:

- With it on, sync moves an open pull request from `stage:pr-review` to `stage:merge` without an approval. The merge step then waits on a `blocked` PR instead of sending it back to you.
- Requested changes still win: they move the ticket to `stage:reclassify`, as they do today.
- Workshop opens the pull request and requests your review exactly as before, so you can still read it.
- Turning the setting on checks the default branch's rules on GitHub. It is refused when a required approving review would stop Workshop from ever merging. It is allowed with a warning when there are no required checks or the rules can't be fully read.

## Approach

- **Store it on the repository.** Add `repos.merge_without_review` (a boolean) plus `repos.merge_warning`, the warning text saved when the setting was turned on. Saving the warning means it shows up again on every refetch and reload. The alternative, returning it only in the PUT response, would vanish when `publish('repos')` refetches the list. The warning is a snapshot from when you turned the setting on. Turning it off and on again checks again.
- **The setting is saved like the other repository settings.** It goes through `PUT /api/repos/:id` (`connectionsRouter`, session only, like `selection`, `priority` and `image`), so `openapi.ts` and `docs/api.md` don't change.
- **The branch check sits behind the provider.** Add `VcsHost.mergeRules(repo)`, which returns neutral facts: is a review required, are checks required, and what couldn't be read. A small pure function turns those facts into an error or a warning. The API handler calls both. Nothing GitHub-specific reaches the API or the scheduler.
- **Bypass actors.** The ticket's suggested fix ("add the App as a bypass actor") only works if the check can see bypasses. `GET /repos/{o}/{r}/rules/branches/{b}` lists every active rule, bypassed or not, and each rule carries its `ruleset_id`. For each `pull_request` rule that requires approvals, read `GET /repos/{o}/{r}/rulesets/{id}?includes_parents=true` and use `current_user_can_bypass`:
  - `always` or `pull_requests_only`: not a blocker, because merging a pull request is exactly what Workshop does.
  - `never`: a review is required.
  - Missing, or the read fails: inconclusive.
- **Classic protection.** `GET /repos/{o}/{r}/branches/{b}` gives `protected`, `protection.enabled` and `protection.required_status_checks`. When classic protection is enabled, try `GET …/branches/{b}/protection/required_pull_request_reviews`:
  - 200 with `required_approving_review_count ≥ 1`: a review is required.
  - 404: no review requirement.
  - Anything else (normally 403, because the App has no `administration` permission): inconclusive.

  Don't add the permission.
- **Sync and merge are each gated by one condition** on `repo.merge_without_review`. Everything else in `advanceMerge` (behind, conflict, clean, dependencies, nominated-only, allowlist) is untouched.

## Changes

### `server/src/db.ts`
Append one migration entry:
```sql
ALTER TABLE repos ADD COLUMN merge_without_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE repos ADD COLUMN merge_warning TEXT; -- what the branch check warned about when merge without review was turned on
```

### `server/src/tickets.ts`
- `RepoRow`: add `merge_without_review: number; merge_warning: string | null;`.
- `repoView`: add `mergeWithoutReview: Boolean(r.merge_without_review), mergeWarning: r.merge_without_review ? r.merge_warning : null`.

### `server/src/api-types.ts`
`RepoView`, after `selection`:
```ts
/** Merge pull requests once they're mergeable, without waiting for your approval. */
mergeWithoutReview: boolean;
/** What the branch check couldn't confirm when the setting was turned on (null when all was well or it's off). */
mergeWarning: string | null;
```

### `server/src/providers/types.ts`
```ts
/** What the default branch's rules mean for merging without a human review. */
export interface MergeRules {
  /** An approving review is required and Workshop can't bypass it. */
  reviewRequired: boolean;
  /** At least one status check must pass before merging. */
  checksRequired: boolean;
  /** Things that couldn't be read, phrased to follow "Workshop couldn't check …". Empty when everything was read. */
  unknown: string[];
}
```
Add to `VcsHost`: `/** The rules on the default branch that affect merging. */ mergeRules(repo: RepoRef): Promise<MergeRules>;`.

### `server/src/providers/github/index.ts`
Implement `mergeRules` as described in Approach, with `branch = repo.defaultBranch`:
1. `kit.paginate('GET /repos/{owner}/{repo}/rules/branches/{branch}', { per_page: 100 })`:
   - A rule `type === 'required_status_checks'` with a non-empty `parameters.required_status_checks` means `checksRequired`.
   - A rule `type === 'pull_request'` with `parameters.required_approving_review_count >= 1` needs a ruleset lookup (cache it by `ruleset_id` within the call). The result is `never` → `reviewRequired`, or bypass → skip, or otherwise `unknown.push(\`whether it can bypass the "${name}" ruleset on ${branch}\`)`.
2. `GET /repos/{owner}/{repo}/branches/{branch}`: non-empty `protection.required_status_checks.contexts` or `.checks` also means `checksRequired`.
3. If `protection.enabled` (fall back to `protected` if `protection` is absent), read the classic review settings as described above. Inconclusive means `unknown.push(\`the review settings of ${branch}'s branch protection (reading them needs the administration permission, which the Workshop App doesn't request)\`)`.

Use the existing `status(err)` helper for the status codes. Let other errors from steps 1 and 2 throw.

### `server/src/scheduler/merge.ts`
- Add a pure verdict next to `advanceMerge`:
  ```ts
  /** Whether merge without review can be turned on, and what to warn about. */
  export function mergeWithoutReviewVerdict(branch: string, rules: MergeRules): { error: string } | { warning: string | null }
  ```
  - `reviewRequired` gives `{ error: \`${branch} requires an approving review before merging, and the Workshop App can't approve its own pull requests. Remove the review requirement, or add the App as a bypass actor, then turn this on again.\` }`.
  - Otherwise, build the warning from these sentences, joined with a space, or `null` when there are none:
    - if `!checksRequired`: `` `No status checks are required on ${branch}, so failing CI won't stop a merge. Make CI a required status check.` ``
    - if `unknown.length`: `` `Workshop couldn't check ${unknown.join(' or ')}. If that requires an approving review, pull requests will wait in merge until you approve them.` ``
- `advanceMerge`: the repo is already loaded. Insert after `setPrStatus`, before the `switch`:
  ```ts
  // With merge without review, nothing else stops a merge, so requested changes are checked here.
  if (repo.merge_without_review && pr.decision === 'changes_requested') {
    const back = moveTo(labelsOf(t), 'reclassify');
    await editLabels(t, back.add, back.remove);
    return 'waiting';
  }
  ```
  In `case 'blocked'`, change the condition to `if (pr.decision !== 'approved' && !repo.merge_without_review)`. Add a comment that with the setting on, Workshop waits for required checks rather than for you.

### `server/src/scheduler/sync.ts` (`syncReviews`)
Replace the two lines after the `pr.state === 'closed'` branch:
```ts
else if (pr.decision === 'changes_requested' && (state.stage === 'pr-review' || repo.merge_without_review)) move = moveTo(labelsOf(t), 'reclassify');
else if (state.stage === 'merge') continue; // still open: the merge step handles it
else if (pr.decision === 'approved' || repo.merge_without_review) move = moveTo(labelsOf(t), 'merge');
```
With the setting off, this behaves exactly as today: approved goes to merge, changes requested to reclassify, and anything else waits.

### `server/src/http/connections.ts` (`PUT /repos/:id`)
- Read `mergeWithoutReview` from the body. Among the checks before any write: `if (mergeWithoutReview !== undefined) check(typeof mergeWithoutReview === 'boolean', 'Say whether to merge without review.');`.
- Still before any write, when `mergeWithoutReview === true`:
  ```ts
  let warning: string | null;
  try {
    const verdict = mergeWithoutReviewVerdict(repo.default_branch, await vcsFor(repo).mergeRules(repoRef(repo)));
    check(!('error' in verdict), 'error' in verdict ? verdict.error : '', 409);
    warning = (verdict as { warning: string | null }).warning;
  } catch (err) { if (err is the HttpError from check) throw err; warning = `Workshop couldn't read the rules for ${repo.default_branch} (${message}). …same tail as the unknown warning…`; }
  ```
  Structure it however reads best, for example with a small helper returning `{ error } | { warning }`. The point: a refusal is a 409 with the verdict's message, and a failed read is allowed with a warning that says what failed.
- Writes: `true` gives `UPDATE repos SET merge_without_review = 1, merge_warning = ?`. `false` gives `merge_without_review = 0, merge_warning = NULL` and needs no check. Call `kick()` when turned on, so waiting PRs move soon.

### `client/src/repo-settings.ts`
- `RepoDraft` gains `mergeWithoutReview: boolean`. `repoChanges` takes `'mergeWithoutReview'` in its `Pick`, and sends `body.mergeWithoutReview` when it differs. Widen the return type to `Record<string, string | number | boolean>`.

### `client/src/pages/Connections.tsx` (`RepoRow`)
- `saved()` includes `mergeWithoutReview: repo.mergeWithoutReview`.
- In the form, after Priority and before Image, add a checkbox label: `<label className="row small"><input type="checkbox" checked={draft.mergeWithoutReview} onChange={…} /><span className="muted">Merge without review</span></label>`. It saves with **Save changes** like the other fields. A refusal shows through the existing `ErrorNote` in `Repos`.
- Under the form, when `repo.mergeWithoutReview && repo.mergeWarning`, add `<p className="row small"><Status tone="attention">{repo.mergeWarning}</Status></p>`.
- Add one sentence to the Repositories panel's help text: "Merge without review merges each pull request as soon as GitHub allows it, without waiting for your approval. Make CI a required status check first."
- Add a tag next to Priority when it's on: `{repo.mergeWithoutReview && <span className="tag">Merges without review</span>}`.

### Docs
- `docs/design/workflow.md`:
  - "Your review": add a bullet saying that in a repository with Merge without review on, an open pull request goes to `stage:merge` on the next sync without an approval, and changes requested before it merges still go to `stage:reclassify`.
  - "Merging": add a row "blocked, merge without review on | Wait (required checks pending)", qualify the approval-dismissed row with "(setting off)", and add a short paragraph about the check when the setting is turned on. Recommend a required CI status check.
- `README.md` section "4. Repositories": one or two sentences describing the setting, the refusal when a review is required, and the recommendation to require CI.

## Data and interfaces

- DB: `repos.merge_without_review INTEGER NOT NULL DEFAULT 0`, `repos.merge_warning TEXT`.
- `RepoView`: `mergeWithoutReview: boolean`, `mergeWarning: string | null`.
- `PUT /api/repos/:id` accepts `mergeWithoutReview: boolean`:
  - 400 if it isn't a boolean;
  - 409 `{ error }` if a required review applies;
  - otherwise 200 with the repo view, including `mergeWarning`.
- `VcsHost.mergeRules(repo): Promise<MergeRules>`, a new interface in `providers/types.ts`.

## Tests

`server/test/pipeline.test.ts`, in `describe('sync')` (uses `repo()` and `pr()`). Set `UPDATE repos SET merge_without_review = 1 WHERE id = 1` in the new tests, and reset it in `afterEach` or a `finally`:
- With the setting on, `pr({})` (no decision) in `pr-review` gives `setLabels(…, [stage('merge')], [stage('pr-review')])`.
- With the setting on, `changes_requested` still goes to `reclassify`, from `pr-review` and from `merge`.
- With the setting off, `pr({})` in `pr-review` makes no label change. This already holds today; add an explicit assertion.
- `advanceMerge`: call `mergeApproved(false)` with labels `size:s`, `stage:merge`, `pr_number = 7`, and `pullRequestState` returning `pr({ mergeable: 'blocked' })`. With the setting on, the labels stay at `stage:merge` and `requestReview` isn't called. With it off, the ticket moves to `pr-review` and `requestReview(…, 7, 'me')` is called.

`server/test/api.test.ts`:
- Extend the `vi.mock` with `vcsOf: () => fakeVcs`, where `fakeVcs = vi.hoisted(() => ({ mergeRules: null as any }))`.
- Insert a repo whose `vcs_connection_id` points at a real `connections` row, because `vcsFor` throws without one.
- Cases:
  - `reviewRequired` gives 409, the error mentions the approving review and the bypass actor, and the row stays off;
  - `{ checksRequired: false, unknown: [] }` gives 200, `mergeWithoutReview: true`, and a `mergeWarning` matching `/No status checks are required on main/`;
  - non-empty `unknown` gives 200 with a warning naming what couldn't be checked;
  - `mergeRules` rejecting gives 200 with a "couldn't read the rules" warning;
  - all clear (`checksRequired: true, unknown: []`) gives `mergeWarning: null`;
  - `{ mergeWithoutReview: false }` gives 200, the row is off, the warning is cleared, and `mergeRules` isn't called;
  - `'yes'` gives 400.

`client/test/repo-changes.test.ts`: update the fixtures for the new field, and check that a toggled `mergeWithoutReview` is sent and an unchanged one isn't.

Run `npm run typecheck` and `npm test`. Optionally, look at the Repositories panel in a browser (both themes, phone width) with the checkbox and a warning shown.

## Risks and open questions

- **GitHub field shapes aren't verified against a live repository.** These include `current_user_can_bypass` on an installation token, `protection.enabled` for ruleset-only branches, and the 403 vs 404 from the classic reviews endpoint. Each uncertain case falls back to "inconclusive, allow with a warning", never a silent pass. The only exception is a ruleset that reports `never`, which is the documented meaning.
- The warning is a snapshot. Rules changed later on GitHub aren't re-checked. The failure is safe: a newly required review leaves the PR waiting in `merge`. An unfixable approval requirement would park PRs there with no message. Accept this for now.
- For up to one sync interval, a PR in such a repository sits in `pr-review`, and "Needs you" shows it as waiting for your review. This is acceptable and unchanged.
- Workshop still requests your review when it opens the PR (`runner.ts`), as the ticket asks, so you get a notification you don't have to act on.
