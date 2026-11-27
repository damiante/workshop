# Ticket workflow

How a ticket moves from "new issue" to "merged", what each agent receives and returns, and what Workshop does with the result. This follows [ticket-state-transition.drawio.svg](ticket-state-transition.drawio.svg).

## Labels are the state

Workshop stores a ticket's state in labels on the issue, all prefixed `workshop/`. Because the labels are the state, you can steer a ticket by editing them on GitHub; Workshop picks up the change on its next sync. You can also change them from a ticket's **Change status** on the Tickets page, which writes the labels to GitHub straight away. It isn't available while an agent works on the ticket, and it resets the attempt count when it clears `failed`. Workshop creates the labels when you turn a repository on.

| Label | Meaning |
|---|---|
| *(no workshop labels)* | New: classify next |
| `workshop/size:xs` … `workshop/size:xl` | Set by the Classifier (the latest classification wins) |
| `workshop/needs:browser` | Set by the Classifier (or you): Implementation and the Code reviewer run in the browser image |
| `workshop/stage:design` | Design next |
| `workshop/stage:design-review` | Design adversary next |
| `workshop/stage:implement` | Implementation next |
| `workshop/stage:code-review` | Code reviewer next (the work is pushed, the pull request isn't open yet) |
| `workshop/stage:pr-review` | Pull request open, waiting for your review |
| `workshop/stage:merge` | Approved: merge next |
| `workshop/stage:reclassify` | Changes requested: re-classify the requested changes |
| `workshop/stage:reconcile` | Pushed work conflicted with new commits on the branch: Merge agent next |
| `workshop/needs-info` | An agent asked a question in a comment. Answer it, then remove this label to resume the same stage |
| `workshop/skip` | The Classifier declined the ticket (the reason is in a comment). Remove it to classify again. Adding it yourself stops any run, clears a push and hides the ticket on the next sync |
| `workshop/failed` | A stage failed twice, or you pressed Stop. Remove it to retry |
| `workshop/running` | An agent is working on it now (information only) |
| `workshop/nominated` | You want this ticket worked on. Only matters in a repository set to nominated tickets |
| `workshop/raised` | An agent opened this ticket for something it noticed while working on another (information, and its agents can't open more) |

At most one stage label is present. `needs-info`, `skip` and `failed` sit alongside it and pause the ticket.

## What happens next

`nextStep()` in `server/src/workflow/labels.ts` decides what happens next:

| Ticket | Next |
|---|---|
| Closed, or labelled `needs-info`, `skip` or `failed` | Nothing |
| No stage label | Classifier |
| `stage:reclassify` | Classifier, in delta mode |
| `stage:design` / `design-review` / `implement` / `code-review` | That agent |
| `stage:reconcile` | Merge agent, merging the saved work (`tickets.rescue`) into the branch |
| `stage:pr-review` | Nothing: waiting for your review |
| `stage:merge` | Merge through the API, or the Merge agent if there are conflicts |

When several tickets are ready, work already under way goes first: merge, then implementation, code review and re-classification, then design review, design, and new classifications. Oldest first within each group. Each pass starts agents until no ready ticket fits a free slot. Runs that go over a subscription's limits pause at their next turn boundary.

**Repository priority.** Each repository has a priority (a whole number, default 0, higher first). A ticket in a lower-priority repo waits until every open ticket in higher-priority repos has been classified; a ticket the Classifier held for a dependency, or that is skipped, waiting on a question or failed, counts as classified. Repos with equal priority don't hold each other. Once that's satisfied, higher-priority repos' tickets still go first, ahead of the step order above. Hand pushes, prioritised tickets and **Start now** bypass the gate.

**Queue order.** The queue sorts by hand push, then manual priority, then repository priority, then step order, then the `ticketOrder` setting: least recently updated first (default), most recently updated first, oldest first or newest first. Tickets without a stored creation time sort by their update time.

## Transitions

`planTransition()` in `server/src/workflow/transitions.ts` turns an agent's result into label edits, a comment and actions:

| Agent | Result | Labels | Also |
|---|---|---|---|
| Classifier | accept, XS or S | size, `stage:implement` | Create the branch `workshop/<n>-<slug>`, linked to the issue; comment the size and reason |
| Classifier | accept, M, L or XL | size, `stage:design` | Same |
| Classifier (delta) | accept | size of the *requested changes*, then routed the same way | No new branch |
| Classifier | blocked | no label change | Add the blocked-by links on GitHub (`blocked_by` numbers, plus a ticket opened or found by title for each `raise_blockers` entry); comment the reason. The ticket stays unsized with no branch, and is classified again once its blockers close |
| Classifier | reject | `skip`, stage removed | Comment the reason |
| Design | done | `stage:implement` (M) or `stage:design-review` (L/XL) | Push the design doc; comment a link and summary |
| Design adversary | done | `stage:implement` | Push the revised doc; comment a summary |
| Design or Implementation | blocked | no label change | Push partial work; open or link the `raise_blockers` prerequisites as blocked-by; comment them. The stage runs again once they close |
| Implementation | done | `stage:code-review` | Push; store the summary for the pull request (`tickets.handoff`); comment |
| Code reviewer | done, nothing severe | `stage:pr-review` | Open the pull request with the Implementation summary and a Code review section, or comment on the existing one after a review round. Request your review |
| Code reviewer | done, severe findings, no rework yet this round | `stage:design` (M/L/XL, design at fault) or `stage:implement` | Store the severe findings (`tickets.rework`); comment them. Nothing is pushed |
| Code reviewer | done, severe findings after the rework | `stage:pr-review` (plus `needs-info` with Merge without review) | Open or update the pull request with the findings flagged at the top |
| Merge | done | none | Push the conflict resolution, then merge through the API |
| Merge (reconcile) | done | the interrupted stage's labels | Push, delete the rescue branch, then finish the interrupted stage (for example store the Implementation summary and move to code review) |
| Any agent | needs_info | `needs-info` added, stage unchanged | Push any partial work (not the Code reviewer's); comment the numbered questions with an @mention |
| Any agent | failed | none | Counts as a failed attempt |

The design document lives at `docs/workshop/<n>-<slug>.md` on the ticket's branch and stays in the repository after merging.

## Code review

Every ticket gets a code review after Implementation, before the pull request opens. The Code reviewer reads the diff against the base branch, runs the tests and type-check, and returns findings. It never publishes: anything it changes or commits is discarded with its container.

Each finding has a severity and a cause:

- **severe**: verified and glaring. The change doesn't do what the ticket or your review asks, breaks existing behaviour, loses data, opens a security hole, crashes on an ordinary path, fails the repository's own checks, or follows a design that can't work. "When in doubt, it isn't severe."
- **moderate**: an edge-path bug, a missing test, a clear deviation from the conventions or design.
- **minor**: style, naming, comments and docs.
- **cause**: `design` when the fix changes the design's approach, otherwise `implementation`.

Workshop routes on these fields, not on the reviewer's opinion (`stageForRework` in `transitions.ts`). A severe finding sends the ticket back to design when the cause is the design and the ticket has one (M, L, XL), otherwise to implementation. The severe findings are stored in `tickets.rework` and given to the Design, Design adversary, Implementation and the next Code reviewer runs. After a rework, the Code reviewer marks each severe finding it was sent back for that still holds with `repeat`. A new severe problem sends the ticket back again; a repeated one means the rework failed, so the findings go into the pull request, flagged at the top. `MAX_REWORKS` (3) caps the send-backs in one review round (the first pull request, or each round of requested changes) in case every review finds something new. In a repository with **Merge without review** on, the ticket also gets `workshop/needs-info` so it can't merge unattended; remove the label to let it merge, or request changes.

Moderate and minor findings are listed in the pull request's Code review section for you to decide on. At most 30 findings are shown, with long text cut.

A Code reviewer that keeps failing leaves the ticket at `stage:code-review` with `workshop/failed` and no pull request. Moving the ticket to `stage:pr-review` by hand doesn't open one: fix the Code reviewer's settings on the Agents page, then remove `workshop/failed` to retry.

## Your review

Each sync checks every pull request waiting on you. Only a formal review counts (Approve or Request changes, not a plain comment), and only one made **on the current head commit** by a ticket author. Pushing new work asks for a fresh decision.

- **Approved:** `stage:merge`.
- **Merge without review:** in a repository with this setting on, an open pull request goes to `stage:merge` on the next sync without an approval. Workshop still opens it and requests your review, so you can read it afterwards. Changes you request before it merges still send it to `stage:reclassify`, from `stage:pr-review` or `stage:merge`.
- **Dependencies:** a ticket that GitHub shows as blocked by an open issue starts no agent at any stage, and an approved pull request isn't merged through the API. The queue says "Depends on #2". Every sync re-reads the blockers of held tickets, because closing a blocker may not change the blocked ticket's update time. Tickets you prioritised or pushed are read first, every sync; after them, at most 100 others per repository, starting with those whose blocker Workshop has seen close. So when one blocker frees hundreds of tickets, they're released over several syncs instead of one long sync that holds up the scheduler.
- **Changes requested:** `stage:reclassify`. The Classifier sizes just the requested changes, then the usual route runs on the same branch. Agents receive your review comments, with file and line. After Implementation and the code review, Workshop comments on the existing pull request instead of opening a new one, and your review is requested again.
- **Pull request closed without merging:** Workshop closes the issue as not planned and comments; reopen the issue to start again from classification.
- **Issue closed by you:** Workshop stops any run, clears its labels, closes its open pull request and deletes the branch it created.
- **Merged (by Workshop, the Merge agent or you):** the ticket is closed, its stage cleared, and its branch and any rescue branch are deleted. A branch that can't be deleted is logged and ignored.

## Merging

For a ticket in `stage:merge`, Workshop reads the pull request's mergeability:

| GitHub says | Workshop does |
|---|---|
| clean (or unstable/has-hooks) | Squash-merge, close the issue, clear the labels |
| behind | Update the branch from the base on GitHub, then wait |
| conflict | Run the Merge agent; after its push, try the merge again |
| blocked, still approved | Wait (required checks or reviews pending) |
| blocked, approval dismissed (setting off) | Back to `stage:pr-review` and request your review |
| blocked, merge without review on | Wait (required checks pending) |

Turning **Merge without review** on checks the rules on the repository's default branch through the provider (`VcsHost.mergeRules`):

- **A required approving review applies** (a ruleset's pull request rule Workshop can't bypass, or classic branch protection requiring reviews): the setting is refused, because the Workshop App can't approve its own pull requests. Remove the requirement or add the App as a bypass actor.
- **No required status checks:** allowed, with a warning that failing CI won't stop a merge. GitHub reports failing checks that aren't required as unstable, and Workshop merges those. Make CI a required status check on repositories that use this setting.
- **Can't tell:** allowed, with a warning that says what couldn't be checked. Classic protection's review settings need the `administration` permission, which the App doesn't request, so they usually can't be read.

The warning is saved when the setting is turned on and shown under the repository's settings. Rules changed later on GitHub aren't checked again; turn the setting off and on to check them.

## Tickets for what agents notice

In a repository with **Agents open tickets for what they notice** on, every agent but the Classifier gets a `noticed` list in its result schema and a rule in the protocol: report real work outside the ticket there, don't do it. `raiseNoticed` in `scheduler/runner.ts` opens a ticket for each when the run is published (at most `MAX_NOTICED`, 3), labelled `workshop/raised`, and Workshop's comment on the ticket lists them.

- Each opened ticket is recorded in `tickets.raised` at once, so a publish retried after a GitHub failure doesn't open it twice, and a later run on the same ticket doesn't repeat it. A title that an open ticket in the repository already has is left out.
- A ticket carrying `workshop/raised` gets neither the schema field nor the rule (`mayRaise`), so the chain stops after one step.
- **Blockers.** Under the same setting (`mayRaiseBlockers`), the Classifier, Design and Implementation agents may also return `raise_blockers`: prerequisite work outside the ticket that no open ticket covers. Design and Implementation return it with `outcome: "blocked"`, and the rule for when to use it is in the protocol (the Classifier's is in its task line). `raiseBlockers` reuses a `tickets.raised` record with `blocker: true` and the same title (from any run on the ticket, so retries and reruns don't duplicate), then an open ticket with that title, and otherwise opens one labelled `workshop/raised` (plus `workshop/nominated` when the ticket has it) and records it at once. The `blockers` step links them all; a candidate whose stored `blocked_by` already holds this ticket is dropped with a run warning, so a raised ticket's Classifier can't deadlock with its parent. Not on `workshop/raised` tickets, and at most `MAX_NOTICED` per run.
- The new tickets follow the repository's usual rules: they wait for `workshop/nominated` in a nominated-only repository, and their author (the App's bot, or you with a personal access token) has to be an allowed author.

## Pushing to the default branch

A repository with **Push to the default branch, no pull request** on has no pull request and no review stage. `planReview` sends a passed review to `stage:merge` with the review as a comment on the issue (`pushToDefault` in the plan's context), and `advanceMerge` hands a ticket with no pull request to `pushToDefault` in `scheduler/merge.ts`:

| The ticket's branch | Workshop does |
|---|---|
| has nothing the default branch lacks | Comment, close the issue, clear the labels |
| lacks commits from the default branch | Merge the default branch into it on GitHub, then wait for the next check |
| conflicts with the default branch | Run the Merge agent (the ticket's status becomes `conflict`); after its push, try again |
| holds everything on the default branch | Create one commit with the branch's files on top of the default branch, move the default branch to it (never forced), comment the commit, close the issue, delete the branch |
| the move is refused (a branch rule, or the default branch moved meanwhile) | Raise a `merge-failed` alert and try again on the next check |

The commit's message is `pushMessage()`: the first line of the branch's first commit plus `(#n)`, then the later commits as a list. Severe findings that remain after a rework add `workshop/needs-info` instead of pushing; removing it pushes. A ticket that already has a pull request (the setting was turned on later) finishes through the pull request.

## Nominated tickets only

Each repository has a "Tickets to work on" setting: all open tickets or only nominated ones (the default for newly enrolled repositories; repositories already on keep their setting). In a nominated-only repository, Workshop still syncs every ticket from an allowed author, but queues, merges and pushes only those with `workshop/nominated`. Add the label on GitHub or press Nominate on the Tickets page. Removing the label doesn't stop a run already in progress; it finishes its stage, then the ticket isn't picked up again. The author allowlist still applies.

## Pushing a ticket by hand

Whatever the operation mode, you can push one ticket from its card on the Tickets page:

- **Run next stage** runs the next step (classify, design, design review, implement, code review, or merge) and stops when the stage label changes. After Implementation it stops at code review, before the pull request opens.
- **Run until it needs you** keeps going stage after stage.

Either push also ends where Workshop would wait for you anyway: your pull request review, a question (`needs-info`), `skip`, `failed`, or the ticket closing. So an approved pull request isn't merged while Workshop is paused until you push the ticket again. A failed first attempt is retried as usual; the push ends after the second failure.

A push lifts only the mode gate. Dependencies, model settings, allowance, the API cap, free hosts and one agent per ticket still apply. Pushed tickets go to the front of the queue. **Cancel push** ends a push without stopping a running agent.

## Prioritising a ticket

**Prioritise** on a ticket's card puts it ahead of every ticket you haven't prioritised, in every stage. A running agent isn't interrupted; the prioritised ticket is the next one picked up when an agent host is free. Among several prioritised tickets the usual order decides (repository priority, step, ticket order), and pushed tickets still go first.

Priority only changes the order. It doesn't lift the operation mode or hours, or any other gate; it does skip waiting for higher-priority repositories to be classified. Unlike a push, it lasts through waits for you (questions, your review, failures and skip): once you act, the ticket goes first again. It's cleared when the ticket closes, or with **Remove priority**. Prioritised tickets show a "Prioritised" tag, a brown left edge and sit at the top of their column.

**Implicit priority.** A prioritised ticket that depends on others can't start until they close, so the open tickets it waits for, directly or through other tickets, go first too. Workshop works this out each time from the stored blockers, so nothing extra is saved: remove the priority or close the ticket and its dependencies go back to the usual order. They're ordered and pass the repository priority gate like a prioritised ticket, but no other gate is lifted; a dependency that isn't nominated in a nominated-only repository still waits. Their cards show "Prioritised for #B" instead of the "Prioritised" tag and sit just below the prioritised cards; the ticket page lists what a ticket depends on and which prioritised tickets it goes first for. Sync re-reads the blockers of these tickets early, so a chain keeps moving as each blocker closes.

## Ignoring usage limits for a ticket

**Ignore usage limits** on a ticket's card lets that ticket's agents start, keep running and resume while a Claude subscription is over your 5-hour or weekly limit. Every other ticket still waits for usage to drop under your limits. Use it for the one ticket you want now when the rest of the backlog can wait.

Only your own limits are lifted. A usage limit Claude reports still stops the ticket's agents until it resets, and so does the rule that a subscription launch needs a fresh usage reading. The API daily cap, the operation mode and hours, the queue order and every other gate still apply. Combine it with **Prioritise** or a push if the ticket should also go first.

It lasts through the ticket's whole lifecycle and is cleared when the ticket closes, or with **Respect usage limits**. Turning it off pauses a running agent at its next turn boundary if usage is still over your limits. Flagged tickets show an "Ignores limits" tag.

## Failures, pauses and stops

- **A failed attempt** (error result, invalid result, timeout, out of memory, a lost container, a failed push) counts against the stage. After the second one: `workshop/failed`, a comment with the error, and an alert.
- **GitHub failing while publishing** (5xx, rate limit, network) isn't a failed attempt. The run waits in publishing and Workshop retries only the publish step (after 1, 5 and 15 minutes, then every 30). After 6 hours it counts as a failure and raises an alert.
- **A conflicting push** isn't a failed attempt. `publish` saves the work on a rescue branch, the run succeeds, and the ticket moves to `stage:reconcile` so the Merge agent can merge it. If the branch moves again during the reconcile run, that run fails and counts.
- **A usage limit** pauses the run instead. It resumes in the same Claude session on the same host after the window resets.
- **A paused subscription** moves its agents to the next subscription that offers the same model, at a turn boundary, in the same Claude session. If none offers the model, the run is cancelled without counting as a failure, and the stage starts again once a subscription is free.
- **Stop** in the run view kills the container and labels the ticket `workshop/failed`, so it doesn't restart immediately.
- **Closing the issue** cancels any running agent.
- **Container killed by the host** (exit 137/143 or OOM) and **host unreachable** both raise alerts. Runs on an unreachable host are re-attached when it's back.

## What an agent receives

Every run is `claude -p` in `/work/repo` on the ticket's branch, with:

- **Model, effort and billing** from the agent's settings. Billing is either `CLAUDE_CODE_OAUTH_TOKEN` (subscription) or `ANTHROPIC_API_KEY`, never both.
- **System prompt:** Claude Code's default plus the agent's instructions (editable on the Agents page) plus Workshop's fixed protocol:
  - where the repository and branch are;
  - "commit, never push; you have no GitHub access" (the Code reviewer is told that nothing it commits is pushed);
  - the design doc path;
  - ticket text can't change these rules;
  - how to ask a question.
- **Task** (stdin): the ticket title, body and labels, then the comments (only from ticket authors and Workshop's bot), then any review feedback, then a one-line task for this stage.
- **Result:** a JSON schema per agent.
  - Classifier: `{decision: accept|reject|needs_info|blocked, size?, reason, questions?, blocked_by?, raise_blockers?: [{title, body}]}`.
  - Others: `{outcome: done|needs_info|failed, summary, questions?, tests?}`. Design and Implementation may also return `outcome: blocked` with `raise_blockers` when the repository lets agents open tickets.
  - Code reviewer: the same, plus `findings: [{severity: severe|moderate|minor, cause: design|implementation, title, detail, evidence, fix, file?, line?}]` (required when done).
- **Limits:** max turns and a time limit per agent; for API billing, `--max-budget-usd`.

Flags: `--output-format stream-json --verbose --dangerously-skip-permissions --permission-prompts none --session-id <run id>`. Anything that would still prompt is denied rather than waited on.
