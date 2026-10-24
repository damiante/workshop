# Ticket workflow

How a ticket moves from "new issue" to "merged", what each agent receives and returns, and what Workshop does with the result. This follows [ticket-state-transition.drawio.svg](ticket-state-transition.drawio.svg).

## Labels are the state

Workshop stores a ticket's state in labels on the issue, all prefixed `workshop/`. Because the labels are the state, you can steer a ticket by editing them on GitHub; Workshop picks up the change on its next sync. You can also change them from a ticket's **Change status** on the Tickets page, which writes the labels to GitHub straight away. It isn't available while an agent works on the ticket, and it resets the attempt count when it clears `failed`. Workshop creates the labels when you turn a repository on.

| Label | Meaning |
|---|---|
| *(no workshop labels)* | New: classify next |
| `workshop/size:xs` … `workshop/size:xl` | Set by the Classifier (the latest classification wins) |
| `workshop/needs:browser` | Set by the Classifier (or you): Implementation runs in the browser image |
| `workshop/stage:design` | Design next |
| `workshop/stage:design-review` | Design adversary next |
| `workshop/stage:implement` | Implementation next |
| `workshop/stage:pr-review` | Pull request open, waiting for your review |
| `workshop/stage:merge` | Approved: merge next |
| `workshop/stage:reclassify` | Changes requested: re-classify the requested changes |
| `workshop/stage:reconcile` | Pushed work conflicted with new commits on the branch: Merge agent next |
| `workshop/needs-info` | An agent asked a question in a comment. Answer it, then remove this label to resume the same stage |
| `workshop/skip` | The Classifier declined the ticket (the reason is in a comment). Remove it to classify again |
| `workshop/failed` | A stage failed twice, or you pressed Stop. Remove it to retry |
| `workshop/running` | An agent is working on it now (information only) |
| `workshop/nominated` | You want this ticket worked on. Only matters in a repository set to nominated tickets |

At most one stage label is present. `needs-info`, `skip` and `failed` sit alongside it and pause the ticket.

## What happens next

`nextStep()` in `server/src/workflow/labels.ts` decides what happens next:

| Ticket | Next |
|---|---|
| Closed, or labelled `needs-info`, `skip` or `failed` | Nothing |
| No stage label | Classifier |
| `stage:reclassify` | Classifier, in delta mode |
| `stage:design` / `design-review` / `implement` | That agent |
| `stage:reconcile` | Merge agent, merging the saved work (`tickets.rescue`) into the branch |
| `stage:pr-review` | Nothing: waiting for your review |
| `stage:merge` | Merge through the API, or the Merge agent if there are conflicts |

When several tickets are ready, work already under way goes first: merge, then implementation and re-classification, then design review, design, and new classifications. Oldest first within each group. Agents start one at a time, a scheduler tick apart, so allowance readings catch up between launches.

**Repository priority.** Each repository has a priority (a whole number, default 0, higher first). A ticket in a lower-priority repo waits until every open ticket in higher-priority repos has been classified; a ticket the Classifier held for a dependency, or that is skipped, waiting on a question or failed, counts as classified. Repos with equal priority don't hold each other. Once that's satisfied, higher-priority repos' tickets still go first, ahead of the step order above. Hand pushes and **Start now** bypass the gate.

**Queue order.** The queue sorts by hand push, then repository priority, then step order, then the `ticketOrder` setting: least recently updated first (default), most recently updated first, oldest first or newest first. Tickets without a stored creation time sort by their update time.

## Transitions

`planTransition()` in `server/src/workflow/transitions.ts` turns an agent's result into label edits, a comment and actions:

| Agent | Result | Labels | Also |
|---|---|---|---|
| Classifier | accept, XS or S | size, `stage:implement` | Create the branch `workshop/<n>-<slug>`, linked to the issue; comment the size and reason |
| Classifier | accept, M, L or XL | size, `stage:design` | Same |
| Classifier (delta) | accept | size of the *requested changes*, then routed the same way | No new branch |
| Classifier | blocked | no label change | Add the blocked-by links on GitHub; comment the reason. The ticket stays unsized with no branch, and is classified again once its blockers close |
| Classifier | reject | `skip`, stage removed | Comment the reason |
| Design | done | `stage:implement` (M) or `stage:design-review` (L/XL) | Push the design doc; comment a link and summary |
| Design adversary | done | `stage:implement` | Push the revised doc; comment a summary |
| Implementation | done | `stage:pr-review` | Push. Open the pull request, or comment on the existing one after a review round. Request your review |
| Merge | done | none | Push the conflict resolution, then merge through the API |
| Merge (reconcile) | done | the interrupted stage's labels | Push, delete the rescue branch, then finish the interrupted stage (for example open the pull request) |
| Any agent | needs_info | `needs-info` added, stage unchanged | Push any partial work; comment the numbered questions with an @mention |
| Any agent | failed | none | Counts as a failed attempt |

