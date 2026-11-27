# Let agents raise new blocking tickets (#123)

## Context

An agent can make its ticket wait on tickets that already exist (Classifier `decision: "blocked"`, `blocked_by`), but not on prerequisite work that has no ticket yet. Right now its only choices are `needs_info`, which means waiting for the owner to open and link a ticket by hand, or `noticed`, which opens a ticket but lets the current ticket carry on without the prerequisite. We want a third option. The agent returns the missing work as new blocking tickets, and Workshop opens them (or reuses an open ticket with the same title), links them as **blocked by**, and parks the current ticket. The ticket resumes when the new tickets close.

## Approach

Extend the existing "blocked" outcome rather than add a new mechanism:

- **Classifier:** `decision: "blocked"` takes `blocked_by` (existing numbers), `raise_blockers: [{ title, body }]` (new prerequisites), or both.
- **Design and Implementation:** a new `outcome: "blocked"` with `raise_blockers`. These two agents are where the gap shows up once the code has been read. Design adversary, Code reviewer and Merge don't get it. The work agents don't see the open-ticket list, so they get no `blocked_by`, and duplicates are caught by title (see Risks).
- `planTransition` stays pure. It returns `raiseBlockers` (the requested tickets) beside `addBlockers`, with no label change and no failure, exactly like today's classifier `blocked` path. `publishRun` opens or finds each ticket, then links everything in the existing `blockers` step.
- **Gating:** this reuses the repository's **raise tickets** setting (`repos.raise_tickets`), with no new toggle. Like `mayRaise`, it's off on tickets labelled `workshop/raised`, so a raised prerequisite can't raise more. That prerequisite can still return `needs_info`, and its Classifier can still block on existing numbers. Each run raises at most `MAX_NOTICED` (3) blockers.
- **Re-entrancy:** each ticket opened is recorded in `tickets.raised` as soon as it exists (as `raiseNoticed` does), with `blocker: true`. A retried publish reuses this run's record before it searches or creates anything. Linking is already a `step('blockers')`.
- **Resuming:** this needs no new code. The ticket keeps its stage and gets `blocked_by` set, so the queue shows "Depends on #N" and sync releases it once the blockers close. A classifier-blocked ticket is classified again. A design- or implement-blocked ticket reruns that stage. Partial commits are pushed (`publish: true`), as with `needs_info`.

## Changes

### `server/src/workflow/schemas.ts`

- `ClassifierResult.raise_blockers?: Noticed[]`.
- `WorkResult.outcome` gains `'blocked'`, plus `raise_blockers?: Noticed[]`.
- Add `export const BLOCKING_AGENTS: AgentName[] = ['design', 'implement']`.
- Add `RAISE_BLOCKERS_SCHEMA`: an array with `maxItems: MAX_NOTICED` and the same item shape as `NOTICED_SCHEMA`. Its description says: "Prerequisite work this ticket can't be finished without, that is outside its scope and that no open ticket covers (blocked only). Workshop opens a ticket for each and waits for it." The `body` description says it must be self-contained for someone who hasn't seen this ticket.
- `schemaFor(agent, { noticed, blockers })`. With `blockers`:
  - Classifier: add the `raise_blockers` property, and change the `blocked_by` description to "…(blocked only; may be empty when raise_blockers is given)".
  - `BLOCKING_AGENTS`: the `outcome` enum becomes `['done', 'needs_info', 'failed', 'blocked']`, and the `raise_blockers` property is added.
- `parseResult`:
  - Classifier `blocked`: `blocked_by` may be absent or empty, but when present it must still be a list of positive integers. A list of `{ title, body }` (`isText`) must pass as `raise_blockers` when present. At least one of the two must be non-empty, else `'blocked requires blocked_by (open ticket numbers) or raise_blockers (new prerequisite tickets).'`.
  - Work agents: `outcome: 'blocked'` is valid only for `BLOCKING_AGENTS` and needs a non-empty `raise_blockers`, else `'blocked requires raise_blockers: the prerequisite tickets to open.'`. Otherwise the outcome error stays `'outcome must be done, needs_info or failed.'`, with ", or blocked" for the blocking agents. Validate the `raise_blockers` items whenever the field is present.

### `server/src/workflow/transitions.ts`

- `Plan.raiseBlockers?: Noticed[]`: prerequisite tickets to open (or find) and link as blocking this ticket.
- Extract `planWait(numbers: number[], raise: Noticed[], reason: string): Plan`, which returns `{ add: [], remove: [], addBlockers?, raiseBlockers?, comment }`. Leave out `addBlockers` when `numbers` is empty, and `raiseBlockers` when `raise` is empty, so old plans and tests are unchanged. The comment:
  - Numbers only: today's text, unchanged.
  - Otherwise: `Workshop will wait for ${numbers.length ? `${refs} and ` : ''}the prerequisite tickets listed below before working on this ticket: ${reason}\n\nIt carries on once they're closed. If it shouldn't wait, remove the link under Relationships and say so in a comment.`
