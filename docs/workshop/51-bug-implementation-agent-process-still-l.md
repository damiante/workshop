# Reconcile rescued pushes with the Merge agent (#51)

## Context

Since #49, `publish` (`agent/entrypoint.sh`) merges in commits that appeared on the remote branch and retries the push. When that merge conflicts, it saves the agent's commits on `<branch>-unmerged-<sha>`, prints `{"rescued":"…"}` and exits 3. `publishRun` (`server/src/scheduler/runner.ts`) then comments and fails the run. The retry starts from the current remote branch and does the whole stage again. That costs a second full agent run, and because the remote changes are still there it often conflicts again. After two failures the ticket is stuck on `workshop/failed` and the owner has to merge by hand.

Outcome: a rescued push no longer fails the run. The ticket moves to a new stage, `workshop/stage:reconcile`. There the Merge agent merges the rescue branch into the ticket's branch and resolves the conflicts. Workshop pushes the result and then finishes the interrupted stage exactly as it would have (opens the PR, moves to `pr-review`, and so on). The owner doesn't have to step in.

## Approach

This follows the owner's suggestion: reuse the Merge agent, since resolving conflicts is already its job. It gets a second task: "merge `origin/<rescue branch>`" next to the existing "merge `origin/<base>`".

- **A new stage label, `workshop/stage:reconcile`.** Labels are the state, so the owner can see on GitHub that the ticket is waiting on a reconcile, and can move it by hand if needed. `nextStep` maps the stage to `{ kind: 'agent', agent: 'merge', mode: 'normal' }`.
- **What was interrupted lives on the ticket row.** A new JSON column `tickets.rescue` holds `{ branch, runId, agent, mode, result }`:
  - `branch` is the rescue branch;
  - `runId`, `agent`, `mode` and `result` come from the run whose push was rescued. `result` is that run's parsed `AgentResult`.

  It sits on the ticket and not in `runs`, because cleanup deletes run rows.
- **The rescued run succeeds.** It doesn't fail. Its work is safe and the handoff is the expected path, so it doesn't count toward `MAX_ATTEMPTS`. `failures` is left as it is, not reset, so a ticket can't loop forever.
- **The reconcile run finishes the interrupted plan.** When the Merge agent returns `done` in `reconcile`, `planTransition` builds the stored result's plan as if the ticket were still in the original stage. It then turns that into label edits against the real labels. On top of that plan, the reconcile run always publishes and deletes the rescue branch. So an Implementation rescue still opens the PR from the reconcile run's push, using the stored `WorkResult` summary.
- **A rescue during a reconcile run** keeps the original `runId`/`agent`/`mode`/`result`, sets `branch` to the new rescue branch (it contains the old one), and fails the run as today. Failures count, so a branch that keeps moving still ends at `workshop/failed` after two attempts.
- **The Merge agent's `needs_info`/`failed` outcomes** work as for any agent. The stage stays `reconcile` and `tickets.rescue` is kept.

Alternative considered: have the original agent's retry merge the rescue branch itself during `prepare`. That throws away less than today, but it reruns a whole Design or Implementation session just to resolve conflicts. It also puts conflict markers in front of an agent whose prompt isn't about merging. The Merge agent is cheaper and already built for this.

## Changes

### `server/src/api-types.ts`, `server/src/http/openapi.ts`, `client/src/format.ts`
- `Stage` gains `'reconcile'`, and the `Stage` enum in `openapi.ts` gains it too.
- `STAGE_TEXT` (client): `reconcile: 'Reconcile pushed work'`.

### `server/src/workflow/labels.ts`
- `STAGES` gains `'reconcile'` (append it). `STAGE_TEXT`: `'pushed work conflicts, Merge agent next'`.
- `nextStep`: `case 'reconcile': return { kind: 'agent', agent: 'merge', mode: 'normal' };`.
- Export `STAGE_OF_AGENT: Partial<Record<AgentName, Stage>>` = `{ design: 'design', 'design-review': 'design-review', implement: 'implement', merge: 'merge' }`. These are the agents whose runs publish.
- `AGENT_TEXT.merge` stays. `describeStep` returns `'Reconcile pushed work'` when the step's agent is `merge` and the stage is `reconcile`. Pass the stage in, or check the stage in `tickets.ts` where it's called, whichever is smaller.
- Add `labelDiff(from: string[], to: string[]): { add; remove }` and a helper `applyEdits(labels, { add, remove })` that returns the resulting set.

