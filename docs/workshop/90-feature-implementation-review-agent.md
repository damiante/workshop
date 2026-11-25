# Implementation review agent (#90)

## Context

Today the Implementation agent finishes and Workshop opens the pull request straight away. Nothing independent checks the code first. On L and XL tickets the Implementation prompt asks the agent to run an adversarial review "using a subagent" before finishing. That's the self-review the owner has seen in PR bodies. It shares the implementer's context and blind spots, and it can't send the ticket back to design.

Outcome:

- A new **Code review** stage runs after Implementation on every ticket, using a new **Code reviewer** agent. The agent is read-only: it reports findings and changes nothing.
- Every finding has a severity. A **severe** finding (glaring: the change doesn't do what the ticket asks, breaks something, loses data, opens a hole, fails its own checks) sends the ticket back automatically:
  - to **design** when the cause is the design and the ticket has one (M, L, XL);
  - to **implementation** otherwise.
- Everything else (moderate, minor) goes into the pull request for the owner to decide on.
- Implementation no longer opens the pull request. The pull request opens when the code review passes, so the owner is only asked to review work that has been checked.
- The automatic loop is bounded. After one rework, severe findings that remain go into the pull request, prominently flagged, instead of looping again.

## Approach

**A stage of its own, not a step inside Implementation.** The Implementation agent already pushes before the PR opens, so the review can be a separate run on the pushed branch. A separate run has these advantages:

- a fresh context and its own model (Opus by default, like the Design adversary);
- its own turn and time limits, and its own spend shown on the Agents page;
- its result passes through `planTransition`, so routing is pure and unit-tested.

The alternative, a Workshop-orchestrated subagent inside the Implementation run, can't route the ticket back to design and hides its cost.

**Workshop decides the route, not the agent.** The reviewer returns a list of findings, each with `severity` and `cause`. A pure function picks the next stage from those fields and the ticket size. The threshold lives in the reviewer's prompt as a rubric (see below), with "when in doubt it isn't severe" as the bias. The owner asked that only glaring problems loop automatically.

**Read-only reviewer.** The reviewer's plan never publishes, so anything it edits or commits is discarded with the volume. The reviewer may run the tests and the type-checker to verify claims. The prompt says not to edit files.

**The Implementation summary is kept for the PR.** The PR body is still the Implementation agent's summary. It's now written one run later, so `publishRun` stores what `openOrUpdatePr` needs on the ticket (`tickets.handoff`) when Implementation finishes. Run rows aren't used for this: retention deletes them. The "finished without committing any changes" check moves from PR opening to the Implementation publish, where `pushed.ahead` is known.

**The loop counter and the findings to fix** live in `tickets.rework`. Design, Design adversary, Implementation and the second Code review get the findings as a prompt section while a rework is under way (the reviewer so it checks they were fixed rather than starting blind). Both columns are cleared when the PR is opened or updated, and `rework` is also cleared by every accepted classification, so each review round (first PR, or after changes are requested) gets one automatic rework even if a ticket was moved by hand mid-rework.

**Remove the L/XL self-review bullet** from the Implementation prompt. The new stage replaces it. Running both doubles the cost.

**Merge without review.** If severe findings remain after the rework, merging unattended is the worst outcome. In a repository with Merge without review on, that case also adds `workshop/needs-info` with a comment. `syncReviews` already skips `pr-review` tickets with `needs-info`, so nothing merges until the owner removes the label (or requests changes). Other repositories need no hold, because the owner reviews anyway.

### Severity rubric (in the reviewer's default prompt)

- **severe**: any of these:
  - the change doesn't do what the ticket (or the owner's review) asks, or leaves out a core part;
  - it breaks existing behaviour;
  - it loses or corrupts data;
  - it introduces a security hole or a leak of secrets;
  - it crashes on an ordinary path;
  - the repository's tests or type-check fail because of the change;
  - it follows a design that can't work.

  Only findings the reviewer has verified (by reading the code, or by running something) qualify, and each finding says how in `evidence`.
- **moderate**: a real bug on an edge path, a missing test for changed behaviour, or a clear deviation from the repository's conventions or the design that works but should be fixed.
- **minor**: style, naming, small simplifications, comments and docs.
- **cause**: `design` when fixing it means changing the design document's approach; `implementation` when the code doesn't do what the design (or ticket) says.