- `planClassifier` `blocked` returns `planWait(r.blocked_by ?? [], r.raise_blockers ?? [], r.reason)`.
- `planTransition`, after the `needs_info` line: `if (r.outcome === 'blocked') return { ...planWait([], r.raise_blockers ?? [], r.summary), publish: true };`. This sits before the agent `switch`, so a reconcile's inner plan gets it too.

### `server/src/workflow/prompts.ts`

- `protocolText` gets `blockers?: boolean`. When it's set, add this rule after the noticed one:
  > - If this ticket can't be finished without other work that is outside its scope and that no open ticket covers (a capability it builds on, not a follow-up), don't build it here and don't ask the owner for it. Return "blocked" with that work under "raise_blockers": a title, and a body that someone who hasn't seen this ticket can act on. Workshop opens a ticket for each, waits for them, then runs this stage again. At most ${MAX_NOTICED}. Keep "noticed" for work that doesn't stop this ticket.
- When both `noticed` and `blockers` are set, change "don't let it stop you" in the noticed rule to "don't let it stop you (if it does, see the next rule)".
- `TaskContext.raiseBlockers?: boolean`. When it's set, the classifier's `taskLine` sentence becomes: `If this ticket can't be done until other work is finished, return "blocked": put the numbers of the open tickets above that cover it in blocked_by, and describe prerequisite work that no open ticket covers under raise_blockers.` That sentence applies even when there are no other open tickets. Without the flag, today's sentence stays.

### `server/src/scheduler/runner.ts`

- Next to `mayRaise`, add `const mayRaiseBlockers = (repo, t, agent) => Boolean(repo.raise_tickets) && (agent === 'classifier' || BLOCKING_AGENTS.includes(agent)) && !labelsOf(t).includes(label.raised);`.
- `runSpec`: pass `blockers: mayRaiseBlockers(...)` to `schemaFor`. Pass it to `protocolText` too, but only for `BLOCKING_AGENTS`, because the classifier gets its rule through `taskLine`. Pass `raiseBlockers` to `taskPrompt`.
- New `raiseBlockers(ctx, t, wanted: Noticed[]): Promise<{ number: number; title: string; existing: boolean }[]>`. If `!mayRaiseBlockers` it returns `[]`. Otherwise it handles each of `wanted.slice(0, MAX_NOTICED)` in order:
  1. Normalise the title as `raiseNoticed` does (whitespace collapsed, at most `MAX_RAISED_TITLE` characters).
  2. If a `raisedOf(getTicket(t.id)!)` entry has `runId === r.id` and the same title, it's a retry: reuse that number (`existing: false`).
  3. If an open ticket in the repository other than `t` has the same title (`sameTitle`, local `tickets` table), reuse it (`existing: true`).
  4. Otherwise call `createTicket` with:
     - `labels: [label.raised, ...(labelsOf(t).includes(label.nominated) ? [label.nominated] : [])]`, so a nominated-only repository doesn't strand the parent;
     - a body of `${body.trim().slice(0, MAX_RAISED_BODY)}\n\n---\n_Workshop's ${label} agent raised this as a prerequisite of #${t.number}, which waits until this ticket is closed._`.

     Record `{ number, url, title, runId: r.id, blocker: true }` in `tickets.raised` straight away.
  5. Remove duplicate numbers and `t.number` from the list.
- `publishRun`: replace the `if (plan.addBlockers)` block with `if (plan.addBlockers || plan.raiseBlockers)`. Call `raiseBlockers` outside any step: it's idempotent and its result is needed for the comment. Then `step('blockers')` links the union `[...(plan.addBlockers ?? []), ...made.map((m) => m.number)]` minus `t.number`. The "none open" error keeps its check and names the agent: `The ${AGENT_INFO[r.agent].label} agent said this ticket waits for …`.
- The comment is `[plan.comment, blockersLine(made), raisedLine(raised)]`, where `blockersLine` is `Prerequisite tickets this one waits for:\n- #41 Title\n- #12 Title (already open)`.
- `summarize`: for a classifier `blocked` result, list the refs and then `N new ticket(s)`, for example `Waiting for #2 and 1 new ticket: …`. With numbers only, the text stays as it is today.

### `server/src/tickets.ts`

- `Raised.blocker?: boolean` (the ticket was raised as a prerequisite). Update its doc comment.

### Docs and copy