### `server/src/workflow/transitions.ts`
- `PlanContext` gains `rescue?: Rescue`, where `Rescue = { branch: string; runId: string; agent: AgentName; mode: 'normal' | 'delta'; result: AgentResult }` (exported from `transitions.ts`, or from `schemas.ts` next to `AgentResult`).
- `Plan` gains `deleteBranch?: string` and `clearRescue?: boolean`.
- In `planTransition`, for `agent === 'merge'`, `outcome === 'done'` and `ctx.state.stage === 'reconcile'` with `ctx.rescue`:
  ```ts
  const origin = STAGE_OF_AGENT[rescue.agent]!;
  const asBefore = applyEdits(ctx.labels, moveTo(ctx.labels, origin));
  const inner = planTransition({ ...ctx, agent: rescue.agent, mode: rescue.mode, labels: asBefore, state: parseLabels(asBefore), rescue: undefined }, rescue.result);
  return { ...inner, ...labelDiff(ctx.labels, applyEdits(asBefore, inner)), publish: true, deleteBranch: rescue.branch, clearRescue: true,
           comment: [reconciledComment(r.summary, rescue.branch), inner.comment].filter(Boolean).join('\n\n') };
  ```
  `reconciledComment`: ``The Merge agent merged the saved work from `<branch>` into this branch:\n\n<summary>``.
- If `stage === 'reconcile'` but `ctx.rescue` is missing (the owner set the label by hand), return `{ failure: 'Nothing to reconcile: Workshop has no saved work for this ticket. Move it to another stage.' }`.

### `server/src/workflow/prompts.ts`
- `TaskContext` gains `rescue?: { branch: string; agent: AgentName; summary: string }`.
- `taskLine('merge')` with `rescue`: ``Workshop couldn't push the <Agent label> agent's work because `<branch>` changed on GitHub meanwhile. That work is saved on `origin/<rescue>`; its summary: "<summary>". Run `git merge origin/<rescue>`, resolve the conflicts keeping both sides' intent, run the tests and commit the merge.``
- Generalise `DEFAULT_PROMPTS.merge` so it no longer assumes an approved PR against the base branch. For example: "Something conflicts with this ticket's branch: either the base branch after approval, or work Workshop saved when the branch changed under an agent. Merge the branch the task names into the current branch…". Keep the existing rule about keeping both sides' intent. Customised prompts in the database are left alone. Uncustomised ones pick up the new default automatically (`promptFor`).

### `server/src/db.ts`, `server/src/tickets.ts`
- New migration at the end: `ALTER TABLE tickets ADD COLUMN rescue TEXT;` (JSON, nullable).
- `TicketRow.rescue: string | null`, and a small `rescueOf(t): Rescue | null` helper.

### `server/src/scheduler/runner.ts`
- `publishRun`, when `state.exitCode !== 0 && pushed.rescued`:
  - If the ticket isn't in `reconcile` (a first rescue): write `tickets.rescue = { branch: pushed.rescued, runId: r.id, agent: r.agent, mode: r.mode, result }`. Then `editLabels(t, moveTo(labels, 'reconcile').add, [...moveTo(...).remove, label.running])`. Post a comment: ``…saved the agent's work on `<rescue>`. The Merge agent will merge it into `<branch>` next.`` Mark the run `succeeded` with `error` left null and `summary` set to ``Work saved on <rescue>; the Merge agent reconciles it next.``. Remove the volume, and return **without** resetting `failures`.
  - If the ticket is already in `reconcile`: update only `rescue.branch`, comment as today and throw. The run fails and the failure counts.
- Pass `rescue: rescueOf(t) ?? undefined` into `planTransition`.
- After a successful plan: if `plan.deleteBranch`, call `vcs.deleteBranch` (best effort: warn and carry on). If `plan.clearRescue`, `UPDATE tickets SET rescue = NULL`.
- `openOrUpdatePr`: build the screenshots line from `rescue.runId` when reconciling, so media from the original run still reaches the PR body. Add a `mediaRunId` parameter that defaults to `ctx.run.id`.
- `runSpec`: for `r.agent === 'merge'` with a stored rescue and the ticket in `reconcile`, pass `rescue: { branch, agent, summary }` to `taskPrompt`. `prepare` already fetches every head, so `origin/<rescue>` exists.