## Changes

### `server/src/api-types.ts`
- `AgentName` gains `'code-review'`; `Stage` gains `'code-review'`.

### `server/src/workflow/labels.ts`
- `STAGES`: insert `'code-review'` after `'implement'`. `STAGE_TEXT['code-review'] = 'code review next'`. `LABEL_DEFS` picks it up.
- `nextStep`: `'code-review'` joins the `design | design-review | implement` case (agent = stage).
- `AGENT_TEXT['code-review'] = 'Code review'`. Don't add it to `STAGE_OF_AGENT`: that map lists the agents whose runs publish (it's only used to replay a rescued push), and the reviewer never publishes.
- `imageFor`: `code-review` gets the browser image under the same condition as `implement` (`needs:browser`).

### `server/src/workflow/schemas.ts`
- Types:
  ```ts
  export interface Finding { severity: 'severe' | 'moderate' | 'minor'; cause: 'design' | 'implementation'; title: string; detail: string; evidence: string; fix: string; file?: string; line?: number }
  export interface ReviewResult extends WorkResult { findings?: Finding[] }
  export interface Rework { count: number; findings: Finding[] }   // tickets.rework
  export interface Handoff { runId: string; result: WorkResult; before?: string; after?: string }   // tickets.handoff
  ```
- `REVIEW_SCHEMA` = `WORK_SCHEMA` plus a `findings` array property. Each item has the fields above (all required except `file` and `line`), with `additionalProperties: false`, and a `description` that restates the severity rubric in one line each. `evidence`'s description: "How you checked it: the command you ran and what it printed, or the code you read. A few words are enough for minor findings."
- `schemaFor('code-review')` returns `REVIEW_SCHEMA` (today `schemaFor` is a classifier/else ternary; make it a lookup).
- `parseResult('code-review', …)`: when the outcome is `done`, `findings` is required (it may be empty). Each item needs a known severity and cause, non-empty `title`, `detail`, `evidence` and `fix`, an optional string `file` and an optional positive integer `line`. The error messages follow the existing style, for example `findings must be a list of { severity, cause, title, detail, evidence, fix }.`

### `server/src/workflow/transitions.ts`
- New pure helper and constant, here rather than in `labels.ts` (routing belongs with the plans, and `labels.ts` importing `Finding` from `schemas.ts` would make the two modules import each other):
  ```ts
  export const MAX_REWORKS = 1;
  /** Where severe findings send a ticket: design when the design is at fault and the ticket has one. */
  export function stageForRework(size: Size | null, findings: Finding[]): 'design' | 'implement' | null
  ```
  It returns `null` when no finding is severe. It returns `'design'` when the size is m, l or xl and a severe finding has `cause: 'design'`, and `'implement'` otherwise.
- `PlanContext` gains:
  - `rework: Rework | null`;
  - `mergeWithoutReview: boolean`.
- `Plan` gains:
  - `handOff?: boolean`: store the Implementation result in `tickets.handoff`;
  - `rework?: Rework | null`: write `tickets.rework`, with `null` clearing it;
  - `reviewNotes?: string`: Markdown added to the PR body or PR comment.
- `needs_info`: `publish` is `false` when `ctx.agent === 'code-review'`.
- `implement` done becomes:
  - `moveTo(…, 'code-review')`, with `publish: true` and `handOff: true`;
  - comment: `Implementation finished and pushed. Next: code review.` (no branch name, so `PlanContext` needs no new field).
- Classifier `accept` (normal and delta) also returns `rework: null`: a new classification starts a new review round.
- New `code-review` case, from `findings = r.findings ?? []` and `target = stageForRework(size, findings)`:
  - **`target` set and `(ctx.rework?.count ?? 0) < MAX_REWORKS`:**
    - `moveTo(target)`, with no `publish` and no `openPr`;
    - `rework: { count: n + 1, findings: severe ones }`;
    - issue comment: `Code review found N severe problem(s), so Workshop sends this ticket back to <design|implementation> (rework n+1 of MAX_REWORKS):`, then the severe findings as a list (`formatFindings`), then `r.summary`, then `Next: <design|implementation>.`
  - **otherwise:**
    - `moveTo('pr-review')`, with `openPr: true` and `rework: null`;
    - `reviewNotes: reviewSection(findings, exhausted)`, where `exhausted` means `target !== null`;
    - if `exhausted && ctx.mergeWithoutReview`: also add `label.needsInfo`, plus a comment @mentioning the author: "The code review still found severe problems after Workshop's rework, so it won't merge this pull request without you. Read the Code review section on the pull request, then request changes, or remove `workshop/needs-info` to let it merge."
