# 157: Repository setting for the lowest severity that sends a ticket back for rework

## Context

The Code reviewer sends a ticket back for rework only when it reports a **severe** finding (`stageForRework` and `planReview` in `server/src/workflow/transitions.ts`). Moderate findings, which are real gaps the agent could fix, go straight to the pull request. In push-to-default repositories it's worse: they end up only in a ticket comment, and nobody tracks them once the ticket closes.

Outcome:

1. A per-repository setting **"Send back for rework on"**: `severe` (default, today's behaviour), `moderate` or `minor`. Every place that filters on `severity === 'severe'` uses it instead.
2. In push-to-default repositories, findings left over at or above the threshold become follow-up tickets (`workshop/raised`), and the work is pushed anyway. Only severe findings left after rework still hold the ticket with `needs-info`.
3. A stricter rubric: moderate needs a verified, concrete consequence. A new `consequence` field is required for severe and moderate findings. Workshop downgrades any severe or moderate finding whose `consequence` is empty to minor.

## Approach

**Threshold.** Add `type ReworkOn = 'severe' | 'moderate' | 'minor'` to `api-types.ts`. In `transitions.ts`, add one helper that every threshold check uses:

```ts
/** Whether a finding is at or above the repository's rework threshold. */
export const qualifies = (f: Finding, on: ReworkOn) => SEVERITY_ORDER.indexOf(f.severity) <= SEVERITY_ORDER.indexOf(on);
```

`PlanContext` gets `reworkOn?: ReworkOn` (undefined means `severe`, like `pushToDefault`), so existing tests and callers keep today's behaviour.

**Downgrade first.** `planReview` begins by passing `r.findings` through a pure `effectiveFindings(findings)`, which maps a severe or moderate finding with an empty or whitespace-only `consequence` to `severity: 'minor'`. Everything after that (routing, `rework.findings`, the comment, `reviewSection`, follow-ups) uses the downgraded list, so a vague finding can't send a ticket back or raise a ticket, and it shows as Minor in the pull request. Build the `ReviewResult` for `reviewSection` from the downgraded list too (`{ ...r, findings }`).

**Routing (`planReview`).** Replace `severe` with `qualifying = findings.filter((f) => qualifies(f, on))`. The rest keeps its shape:
- `stageForRework(size, findings, on = 'severe')` filters with `qualifies`.
- The send-back stores `qualifying` in `rework.findings`, lists them in the comment, and computes `unfixed = count > 0 && qualifying.some((f) => f.repeat)`.
- `MAX_REWORKS` and the unfixed-repeat rule stay unchanged, so a lower threshold still can't loop.
- `exhausted = target !== null`, as now.

**Copy that follows the threshold.** Add one helper, `problems(n, on)`: "1 severe problem" when `on === 'severe'`, otherwise "2 problems". Use it in the send-back comment. For the exhausted copy, make `EXHAUSTED_TEXT` a function `exhaustedText(on)`. With `severe` it keeps today's text. Otherwise it reads "**The code review still found problems after Workshop's rework. Read them before approving.**" `reviewSection(r, exhausted, on)` uses it. In the three `@author` hold comments in `planReview`, also say "found problems" instead of "found severe problems" when `on !== 'severe'`. Keep the wording otherwise identical, because tests match it.

**Push-to-default follow-ups.** In the `ctx.pushToDefault && !ctx.hasPr` branch:
- **Follow-ups**: every finding that `qualifies` (after the downgrade). This branch is only reached when none of them is being sent back: either nothing qualifies, or rework was exhausted or unfixed. Below-threshold findings never become tickets. They are listed in the comment through `reviewSection`, as now.
- **Hold**: only when a **severe** finding remains *and* the rework was exhausted (`exhausted && findings.some(f => f.severity === 'severe')`). This uses today's hold copy and adds `needs-info`. The follow-ups are still stored, so if the owner removes `needs-info` to push it as it is, the remaining problems get tickets too. If the owner sends the ticket back instead, the next review replaces them.
- **Otherwise**: push, the same as today's non-exhausted path, even when moderate findings are left after `MAX_REWORKS` or an unfixed repeat.
- When follow-ups will be raised (`ctx.raiseTickets && !ctx.labels.includes(label.raised)`), the comment adds "Workshop opens a follow-up ticket for each problem at or above the rework threshold once this is pushed." When they won't be (the setting is off, or this ticket was itself raised), they stay in the comment only, as today.

The plan carries them as `followUps: Finding[] | null`. `planReview` sets it on **every** done path: `null` for the PR paths, the send-back and empty lists. A fresh review therefore always replaces what an earlier one stored. This also covers "raise once, from the final review": a send-back stores nothing, and only the review that lets the ticket through leaves follow-ups behind. `publishRun` stores them with the review's run id (`{ runId, findings }`), since the plan is pure and doesn't know it.

**When they're raised.** The commit that lands on the default branch exists only after `pushToDefault` in `server/src/scheduler/merge.ts` succeeds. That can be several ticks later, after a behind-merge or a Merge agent run. So the review's publish stores the follow-ups on the ticket (`tickets.follow_ups`), and `pushToDefault` raises them:

1. At the top of `pushToDefault`, if `follow_ups.commit` is already set, an earlier attempt pushed. Skip to step 3. Without this, a retry would see the branch "behind" the new commit and try to merge.
2. After `vcs.pushToDefault` returns `ok`, write `commit: { sha, url }` into `follow_ups` before anything else.
3. `raiseFollowUps(t)` opens a ticket for each finding. It posts the existing "Workshop pushed this to …" comment, with the list of follow-ups appended, then calls `finishMerged`, which clears `follow_ups`.

If GitHub fails part-way, the error goes up to `advanceMerge`'s caller as it does today. The next tick resumes at step 1, and tickets already opened are skipped by the same-title check against `tickets.raised`. A ticket with no `follow_ups` row behaves exactly as today.

**Duplicate checks (reuse).** Move `storeCreated`, `sameTitle`, `checkRaiseRate`, `MAX_RAISED_TITLE` and `MAX_RAISED_BODY` out of `runner.ts` into a new `server/src/scheduler/raise.ts`. This lets `merge.ts` use them without importing `runner.ts`, which already imports `merge.ts`. Re-export `checkRaiseRate` from `runner.ts`, or update its imports in `loop.ts` and `pipeline.test.ts`. `raiseFollowUps` lives in `raise.ts` and, for each finding:
- title: `clip(f.title)` (at most `MAX_RAISED_TITLE`);
- skip it when an open ticket in the repo or an entry in this ticket's `raised` has the same title (`sameTitle`);
- otherwise `bestMatch({ title, body }, candidates)`, with the same candidates `raiseBlockers` uses (open `workshop/raised` tickets from allowed authors). On a match, link nothing, list "already covered by #n" in the pushed comment, and append a line to the review run's log the way `raiseBlockers` does;
- otherwise `createTicket` with labels `[label.raised]`, then `storeCreated`. Record it in `tickets.raised` with the review's `runId` immediately, then call `checkRaiseRate`;
- re-check `mayRaise` against the repo as it is now (`getRepo`). If the setting was turned off since the review, raise nothing.

Follow-up body, built by a pure `followUpBody(f, ticket, commit)` in `transitions.ts` and covered by unit tests:

```
<detail>

**What goes wrong:** <consequence>
**Where:** `file:line`            (omitted when there's no file)
**Checked:** <evidence>
**Fix:** <fix>

---
_Workshop's Code reviewer found this in the work for #<n>, which was pushed to `<default>` as [`<sha7>`](<url>) without fixing it._
```

**Rubric.** Rewrite step 4 of `DEFAULT_PROMPTS['code-review']`:
- severe: unchanged list.
- moderate: only a problem you verified (by reading the code path or running something) that has a concrete consequence. State the specific input or situation and what goes wrong: wrong output, a crash on an unusual path, data shown to the wrong person, or changed behaviour with no test covering it.
- minor: everything else, including style, naming, refactors, "could be cleaner", speculative risks ("might be a problem if…"), missing tests for code that didn't change, and convention deviations with no behavioural effect.
- "When in doubt, choose the lower severity."
- Drop the "Severe findings send the ticket back automatically…" sentence from the default. It moves to fixed text.

Mirror the rubric in the schema's `severity` description (`schemas.ts`), which every reviewer gets regardless of prompt. Also add a code-review-only bullet to `protocolText`: `protocolText({ …, review: reworkOn })`, passed only for `code-review` in `runner.ts`. The bullet restates the moderate and minor rules in one sentence, says that a severe or moderate finding without a `consequence` counts as minor, and gives the routing line from the threshold:
- `severe`: "Severe findings send the ticket back automatically; everything else goes to the owner."
- `moderate`: "Severe and moderate findings send the ticket back automatically; minor ones go to the owner."
- `minor`: "Every finding sends the ticket back automatically."

Say "to the owner", not "in the pull request", because push-to-default has none.

**Rework task text (`prompts.ts`).** `TaskContext` gets `reworkOn?: ReworkOn`, and `runner.ts` passes `repo.rework_on`:
- implement: "Fix the severe code review findings above" becomes "Fix the code review findings above" when `reworkOn !== 'severe'`.
- The code-review heading "## Severe findings from the previous code review" drops "Severe" the same way.
- Change the agent description in `AGENT_INFO` ("sends severe problems back…") to "sends problems back to design or implementation".

## Changes

- `server/src/db.ts`: append one migration:
  ```sql
  ALTER TABLE repos ADD COLUMN rework_on TEXT NOT NULL DEFAULT 'severe'; -- severe, moderate or minor: the lowest code review severity that sends a ticket back
  ALTER TABLE tickets ADD COLUMN follow_ups TEXT; -- JSON: code review findings to open as tickets once the work is pushed to the default branch
  ```
- `server/src/api-types.ts`: `export type ReworkOn = 'severe' | 'moderate' | 'minor';` and `RepoView.reworkOn: ReworkOn`, with a doc comment.
- `server/src/tickets.ts`: `RepoRow.rework_on: ReworkOn`, `TicketRow.follow_ups: string | null`, `repoView` maps `reworkOn`, and `followUpsOf(t)` next to `reworkOf`.
- `server/src/workflow/schemas.ts`:
  - `Finding.consequence?: string`;
  - a `FollowUps` interface `{ runId: string; findings: Finding[]; commit?: { sha: string; url: string } }`;
  - in `REVIEW_SCHEMA`, a `consequence` property ("The specific input or situation and what goes wrong. Required for severe and moderate; empty for minor."), added to `required` so the agent always fills it in;
  - `isFinding` accepts a missing `consequence`, for stored rework and rescue results, and requires a string when it's present;
  - the stricter `severity` description;
  - update the `parseResult` error message's field list.
- `server/src/workflow/transitions.ts`: `qualifies`, `effectiveFindings`, `stageForRework(size, findings, on)`, `problems(n, on)`, `exhaustedText(on)`, `reviewSection(r, exhausted, on)`, `followUpBody`, `PlanContext.reworkOn` and `PlanContext.raiseTickets`, `Plan.followUps`, and the `planReview` changes above. Update the doc comments that say "severe".
- `server/src/workflow/prompts.ts`: the rubric, `protocolText`'s `review` option, `TaskContext.reworkOn` and the task copy above.
- `server/src/scheduler/raise.ts` (new): the moved helpers plus `raiseFollowUps`.
- `server/src/scheduler/runner.ts`:
  - pass `reworkOn` and `raiseTickets` into `planTransition`, `reworkOn` into `taskPrompt`, and `review` into `protocolText` for the Code reviewer;
  - in `publishRun`, next to the `plan.rework` write, run `if (plan.followUps !== undefined) run('UPDATE tickets SET follow_ups = ? …', plan.followUps?.length ? JSON.stringify({ runId: r.id, findings: plan.followUps }) : null)`;
  - import the moved helpers.
- `server/src/scheduler/merge.ts`: the `pushToDefault` steps above, and `finishMerged` also sets `follow_ups = NULL`.
- `server/src/http/connections.ts`: `PUT /repos/:id` accepts `reworkOn`, checks it before any write with `check(['severe','moderate','minor'].includes(reworkOn), 'Choose severe, moderate or minor for "Send back for rework on".')`, and writes `rework_on`.
- `client/src/repo-settings.ts`: add `reworkOn` to `RepoDraft` and to `repoChanges`.
- `client/src/pages/Connections.tsx`: add `reworkOn` to `saved()`. Put a select next to "Tickets to work on", with the same markup:
  ```tsx
  <label className="row small" title="The lowest code review severity that sends a ticket back to design or implementation. Workshop sends it back at most 3 times per review round.">
    <span className="muted" style={{ whiteSpace: 'nowrap' }}>Send back for rework on</span>
    <select …>
      <option value="severe">Severe findings only</option>
      <option value="moderate">Moderate and severe findings</option>
      <option value="minor">All findings</option>
    </select>
  </label>
  ```
- `docs/design/workflow.md`: update the Code reviewer rows of the transitions table, the severity rubric (lines ~82–87) and the push-to-default paragraph (~149) for the threshold, the downgrade and follow-ups. Also add `consequence` to the result shape (~208).

## Data and interfaces

- DB: `repos.rework_on` (text, default `'severe'`) and `tickets.follow_ups` (JSON `FollowUps`, null when none).
- `RepoView.reworkOn`. `PUT /api/repos/:id` (connections router, session only, so not in `openapi.ts`) takes `reworkOn`. Anything other than the three values gives a 400 with the readable message above.
- Code reviewer result: findings gain `consequence` (required by the JSON schema; optional when parsing stored results).
- `PlanContext.reworkOn?`, `PlanContext.raiseTickets?` and `Plan.followUps?: Finding[] | null`.

## Tests

`server/test/workflow.test.ts`:
- Give the `finding()` helper a default `consequence` (for example "Empty input crashes the page."). Otherwise every existing severe finding becomes minor.
- `stageForRework` with `moderate` and `minor`.
- Threshold `moderate`:
  - moderate-only findings go to implementation, with `rework.findings` holding them and a comment that says "problems", not "severe";
  - minor-only findings open the PR with `followUps: null`.
- Threshold `minor`: minor-only findings go back.
- Default (no `reworkOn`): the existing tests pass unchanged, apart from the helper.
- Threshold `moderate`, `rework.count = 1`, with a moderate finding marked `repeat`: opens the PR, flagged, with the exhausted text not saying "severe". At `MAX_REWORKS` with a new moderate finding: no send-back.
- A moderate finding with an empty `consequence` under `moderate`: no rework, shown as Minor, and no follow-up.
- Push-to-default with threshold `moderate`, `raiseTickets` on and a moderate finding at `MAX_REWORKS`: `merge: true` and `noPr: true`, no `needs-info`, and `followUps` holds that one finding.
- Push-to-default with a severe finding left after rework: `needs-info`, as today, with `followUps` holding the qualifying findings.
- Push-to-default with a minor finding below the threshold: listed in the comment, `followUps: null`.
- Push-to-default on a `workshop/raised` ticket: `followUps` is still stored, but the comment doesn't promise tickets (and `raiseFollowUps` raises none).
- `followUpBody` includes the ticket number, file:line, evidence, consequence, fix and the short sha.
- Prompts: the code-review `protocolText` routing line for each threshold, and the implement and code-review rework text for `severe` and `moderate`. The schema has `consequence` in `required`, and `parseResult` accepts a finding without it.

`server/test/pipeline.test.ts` (push-to-default tests already exist there; follow the fake GitHub setup):
- A push-to-default review with a qualifying moderate finding, then the merge: one ticket created with `workshop/raised`, a body naming `#n` and the pushed sha, and the pushed comment listing it.
- A follow-up whose title matches an open ticket is not raised. This belongs here rather than in `workflow.test.ts`, because the duplicate check reads the database.
- A merge whose ticket creation fails once after the push: the next `advanceMerge` doesn't push again, raises the rest, and finishes.

`server/test/api.test.ts`: `reworkOn` defaults to `severe` in the repo view, saves `moderate`, and rejects `'sometimes'` with a 400 and the message. A rejected `reworkOn` alongside another field leaves the other field unsaved.

`client/test/`: if `repoChanges` has tests, add `reworkOn`.

Run `npm run typecheck` and `npm test`. Check the form in the browser (`npm run dev:server` and `npm run dev:client`, Connections page) and save a screenshot to `/work/media/`.

## Risks and open questions

- **Customised prompts** may still contain the old "When in doubt, it isn't severe" and "Severe findings send…" lines. The fixed protocol bullet and the schema description come later and take precedence. Stored custom prompts are not rewritten.
- **The `raise_tickets` setting is off:** follow-ups aren't raised, so findings in push-to-default repos remain only in the comment, as today. This is how I read "reuse `raise_tickets`". The alternative is to raise follow-ups regardless, but then the owner would have no way to turn them off. The same applies to tickets that are themselves `workshop/raised`, by design.
- **Lower thresholds cost more runs**, up to `MAX_REWORKS` extra Implementation and Code review runs per round. The strict rubric and the consequence downgrade are what keep this in check.
- **Dropping the follow-up when it's similar to an existing ticket** (`bestMatch`) can hide a real, distinct finding. The thresholds are loose because only `workshop/raised` tickets are candidates. The pushed comment says which ticket covers it, so the owner can see it.