- `README.md`: in the raise-tickets setting section, add a bullet. When a ticket needs prerequisite work that no open ticket covers, the Classifier, Design or Implementation agent can raise it as a blocker. Workshop opens it (or links an open ticket with the same title), and the ticket waits for it. Raised blockers also get `workshop/nominated` when the ticket has it.
- `docs/design/workflow.md`:
  - Classifier `blocked` table row: mention `raise_blockers`.
  - Add a row for Design and Implementation `blocked` ("no label change; pushes partial work; opens or links prerequisites; reruns the stage once they close").
  - In the "Tickets for what agents notice" section, add a paragraph on blockers: `mayRaiseBlockers`, the `raised` record with `blocker: true`, and title reuse.
  - The result shapes at line ~202.
- `client/src/pages/Connections.tsx`: change the checkbox `title` to "When an agent comes across a problem outside its ticket, or work its ticket needs first, Workshop opens a ticket for it." Leave the label text as it is.

## Data and interfaces

- No migration: `tickets.raised` is JSON, and `blocker` is an optional field.
- Result schemas gain `raise_blockers`, and the work agents gain `outcome: "blocked"`, but only when the setting allows it.
- `Plan.raiseBlockers` is stored in `runs.publish_state`. Plans stored before the change lack it and behave as before.
- No HTTP API change.

## Tests

Run `npm run typecheck` and `npm test`.

- `server/test/workflow.test.ts`:
  - `parseResult`:
    - classifier `blocked` with only `raise_blockers` is valid;
    - with neither field, or with an empty `raise_blockers` item title, it's an error;
    - `outcome: 'blocked'` is valid for design and implement, but rejected for code-review and merge, and rejected without `raise_blockers`.
  - `schemaFor` with and without `blockers`:
    - classifier gets `raise_blockers`;
    - design gets the `blocked` enum value;
    - code-review gets neither.
  - `planTransition`:
    - classifier blocked with numbers only gives the same plan and comment as today;
    - with `raise_blockers` it gives `raiseBlockers`, no labels and the new comment;
    - design `blocked` gives `publish: true`, no labels, `raiseBlockers` and no failure.
  - `protocolText` and `taskPrompt`: the rule and sentence appear only with the flag.
- `server/test/pipeline.test.ts`, new `describe('raising blockers')`. Use `raise_tickets = 1`, a counter-based `createTicket` and the default `addBlocker` fake, like the noticed suite.
  - A classifier `blocked` result with one `raise_blockers` entry:
    - one `createTicket` call, with `[label.raised]` and the prerequisite footer;
    - `addBlocker(_, 3, 41)`, with `blocked_by` `["#41"]` and the queue showing `Depends on #41`;
    - a comment listing `- #41`, and the run summary `Waiting for 1 new ticket: …`;
    - after the link is closed (follow the existing dependency-release test), the ticket is picked up again.
  - An open ticket with the same title is linked, with no `createTicket` call, and the comment says "(already open)".
  - Retry: `addBlocker` throws a 502 the first time (see `gatewayError` and `due` in the publish-retry tests). After the publish retry, `createTicket` has still been called once and `addBlocker` succeeds once with that number.
  - Mixed `blocked_by: [2]` plus one raise gives links to both.
  - A parent with `workshop/nominated` gives the new ticket `nominated` too.
  - Setting off, or the ticket labelled `workshop/raised`:
    - `raise_blockers` is missing from schema.json;
    - a `blocked` result with only `raise_blockers` fails the run readably ("none of those is an open issue"), with no `createTicket` call.
  - Design `blocked`:
    - the work is published;
    - the stage label is unchanged and there's no `needs_info`;
    - blockers are linked.
  - The existing `dependencies`, noticed and needs_info suites pass unchanged.

## Risks and open questions

- **Duplicates by meaning, not title.** The work agents don't see the open-ticket list, and title matching only catches exact matches. The Classifier does see the list, which reduces this. If duplicates show up in practice, give Design and Implementation a titles-only open-ticket list and allow `blocked_by` for them.
- **No chains.** Prerequisites raised this way can't raise their own (the `workshop/raised` rule). A prerequisite that itself needs a prerequisite falls back to `needs_info`. This is deliberate: it bounds how many tickets are opened in one go.
- **Shared setting.** Owners who want noticed tickets but not automatic blockers can't separate them. A separate toggle needs a migration and UI. Add it later if asked.
- **Reused existing tickets** aren't relabelled. In a nominated-only repository, an un-nominated match keeps the parent waiting until the owner nominates it. The comment names it, so the owner can see why.
- **Cycles.** A title match could point at a ticket that already waits on this one. Workshop only filters out self-links. GitHub stores the cycle and both tickets wait, which the owner can see on the dependency graph.