- `planReconcile` needs no change. A rescued Implementation push now finishes with the `implement` plan (move to code-review, `handOff`). The reviewer never publishes, so it is never rescued.
- Exported pure formatters, used by the comment and by `reviewSection`. Each finding renders as:
  ```
  - **Severe** (`path:line`) Title: detail. Fix: fix
  ```
  `reviewSection` returns:
  - `### Code review` plus "No problems found." when there are no findings;
  - otherwise the findings, severe first, then moderate, then minor;
  - when exhausted, a leading line: **"The code review still found severe problems after one rework. Read them before approving."**
  - the reviewer's `tests` line, when it gave one (`**Reviewer ran:** …`);
  - at most `MAX_FINDINGS_SHOWN = 30` findings (severe first), then "N more findings left out; see the Code reviewer's run." GitHub rejects PR bodies and comments over 65,536 characters, and the findings come straight from an agent. Also cut each `detail` and `evidence` to 1,000 characters. The issue comment for a rework uses the same formatter, so the same caps apply.

### `server/src/workflow/prompts.ts`
- `AGENT_INFO['code-review']`:
  - label `Code reviewer`;
  - description "Reviews the implementation before the pull request opens; sends severe problems back to design or implementation.";
  - `maxTurns: 150`, `timeoutMin: 60`.
- `AGENT_INFO.implement.description`: "Implements the ticket with tests; the Code reviewer checks it before Workshop opens the PR."
- `DEFAULT_PROMPTS['code-review']` (new). It says:
  - you are the Code reviewer;
  - read the ticket, any owner review feedback, the design file if there is one, and the full diff `git diff origin/<base>...HEAD`;
  - run the repository's tests and type-check;
  - look for correctness, gaps against the ticket and design, security and data-loss risks, and missing tests;
  - report each problem once, with the severity rubric above (verbatim), `cause`, `evidence`, a concrete `fix`, and `file`/`line` where it applies;
  - don't report something you haven't verified as severe; when in doubt it's moderate;
  - don't edit or commit anything: Workshop discards changes from this stage;
  - the summary is one or two sentences on the overall state.
- `DEFAULT_PROMPTS.implement`:
  - remove the "For tickets sized l or xl: … subagent … adversarially review" bullet;
  - change the last bullet to say the summary becomes the pull request description after a Code reviewer has checked the work.
