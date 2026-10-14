# Hold tickets that depend on unfinished tickets (#4)

## Context

Workshop starts work on any open ticket from an allowlisted author. When one ticket needs another one finished first (for example #3 needs #2's API), Workshop builds it against code that doesn't exist yet. We want GitHub's own issue dependencies ("blocked by") to be the source of truth:

- A ticket with an open blocker doesn't start an agent at any stage. The dashboard queue says why.
- The Classifier can see the repo's other open tickets and can answer `blocked`. Workshop then adds the links on GitHub and comments the reason. The ticket stays unsized, with no branch and no stage label.
- Once every blocker is closed, the ticket is released. Because its labels never changed, the Classifier runs again on up-to-date code.

## Approach

- **Read blockers cheaply.** The issue list already includes `issue_dependencies_summary.blocked_by`, the count of *open* blockers. `listChanged` copies it into `RemoteTicket.openBlockers`. Only tickets with a non-zero count, or tickets already held locally, get the extra `GET …/dependencies/blocked_by` call. That call returns the names used in the queue reason.
- **Store the open blockers locally.** Add the column `tickets.blocked_by`, a JSON list of display refs such as `["#2", "other/repo#5"]`. The scheduler stays synchronous and never calls GitHub from `buildQueue`.
- **Re-check held tickets every sync.** Closing a blocker may not change the blocked issue's `updated_at`, so `since` can miss the release. Each sync fetches the blockers again for every open ticket whose stored list isn't empty.
- **Gate in the scheduler.** A pure `dependencyBlock(refs)` in `gates.ts` returns `Depends on #2` (`Depends on #2 and #5`, `Depends on #2, #5 and #7`), or null. `buildQueue` checks it first, so the queue shows the dependency instead of a less useful reason. `mergeApproved` also skips held tickets, so an approved pull request isn't merged before its blocker. That covers the ticket's "only pauses it" case. Paused runs that are already under way still resume; they aren't new starts.
- **`blocked` changes no labels.** In normal mode the ticket already has no stage and no size, so the plan adds the links, comments, and stores the refs. In delta mode (`stage:reclassify`), the same plan keeps `reclassify`, and the Classifier sizes the requested changes again once the ticket is released. One rule covers both modes, and the gate does the holding.
- **Avoid a classify loop.** If the Classifier names only closed issues, adding links would hold nothing, and the Classifier would run again straight away. `publishRun` throws (`#2 is already closed, so this ticket can't wait for it.`) when none of the named blockers is open. The run then fails through the usual `fail()` path, which is bounded by `MAX_ATTEMPTS`.
- **Prompt.** The Classifier's task prompt gets a section listing the repo's other open tickets, with a nudge to use `blocked`. The nudge goes in `taskLine` as well as in the default prompt, so it still works when someone has customised the Classifier prompt.

## Changes

### `server/src/providers/types.ts`
- `RemoteTicket`: add `openBlockers?: number`. Undefined means the source didn't say; treat it as 0.
- Add `export interface TicketLink { repo: string; number: number; state: 'open' | 'closed'; url: string }`. `repo` is the full name.
- `TicketSource`: add
  - `blockers(repo: RepoRef, number: number): Promise<TicketLink[]>`: the tickets this one is blocked by, open and closed;
  - `addBlocker(repo: RepoRef, number: number, blocker: number): Promise<TicketLink>`: links `blocker`, from the same repo, as blocking `number`, and returns the blocker. It is idempotent.

### `server/src/providers/github/index.ts`
- `listChanged`: set `openBlockers: (i as { issue_dependencies_summary?: { blocked_by?: number } }).issue_dependencies_summary?.blocked_by ?? 0`. Use a cast because octokit 5's types may not include the field.
- `blockers`: `kit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by', { …, per_page: 100 })`. Map each item to `TicketLink`. Take `repo` from `repository_url` (the last two path segments), falling back to `html_url`.
- `addBlocker`:
  1. Call `GET /repos/{owner}/{repo}/issues/{blocker}`. A 404, or a result with `pull_request` set, throws `#n isn't an issue in owner/repo.`
  2. If `(await this.blockers(repo, number))` already contains it, return it.
  3. Otherwise `POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by` with `{ issue_id: data.id }`. This is the REST `id`, not the number.
  4. Return the `TicketLink`.

  Let errors such as 422 (a cycle) propagate: the run fails with GitHub's message.
- No App permission change: `issues: write` covers dependencies.

### `server/src/db.ts`
- Append the migration `ALTER TABLE tickets ADD COLUMN blocked_by TEXT NOT NULL DEFAULT '[]';`.

### `server/src/tickets.ts`
- `TicketRow`: add `blocked_by: string`. Add `blockersOf(t): string[]` (`JSON.parse`).
- Add `linkRef(link: TicketLink, repo: RepoRow)`: `#n` when `link.repo` is the ticket's repo (compare case-insensitively), else `owner/repo#n`.
- Add `setBlockers(t: TicketRow, refs: string[])`: writes the column, updates `t`, and publishes `'tickets'` when the value changed.
- `ticketView`: when `next` is non-null and the ticket is held, set `next` to `dependencyBlock(blockersOf(t))`, so the tickets page agrees with the queue. `dependencyBlock` comes from `scheduler/gates.ts`, which has no runtime imports that would make a cycle.

### `server/src/scheduler/sync.ts`
- Keep the upsert as it is (the new column is not in it). After the loop over `changed`, call `syncBlockers(repo, changed)`:
  - Targets: open changed tickets with `openBlockers > 0`, plus every open ticket in this repo with `blocked_by != '[]'`, de-duplicated by number.
  - Changed tickets with `openBlockers` of 0 (or undefined) and a non-empty stored list: set `[]` without a request.
  - For each target: `setBlockers(t, (await source.blockers(ref, n)).filter(open).map(linkRef))`.
- Call it before `syncReviews`. If it throws, the whole sync fails as it does today (`sync-failed` alert) and keeps the stored values, so the hold stays.

### `server/src/scheduler/gates.ts`
- `export function dependencyBlock(refs: string[]): string | null`, as described above.

### `server/src/scheduler/loop.ts`
- `buildQueue`: `let blockedBy = dependencyBlock(blockersOf(t)) ?? modeReason;`.
- `mergeApproved`: skip tickets where `blockersOf(t).length > 0`.

### `server/src/workflow/schemas.ts`
- `ClassifierResult.decision` gains `'blocked'`. Add `blocked_by?: number[]`.
- `CLASSIFIER_SCHEMA`: add `'blocked'` to the enum. Add `blocked_by: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'Numbers of the open tickets above that must be finished first (blocked only).' }`.
- `parseResult`: accept `blocked`. It requires a non-empty `blocked_by` of positive integers, or returns `blocked requires blocked_by: the numbers of the tickets this one waits for.` Update the "decision must be…" message.

### `server/src/workflow/transitions.ts`
- `Plan`: add `addBlockers?: number[]`.
- `planClassifier`, for `blocked` (both modes): `{ add: [], remove: [], addBlockers: r.blocked_by, comment }`, where the comment is:
  `Workshop will wait for #2 and #5 before working on this ticket: <reason>\n\nIt carries on once they're closed. Change this under Relationships on the issue.`
  Format the list as in `dependencyBlock`.

### `server/src/scheduler/runner.ts`
- **`publishRun`**: when `plan.addBlockers` is set, before the label edit:
  1. Add each blocker with `source.addBlocker` (skipping the ticket's own number) and keep the open ones.
  2. If none is open, throw the error above.
  3. Otherwise `setBlockers(t, open.map(linkRef))`.

  Re-running is safe, because `addBlocker` is idempotent.
- **Building the task prompt**, for `r.agent === 'classifier'`: pass `openTickets` from
  `SELECT number, title, body, author FROM tickets WHERE repo_id = ? AND state = 'open' AND id != ? ORDER BY updated_at DESC`, filtered by `isAllowedAuthor`. The sync table only ever holds allowlisted authors' tickets, but the allowlist can change, so filter again.

### `server/src/workflow/prompts.ts`
- `TaskContext`: add `openTickets?: { number: number; title: string; body: string }[]`.
- `taskPrompt`: when `openTickets` is non-empty, add `## Other open tickets in this repository` before `## Your task`.
  - Show at most 30 tickets, in the order given. For each, write `### #n: title`, then the body trimmed and cut to 600 characters, with `…` when cut.
  - Then add `_N more open ticket(s) left out._` when some were dropped.
- `taskLine` (classifier, both modes): when other tickets were listed, append: `If this ticket can't be done until one of the other open tickets above is finished, return "blocked" with their numbers in blocked_by and the reason.`
- `DEFAULT_PROMPTS.classifier`: add step 5: `Use "blocked" when the ticket depends on another open ticket being finished first (for example it needs an API that ticket adds). List those ticket numbers in blocked_by. Don't use it for loose relations.`

### Docs
- `docs/design/workflow.md`:
  - add a row to the transition table: Classifier, blocked, no label change, add blocked-by links and comment;
  - update the Classifier result schema line;
  - add a short note on the dependency hold and that it's re-checked each sync.
- `README.md` step 1: one sentence saying that a ticket waits while GitHub shows it as blocked by an open issue.

No client changes: the queue already shows `blockedBy` ("Waiting: Depends on #2").

## Data and interfaces

- DB: `tickets.blocked_by TEXT NOT NULL DEFAULT '[]'` (new migration).
- `TicketSource`: `blockers`, `addBlocker`. `RemoteTicket.openBlockers`. New type `TicketLink`.
- Classifier result: `decision: 'blocked'`, `blocked_by: number[]`.
- No API or `api-types.ts` shape changes: `QueueItem.blockedBy` and `TicketView.next` carry the text.

## Tests

Run `npm run typecheck` and `npm test`.

**`server/test/gates.test.ts`**
- `dependencyBlock`: `[]` gives null, and one, two and three refs read correctly.

**`server/test/workflow.test.ts`**
- `parseResult`:
  - `blocked` with `blocked_by: [2]` is accepted;
  - `blocked` without `blocked_by`, or with an empty list or non-integers, is rejected.
- `planTransition`: classifier `blocked` in both modes gives `addBlockers: [2]`, no label edits, no `createBranch`, and a comment that mentions `#2`.
- `taskPrompt`:
  - a classifier prompt includes the other open tickets section and the `blocked` instruction;
  - a long body is truncated, and the extra tickets are counted;
  - non-classifier prompts don't include the section.

**`server/test/pipeline.test.ts`**. Extend `fake.tickets` with `blockers` and `addBlocker` mocks.
- Classifier returns `blocked` with `[2]`:
  - `addBlocker` was called with `(…, 3, 2)`;
  - the comment was posted;
  - `setLabels` only removed `workshop/running`;
  - `createBranch` wasn't called;
  - `tickets.blocked_by` is `["#2"]`;
  - `buildQueue()` shows the ticket with `blockedBy` `Depends on #2`.
- Classifier names only a closed issue: the run fails with the readable message, and nothing is stored.
- Prompt: seed another open ticket by `me` and one by `stranger`. Then check that the classifier's `.workshop/prompt.md`, as captured by `FakeEnv`, has the first and not the second.
- Sync, hold: `listChanged` returns the ticket with `openBlockers: 1`, and `blockers` returns open `#2`. Then `blocked_by` is `["#2"]` and the queue holds the ticket.
- Sync, release without a change: `listChanged` returns `[]`, and `blockers` returns `#2` closed. Then `blocked_by` is `[]` and the hold is gone.
- `mergeApproved` doesn't merge a held ticket at `stage:merge`, if the existing merge tests make this easy to arrange. Otherwise cover it with the `buildQueue` check.

**`server/test/github.test.ts`**. Use the existing `kit` spy pattern.
- `addBlocker` posts `{ issue_id }` using the issue's `id`.
- `addBlocker` skips the POST when the link already exists.
- `addBlocker` refuses a pull request number.
- `listChanged` maps `issue_dependencies_summary.blocked_by`. Spy `paginate` as well.

## Risks and open questions

- **A blocker added to a ticket that hasn't changed and isn't held** is only seen when GitHub bumps the ticket's `updated_at`, which adding a relationship normally does. If it doesn't, the next change to the ticket picks it up. A manual "Sync now" (`syncSoon`) doesn't help, because it uses `since` too. This is accepted, in line with the ticket's out-of-scope note.
- **If GitHub stops returning `issue_dependencies_summary`**, tickets aren't held: the gate fails open. That's acceptable for a planning aid, unlike the allowance gate.
- **Cost:** one extra request per held ticket per sync. That's fine at the expected scale.
- **Cross-repo blockers** are honoured when read. The Classifier only proposes same-repo tickets, because only those are in its prompt.
- **octokit types** may lack the dependency routes. `request` still accepts the route string. If `tsc` complains, cast the response data to a small local type rather than adding a dependency.
