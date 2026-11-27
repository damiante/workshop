# 126 — Queue order follows the dependency graph; ticket order only breaks ties

## Context

`buildQueue` (`server/src/scheduler/loop.ts`) sorts by push, then boosted (prioritised, or a blocker of a prioritised ticket, #121), then repository priority, then step order. The `ticketOrder` setting decides the rest. Among unboosted tickets the dependency graph plays no part. So a new prerequisite that 90 tickets wait on, such as one an agent raised with `raise_blockers`, queues behind every older unrelated ticket when the setting is "oldest first", and everything waiting on it stalls.

Outcome: a ticket that other open tickets wait on goes ahead of one that nobody waits on, and the more open work waits on it, the earlier it goes. Pushed and boosted tickets still go first. With no dependency links the order is exactly what it is today. The dashboard's "Up next" list says why a ticket is ahead ("Unblocks 90 open tickets").

## Approach

**Metric.** `unblocks` is the number of distinct open tickets that wait on this ticket, directly or through other tickets. It is computed from the same stored `blocked_by` refs and the same rows (`openTicketsSql`) that `priorityGraph()` already walks, so cross-repo links count the same way. Keys go through `refKey`. The ticket itself is never counted, even in a cycle. Blockers Workshop doesn't know about are skipped. We count tickets rather than the longest chain because the count is what "how much work stalls" means, and it's easy to show.

**Sort placement.** The new sort is: pushed, boosted, **`unblocks` descending**, repository priority, step order, then `ticketOrder` through the existing stable sort.

- It goes after pushed and boosted because the ticket requires both to stay first.
- It goes before step order. The motivating case is a freshly raised prerequisite that still needs classifying (step 4). If step order came first, that prerequisite would wait behind every in-flight design and implementation in every repo, which is the stall this ticket is about.
- It goes before repository priority because the ticket says dependency order comes first, and a lower-priority repo's ticket that blocks work is holding up that work. Only the order changes: a ticket in a lower-priority repo is still held by `priorityBlock` until the higher repos are classified. No gate is lifted.
- When `unblocks` is equal (including 0 for every ticket, the no-links case), the comparator falls through to today's keys unchanged.

**Cost.** Each tick does one reverse-edge DFS per ticket that has dependents, with a visited set per DFS. For sparse graphs of a few thousand tickets that's cheap, and it's the same kind of work `implicitPriority` already does. Nothing is stored.

## Changes

- `server/src/scheduler/gates.ts`: add a pure function `waitingCounts(nodes: { key: string; blockers: string[] }[]): Map<string, number>`, placed after `implicitPriority`. It builds a `blocker → dependents` map from the known nodes, runs an iterative DFS from each key that has dependents, and counts what it reaches, excluding the root. Only keys with a count above 0 go in the map. Doc comment in the style of `implicitPriority`.
- `server/src/tickets.ts`:
  - In `priorityGraph()`, compute `waitingCounts` over the same node list as `implicitPriority`. Build the node list once and pass it to both.
  - Add `unblocks(t: TicketRow, repo: RepoRow): number` to the `PriorityGraph` interface: `counts.get(refKey('#' + t.number, repo.full_name)) ?? 0`.
- `server/src/scheduler/loop.ts`:
  - Add `unblocks: number` to `Candidate`, with a doc comment ("Open tickets that wait on this one, directly or through others").
  - Set it in `buildQueue` from `graph.unblocks(t, repo)`.
  - Sort: `Number(b.pushed) - Number(a.pushed) || Number(b.boosted) - Number(a.boosted) || b.unblocks - a.unblocks || b.repoPriority - a.repoPriority || a.priority - b.priority`. Update the comment above it.
  - `queueView` maps `unblocks: c.unblocks`.
- `server/src/api-types.ts`: add `unblocks: number` to `QueueItem`, with the comment "Open tickets that wait on this one, directly or through others."
- `server/src/http/openapi.ts`: add `unblocks: int` to the `QueueItem` schema.
- `client/src/pages/Dashboard.tsx`, "Up next": after the "Prioritised for" line, add `{q.unblocks > 0 && <span className="small muted">Unblocks {q.unblocks} open {q.unblocks === 1 ? 'ticket' : 'tickets'}</span>}`. It shows whether or not the ticket is pushed or prioritised, because it's true either way.
- `docs/design/workflow.md`:
  - Change the "Queue order" paragraph (around line 49) to: hand push, manual and implicit priority, **then how many open tickets wait on it (directly or through others; more first)**, then repository priority, step order, `ticketOrder`.
  - Add a clause to the step-order sentence (line 45) saying that tickets other tickets wait on go ahead of it.
  - Add one line to the "Implicit priority" section about the "Unblocks N open tickets" note on the dashboard.

## Data and interfaces

- No schema or settings change.
- `QueueItem` (in `/api/overview`'s `queue`) gains `unblocks: number`, always present, 0 when nothing waits on the ticket.
- `PriorityGraph` gains `unblocks()`.
- The `waitingCounts` export is new.

## Tests

Bug-first: write the pipeline test below first and watch it fail.

- `server/test/gates.test.ts`, `describe('waitingCounts')`, using the same `node` helper style as `implicitPriority`'s tests:
  - a chain (`c ← b ← a`, so `c` counts 2 and `b` counts 1);
  - a diamond, where the shared blocker counts each dependent once;
  - a cycle, where no ticket counts itself;
  - unknown blockers, which are skipped;
  - cross-repo keys (`x/lib#5` blocking `r/app#1` and `r/app#2` gives 2);
  - an empty map with no links.
- `server/test/pipeline.test.ts`, inside `describe('ticket order')` (it already has an `add` helper and cleanup; extend the cleanup to the new numbers):
  - With `created-asc`, add an older unclassified ticket and a newer unclassified ticket that 5 open tickets (`blocked_by: ['#n']`) wait on. The newer one comes first among the startable ones.
  - Transitive: A ← B ← C beats D ← E (2 vs 1), whatever their ages.
  - Equal counts: two blockers, each with one dependent. `created-asc` and `created-desc` flip their order.
  - Cross-repo: a ticket in a second enabled repo that a repo-1 ticket waits on (`blocked_by: ['owner/other#n']`) gets `unblocks` 1 and goes ahead. If the suite has no second repo fixture, insert one row and delete it afterwards.
  - Prioritised and pushed still go first. A prioritised ticket with no dependents comes before a ticket that unblocks 5, and `setPush` puts its ticket at index 0.
  - The existing ticket-order tests stay green unchanged (no links means no change).
- `server/test/api.test.ts`: in the existing "shows what a prioritised ticket depends on" test, assert `/api/overview` queue items carry `unblocks` (1 for `a`, 0 for the others).
- Browser check: run the server and client with seeded tickets and links, and screenshot the dashboard's "Up next" showing "Unblocks N open tickets". Save the screenshot to `/work/media/`.
- Run `npm run typecheck` and `npm test`.

## Risks and open questions

- **Ahead of step order and repo priority.** A new classification that unblocks one ticket now starts before an unrelated in-flight implementation or merge. That matches the ticket's "dependency order first", but it trades some finish-what-you-started behaviour. If the owner prefers in-flight work first, moving `unblocks` after the `priority` key is a one-line change. The tests above would only need the fixtures' stages aligned.
- **What gets counted.** Every open ticket in an enabled repo counts, including ones out of scope (not nominated, disallowed author). That keeps it the same set `priorityGraph` uses. Those tickets are still real waiting work, and a ticket doesn't become eligible because of it.
- **Where it shows.** Only the dashboard queue shows "Unblocks N". The Tickets board's column order (`priorityRank`) and the ticket page are unchanged. They could show it later through `TicketView`, but that isn't needed for the queue order.