- `protocolText` gains an optional `publishes = true`. For `code-review` (and in `agentViews`' preview of it) the "Commit your work locally; Workshop pushes it…" sentence becomes "Nothing you change or commit here is pushed: Workshop discards this container when you finish." Otherwise the fixed protocol contradicts the reviewer's prompt.
- `TaskContext` gains `rework?: Rework`. `taskPrompt` renders `## Code review findings to fix` (the formatted findings) after the review feedback, for `design`, `design-review`, `implement` and `code-review` when it is set. For `code-review` the heading is `## Severe findings from the previous code review`.
- `taskLine`:
  - `code-review`: ``Review the work on branch `<branch>` against the ticket and the design at `<docPath>` if that file exists, and return your findings.`` Add "Check that the review feedback above was addressed." when `review` is non-empty. With `rework`: add "Workshop sent the ticket back once to fix the findings above. Check each one again and report it only if it still holds."
  - `design` with `rework`: ``The code review found that the design at `<docPath>` doesn't work (see the findings above). Revise it to fix them, and commit it.`` This replaces the "Revise the design to cover the review feedback" sentence only when there's no review feedback; with both, keep both sentences.
  - `design-review` with `rework`: add "Check that the revision fixes the code review findings above."
  - `implement` with `rework`: add "Fix the severe code review findings above; the existing commits on the branch are your starting point. Your summary replaces the earlier one as the pull request description, so describe the whole change, not only the fixes." (Without that sentence the PR body after a rework would describe only the fixes.)

### `server/src/scheduler/gates.ts`
- `stepPriority`: `code-review` returns 1, like `implement`, because the work is already in flight.

### `server/src/scheduler/runner.ts`
- `runSpec`: pass `rework: reworkOf(t) ?? undefined` to `taskPrompt`. Review feedback is already fetched for every agent except merge, so the reviewer gets it.
- `publishRun`:
  - build `PlanContext` with `rework: reworkOf(t)` and `mergeWithoutReview: Boolean(ctx.repo.merge_without_review)`;
  - after a successful push, if `plan.handOff`:
    - `if (!t.pr_number && !pushed.ahead) throw new Error('The implementation agent finished without committing any changes.')`, which moves here from `openOrUpdatePr`;
    - store `tickets.handoff = { runId, result, before, after }`. When reconciling, `runId` and `result` come from `rescueOf(t)`, so write the handoff before `clearRescue` runs. Keep `before` from an existing handoff only while a rework is under way (`reworkOf(t)` is set), so that a rework with no new commits still says "Updated after review", but a later review round compares against its own starting point.
  - `if ('rework' in plan)`: write `tickets.rework` (JSON or NULL) before the label edit, like the other ticket columns. If the label edit then fails, the retried review sees `count = 1` and opens the PR with the findings flagged instead of looping: the safe direction.
  - `plan.openPr`: call `openOrUpdatePr(ctx, t, handoffOf(t), plan.reviewNotes)`. Without a stored handoff (for example, the owner moved the ticket to code review by hand), fall back to `{ runId: r.id, result: <the reviewer's result> }`. Remove today's `rescued` branch here: only the Code reviewer opens PRs now, and it is never rescued.
  - Clear `tickets.handoff` at the end, in the same `UPDATE` that resets `failures`, after the labels and comment have been written. If anything after `openOrUpdatePr` fails, the retried review still has the Implementation summary (the PR is recorded by then, so the retry posts an update comment rather than a second PR).
- `openOrUpdatePr(ctx, t, handoff, reviewNotes)`:
  - take `result` and the media run id from `handoff`, and decide "Reviewed again with no code changes" from `handoff.before === handoff.after`;
  - drop the `ahead` check;
  - append `reviewNotes` after the design link in a new PR, and after the screenshots in an update comment;
  - when the notes are flagged as exhausted, put them first instead (pass a flag, or check the first line).

### `server/src/tickets.ts`
- `TicketRow` gains `handoff: string | null` and `rework: string | null`.
- New helpers `handoffOf` and `reworkOf`, like `rescueOf`.

### `server/src/db.ts` (new entries at the end of `MIGRATIONS`)
```sql
ALTER TABLE tickets ADD COLUMN handoff TEXT; -- the Implementation result the pull request describes, until it opens (JSON)
ALTER TABLE tickets ADD COLUMN rework TEXT;  -- automatic reworks this review round and the severe findings to fix (JSON)
-- Existing installs: the Code reviewer starts with the Design adversary's model and billing.
INSERT OR IGNORE INTO agent_classes (name, model, model_connection_id, effort, billing, max_turns, timeout_min)
  SELECT 'code-review', model, model_connection_id, effort, billing, 150, 60 FROM agent_classes WHERE name = 'design-review';
```
On a fresh database the `INSERT` copies nothing. `seedAgents` then inserts the row, and `suggestModels` fills it in.

### `server/src/agents.ts`
- `SUGGESTED_MODELS['code-review'] = 'claude-opus-5-5'`.

### `server/src/http/openapi.ts`
- Add `'code-review'` to the `Stage` and `AgentName` enums.

### Client
- `client/src/format.ts`: `AGENT_LABEL['code-review'] = 'Code reviewer'` and `STAGE_TEXT['code-review'] = 'Code review'`. This also adds it to the "Change status" stage list.
- `client/src/pages/Tickets.tsx`: add a `{ title: 'Code review', match: (t) => t.stage === 'code-review' }` column between Implementation and Your review.

### Docs
- `README.md`, How it works:
  - step 4 becomes "Implement. The Implementation agent writes the change and tests and pushes them";
  - a new step 5, "Code review", describes severe findings going back to design or implementation once, and the rest going into the PR;
  - Your review becomes step 6;
  - remove the "On L and XL tickets the agent also runs an adversarial self-review" sentence;
  - the pre-assigned models sentence gains "Opus for … the Code reviewer".
- `docs/design/workflow.md`:
  - label table: add `stage:code-review`;
  - `nextStep` table: add `stage:code-review`;
  - transitions table: Implementation goes to `stage:code-review` with "Push; store the summary". Add Code reviewer rows for no severe findings, severe within the limit, and severe after the limit;
  - add a short "Code review" section with the rubric summary, `MAX_REWORKS`, and the Merge without review hold;
  - "What an agent receives": the Code reviewer's result has `findings`.
- `server/AGENTS.md`: in the Map row for `src/workflow/`, mention the review routing (`stageForRework`). In Run lifecycle, note that the Code reviewer never publishes.
- The `ticket-state-transition.drawio(.svg)` diagram: add the stage if the implementer can edit the drawio XML cleanly. Otherwise leave it, and say so in the PR summary.

## Data and interfaces

- New label `workshop/stage:code-review`. New stage and agent name `code-review`, exposed through `TicketView.stage`, `RunView.agent`, the Agents page and the OpenAPI enums. Existing enabled repositories don't get the label from `ensureLabels` until they're re-enabled. GitHub's add-labels endpoint creates a missing label on first use (grey, no description), which is acceptable.
- New ticket columns `handoff` and `rework` (JSON text, nullable). They aren't exposed in views.
- Code reviewer result: `WorkResult` plus `findings: Finding[]`.
- No settings change. `MAX_REWORKS` is a constant.

## Tests

`npm run typecheck && npm test`.

`server/test/workflow.test.ts`:
- `nextStep` for `stage:code-review`, and `describeStep` returns "Code review".
- `stepPriority('code-review')` is 1. `imageFor('code-review', …)` follows `needs:browser`.
- `stageForRework`:
  - no severe finding returns null;
  - a severe implementation cause returns implement;
  - a severe design cause on M/L/XL returns design;
  - a severe design cause on XS/S returns implement;
  - moderate design findings alone return null.
- `planTransition`:
  - implement done moves to `code-review` with `publish` and `handOff`, and no `openPr`;
  - code-review with no findings, or only moderate and minor ones: `pr-review`, `openPr`, `rework: null`, and `reviewNotes` lists them;
  - code-review severe with `rework` null: back to `implement` or `design` per `stageForRework`, `rework.count === 1`, no publish, and the comment lists the severe findings;
  - code-review severe with `rework.count === 1`: `pr-review`, `openPr`, and the notes start with the "still found severe problems" line. With `mergeWithoutReview`, `needs-info` is also added and the comment @mentions the author;
  - code-review `needs_info`: `needs-info` added, `publish` false;
  - reconcile of a rescued implement run: goes to `code-review` with `handOff`. Update the existing rescue test that expects `pr-review`.
- `parseResult('code-review', …)`:
  - findings are required when done;
  - a bad severity or cause, or a missing fix, gives the error message;
  - an empty list is accepted.
- `taskPrompt`:
  - the reviewer's task line;
  - `## Code review findings to fix` appears for design, design-review and implement with `rework`, and is absent without it;
  - the default Implementation prompt no longer mentions an adversarial subagent review.

`server/test/pipeline.test.ts`. Adapt the existing Implementation tests (lines ~194, 381, 414, 463, 473, 485, 498): an implement run now ends at `code-review` with no PR, and a following code-review run opens or updates it. Add:
- An implement run pushes, stores `handoff`, and moves to `code-review` without opening a PR. A code-review run with a moderate finding then:
  - runs no publish container;
  - opens the PR with the Implementation summary, tests and a Code review section;
  - requests review;
  - clears `handoff`.
- A code-review run with a severe implementation finding:
  - pushes nothing;
  - moves the ticket to `stage:implement` and stores `rework`;
  - the next implement run's `prompt.md` contains the findings section.

  A second severe review then opens the PR flagged, and `rework` is cleared.
- In a repository with Merge without review, an exhausted severe review opens the PR and adds `needs-info`. The next sync doesn't move it to `merge`.
- Implementation that commits nothing still fails at the implement stage.
- After changes are requested (existing PR), implement then code-review comments on the existing PR, including the review notes. "Reviewed again with no code changes" still works.

Also in `pipeline.test.ts`:
- A review whose label edit fails after storing `rework` is retried and opens the PR flagged, rather than sending the ticket back twice.
- After a rework, the second code-review run's `prompt.md` contains the previous severe findings.
- A rework implement run whose summary differs replaces the PR body's summary; a rework with no new commits still opens the PR (the branch is ahead of base from the first push).
- A delta classification clears a stale `rework`.

`workflow.test.ts` also: `reviewSection` caps the list at `MAX_FINDINGS_SHOWN` and says how many were left out; `protocolText({ …, publishes: false })` doesn't say Workshop pushes.

The migration: `MIGRATIONS` is exported, so the test opens an empty `DatabaseSync`, runs every migration but the new ones, inserts a `design-review` row with a model, connection and billing, runs the rest and checks the `code-review` row. Do it the way `spend.test.ts` builds an older database (`MIGRATIONS.slice(0, -n)`), in `api.test.ts`. The existing OpenAPI route test still passes.

## Risks and open questions

- **Cost.** Every ticket gets one more Opus run, and a rework on an XL ticket repeats design, design review and implementation. `MAX_REWORKS = 1` and the "when in doubt, not severe" bias limit this. If the owner wants XS tickets exempt, make `stageAfterImplement(size)` return `pr-review` for XS. That's a one-line change, but I recommend reviewing every size for now.
- **Threshold calibration** depends on the prompt. Agents tend to over-report severity. Workshop doesn't trust the agent's verdict, only its labelled findings, so the rubric is the lever. The owner can tune it on the Agents page.
- **Customised Implementation prompts** keep their self-review bullet (the default only applies when `customised` is false). Mention this in the PR summary so the owner can remove it.
- **Tickets in flight at upgrade.** One already at `pr-review` is unaffected. One at `implement` goes through code review. A ticket moved to `code-review` by hand with no `handoff` uses the reviewer's summary as the PR body.
- **The reviewer can't be stopped from editing files**, only prevented from publishing. Anything it changes is discarded, which is the intent.
- **A reviewer that keeps failing** leaves the ticket at `stage:code-review` with `workshop/failed` and no pull request. Removing `failed` retries it. Moving the ticket to `stage:pr-review` by hand doesn't open a PR (only a Code reviewer run does), so the ticket would sit there with nothing to review: document in `workflow.md` that the way past a broken reviewer is to fix its settings and retry. A "skip the review" control is a possible follow-up, not part of this ticket.
- **"Run next stage" on an Implementation ticket** now stops at `stage:code-review`, before the PR exists. That follows from the push rule (a stage push ends when the stage changes) and needs only the README/workflow wording.
- **Priority of a design rework.** A ticket sent back to design waits at design priority (3), behind design reviews and implementations. It's work in flight, but bumping it needs `stepPriority` to see ticket state, which it doesn't today. Left as is.

## Review

Design adversary's criticisms, checked against the code on `main` (`runner.ts`, `transitions.ts`, `labels.ts`, `prompts.ts`, `schemas.ts`, `sync.ts`, `merge.ts`, `agents.ts`, `db.ts`). The overall shape holds up: the reviewer can't push (`prepareSpec` uses read-only git access and `publish` never runs), `syncReviews` does skip `pr-review` tickets with `needs-info` (`sync.ts:102`), the migration's `INSERT … SELECT` works because `initDb` runs migrations before `seedAgents`, and routing from labelled findings keeps the decision pure and testable.

1. **The second review starts blind.** After a rework, the reviewer didn't get the earlier severe findings, so it couldn't check they were fixed and might report something unrelated, or miss that a "fix" didn't fix anything. *Fix:* pass `rework` to `code-review` too, with its own heading and task sentence. **Adopted.**
2. **After a rework, the PR body describes only the fixes.** The handoff is overwritten by the rework run's summary, and an agent asked to "fix these findings" summarises the fixes. *Fix:* the rework task line tells Implementation its summary replaces the earlier one and must describe the whole change. **Adopted.** (Concatenating both summaries was the alternative. It would repeat itself and read badly in the PR.)
3. **Clearing `handoff` straight after `openOrUpdatePr` loses it on a partial failure.** If the label edit or comment fails after the PR opens, the retried review falls back to the reviewer's summary as the PR text. *Fix:* clear `handoff` last, with `failures = 0`. **Adopted.** The same question for `rework`: writing it before the label edit means a failed edit plus retry opens the PR flagged instead of looping. That's the safe direction, so the order stays and a test pins it.
4. **"Keep `before` from an existing handoff" leaks across review rounds.** A handoff that was never cleared (a ticket moved by hand) would make a later round compare against an old commit. *Fix:* keep `before` only while `rework` is set. **Adopted.**
5. **A stale `rework` survives manual moves.** If the owner moves a ticket mid-rework (on GitHub or with Change status), `rework` stays, so the next round's Implementation gets old findings and no automatic rework. *Fix:* every accepted classification returns `rework: null`. A ticket enters a new round only through the Classifier (`reclassify`), so this is pure and covers both kinds of manual move. **Adopted.**
6. **The fixed protocol contradicts the reviewer.** `protocolText` tells every agent "Commit your work locally; Workshop pushes it". *Fix:* a `publishes` flag that swaps the sentence for the reviewer. **Adopted.**
7. **"Verified" can't be checked.** The rubric says only verified findings are severe, but nothing in the result shows the reviewer verified anything, and over-reporting severity is the main calibration risk. *Fix:* a required `evidence` field on each finding, shown in the PR and in the rework comment, so the owner (and the next agent) can see what backs each claim. **Adopted.** Rejecting severe findings without evidence in `parseResult` was rejected: an invalid result fails the run and repeats an Opus review.
8. **Unbounded findings can exceed GitHub's 65,536-character body limit,** which would fail the PR opening and the run with it. *Fix:* show at most 30 findings and cut long `detail`/`evidence`. **Adopted.**
9. **`stageForRework` in `labels.ts` creates an import cycle** (`schemas.ts` already imports `CAPABILITIES` from `labels.ts`). A type-only import would survive type stripping, but routing belongs with the plans anyway. *Fix:* put it and `MAX_REWORKS` in `transitions.ts`. **Adopted.**
10. **`STAGE_OF_AGENT['code-review']` is wrong.** The map's documented meaning is "agents whose runs publish", and its only use is replaying a rescued push, which the reviewer never has. *Fix:* leave it out. **Adopted.**
11. **The body left a choice to the implementer** (whether to put the branch in the Implementation comment). *Fix:* decide: no branch name, so `PlanContext` doesn't grow. **Adopted.**
12. **The migration test was vague** ("if the harness supports it"). `spend.test.ts` already builds an older database from `MIGRATIONS.slice(…)`. *Fix:* use that pattern. **Adopted.**
13. **No way past a broken reviewer.** If the Code reviewer keeps failing, the ticket is stuck without a PR, and moving it to `pr-review` by hand doesn't open one. *Fix considered:* a "skip code review" control, or having a manual move to `pr-review` open the PR from the handoff. **Not adopted:** both add UI or sync behaviour beyond the ticket, and retrying after fixing the agent's settings works. It's documented as a risk and in `workflow.md`.
14. **Simpler alternative: open the PR as a draft at Implementation, mark it ready after review.** A draft can't merge, so Merge without review would need no `needs-info` hold, and no `handoff` column would be needed. **Not adopted:** it needs new provider calls (creating drafts, and GitHub's GraphQL-only "ready for review"). The owner would also be notified about, and could review, work that might go back to design. And the after-review round (an existing, non-draft PR) would still need the handoff logic for its update comment.
15. **New label on existing repos.** The design relies on GitHub creating `workshop/stage:code-review` on first use. That's GitHub's documented behaviour for adding labels to an issue, so it's acceptable. *Fix considered:* run `ensureLabels` for enabled repos at startup. **Not adopted:** it's an API call per repo on every restart for a one-off cosmetic gain (colour and description).
16. **Design rework priority.** A ticket sent back to design waits behind design reviews and implementations (`stepPriority` 3). **Not adopted:** `stepPriority` only sees the step, and the delay is bounded by the queue. Noted in the risks.

Owner decisions carried over from the Design comment (review every size, `MAX_REWORKS = 1`, customised prompts keep their self-review bullet) still have defaults that work. None of them blocks implementation.