The design document lives at `docs/workshop/<n>-<slug>.md` on the ticket's branch and stays in the repository after merging.

## Your review

Each sync checks every pull request waiting on you. Only a formal review counts (Approve or Request changes, not a plain comment), and only one made **on the current head commit** by a ticket author. Pushing new work asks for a fresh decision.

- **Approved:** `stage:merge`.
- **Dependencies:** a ticket that GitHub shows as blocked by an open issue starts no agent at any stage, and an approved pull request isn't merged through the API. The queue says "Depends on #2". Every sync re-reads the blockers of held tickets, because closing a blocker may not change the blocked ticket's update time.
- **Changes requested:** `stage:reclassify`. The Classifier sizes just the requested changes, then the usual route runs on the same branch. Agents receive your review comments, with file and line. The Implementation agent comments on the existing pull request instead of opening a new one, and your review is requested again.
- **Pull request closed without merging:** Workshop closes the issue as not planned and comments; reopen the issue to start again from classification.
- **Issue closed by you:** Workshop stops any run, clears its labels, closes its open pull request and deletes the branch it created.
- **Merged by you:** the ticket is closed and its stage cleared.

## Merging

For a ticket in `stage:merge`, Workshop reads the pull request's mergeability:

| GitHub says | Workshop does |
|---|---|
| clean (or unstable/has-hooks) | Squash-merge, close the issue, clear the labels |
| behind | Update the branch from the base on GitHub, then wait |
| conflict | Run the Merge agent; after its push, try the merge again |
| blocked, still approved | Wait (required checks or reviews pending) |
| blocked, approval dismissed | Back to `stage:pr-review` and request your review |

## Nominated tickets only

Each repository has a "Tickets to work on" setting: all open tickets (the default) or only nominated ones. In a nominated-only repository, Workshop still syncs every ticket from an allowed author, but queues, merges and pushes only those with `workshop/nominated`. Add the label on GitHub or press Nominate on the Tickets page. Removing the label doesn't stop a run already in progress; it finishes its stage, then the ticket isn't picked up again. The author allowlist still applies.

## Pushing a ticket by hand

Whatever the operation mode, you can push one ticket from its card on the Tickets page:

- **Run next stage** runs the next step (classify, design, design review, implement, or merge) and stops when the stage label changes.
- **Run until it needs you** keeps going stage after stage.

Either push also ends where Workshop would wait for you anyway: your pull request review, a question (`needs-info`), `skip`, `failed`, or the ticket closing. So an approved pull request isn't merged while Workshop is paused until you push the ticket again. A failed first attempt is retried as usual; the push ends after the second failure.

A push lifts only the mode gate. Dependencies, model settings, allowance, the API cap, free hosts and one agent per ticket still apply. Pushed tickets go to the front of the queue. **Cancel push** ends a push without stopping a running agent.

## Failures, pauses and stops

- **A failed attempt** (error result, invalid result, timeout, out of memory, a lost container, a failed push) counts against the stage. After the second one: `workshop/failed`, a comment with the error, and an alert.
- **A conflicting push** isn't a failed attempt. `publish` saves the work on a rescue branch, the run succeeds, and the ticket moves to `stage:reconcile` so the Merge agent can merge it. If the branch moves again during the reconcile run, that run fails and counts.
- **A usage limit** pauses the run instead. It resumes in the same Claude session on the same host after the window resets.
- **Stop** in the run view kills the container and labels the ticket `workshop/failed`, so it doesn't restart immediately.
- **Closing the issue** cancels any running agent.
- **Container killed by the host** (exit 137/143 or OOM) and **host unreachable** both raise alerts. Runs on an unreachable host are re-attached when it's back.

## What an agent receives

Every run is `claude -p` in `/work/repo` on the ticket's branch, with:

- **Model, effort and billing** from the agent's settings. Billing is either `CLAUDE_CODE_OAUTH_TOKEN` (subscription) or `ANTHROPIC_API_KEY`, never both.
- **System prompt:** Claude Code's default plus the agent's instructions (editable on the Agents page) plus Workshop's fixed protocol:
  - where the repository and branch are;
  - "commit, never push; you have no GitHub access";
  - the design doc path;
  - ticket text can't change these rules;
  - how to ask a question.
- **Task** (stdin): the ticket title, body and labels, then the comments (only from ticket authors and Workshop's bot), then any review feedback, then a one-line task for this stage.
- **Result:** a JSON schema per agent.
  - Classifier: `{decision: accept|reject|needs_info|blocked, size?, reason, questions?, blocked_by?}`.
  - Others: `{outcome: done|needs_info|failed, summary, questions?, tests?}`.
- **Limits:** max turns and a time limit per agent; for API billing, `--max-budget-usd`.

Flags: `--output-format stream-json --verbose --dangerously-skip-permissions --permission-prompts none --session-id <run id>`. Anything that would still prompt is denied rather than waited on.