### `server/src/scheduler/sync.ts`, `merge.ts`, `loop.ts`
- `cleanUpClosedIssue` also deletes `rescue.branch` when set, and clears the column.
- When a stage label change moves the ticket out of `reconcile`, clear `tickets.rescue` but keep the branch on GitHub. Do this where `api.ts` applies `stateEdits` (Change status). Sync only needs to clear it when it sees the ticket without `stage:reconcile` while `rescue` is set and no run is active.
- `gates.stepPriority`: no change. `agent === 'merge'` already gets priority 0.

### Docs
- `docs/design/workflow.md`:
  - add the label row to the table: `workshop/stage:reconcile` | Pushed work conflicted with new commits on the branch: Merge agent next;
  - add a `stage:reconcile` row to "What happens next";
  - add a Transitions row: Merge (reconcile) | done | the interrupted stage's labels | push, delete the rescue branch, then finish the interrupted stage;
  - add a sentence under "Failures": a conflicting push isn't a failed attempt; it goes to reconcile.
- `server/AGENTS.md`, "Run lifecycle": update the `publish` bullet. On a conflict, the run succeeds and the ticket moves to `stage:reconcile`, with what was interrupted kept in `tickets.rescue`.

## Data and interfaces

- New label `workshop/stage:reconcile`. GitHub creates labels that don't exist yet when they're added to an issue, and `LABEL_DEFS` gives them the proper colour on the next enable.
- New column `tickets.rescue TEXT` (JSON `{ branch, runId, agent, mode, result }`).
- `Stage` (API types, OpenAPI) gains `reconcile`. The Change status dropdown offers it automatically from `STAGE_TEXT`. Its validation (`STAGES.includes`) accepts it, and the plan's missing-rescue guard covers a hand-set stage.
- No change to the `publish` stdout contract.

## Tests

- `server/test/workflow.test.ts`:
  - `nextStep` for `reconcile`;
  - `labelDiff`/`applyEdits`;
  - `planTransition` for merge in `reconcile` with a stored implement `done` result: labels end on `stage:pr-review` without `reconcile`, `openPr`, `publish`, `deleteBranch`, `clearRescue`;
  - the same with a stored design result on an M ticket, which ends on `stage:implement` with both comments;
  - a stored `needs_info` result, which restores the origin stage and adds `needs-info`;
  - a missing rescue, which gives `failure`;
  - `taskPrompt` for merge with `rescue`, which names `origin/<rescue>`.
- `server/test/pipeline.test.ts`: change the existing rescue test (around line 328).
  - An Implementation run whose publish prints `rescued` and exits 3 ends `succeeded`. `failures` is unchanged, the labels have `stage:reconcile`, one comment names the rescue branch, and `tickets.rescue` is stored.
  - Then a Merge run for that ticket that returns `done`. It publishes, opens the PR with the stored summary, moves to `pr-review`, deletes the rescue branch (fake GitHub records `deleteBranch`) and clears `tickets.rescue`.
  - A rescue during the reconcile run fails it, counts a failure and updates `rescue.branch`.
  - A non-zero exit without `rescued` keeps the "Pushing … failed" message.
- `server/test/api.test.ts`: moving a ticket out of `reconcile` through Change status clears `rescue`.
- `server/test/publish.test.ts`: no change (the script is untouched).
- Run `npm run typecheck` and `npm test`.

## Risks and open questions

- **The Merge agent sees the rescue as "theirs"** and the branch as "ours". A conflict where the owner's commits and the agent's work truly contradict is resolved by the Merge agent's judgement. The prompt tells it to keep both intents. The owner still reviews the PR (Implementation), or the design gets reviewed downstream.
- **Stored result goes stale.** If the owner edits the ticket between the rescue and the reconcile, Workshop still finishes the old stage with the old result. That's acceptable: the ticket would have moved on in any case.
- **A reconciled Design result** comments "Design written" only after the Merge agent has merged it. The design doc path is the same, so the link is right.
- **The image is unchanged**, so a Workshop server running an older agent image behaves the same. Only server code changes.
