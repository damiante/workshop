# Design: implicit priority for dependencies (#119)

## Context

Prioritising a ticket (`tickets.prioritised`) moves it ahead in the queue. But if B is prioritised and depends on A, B is held by `dependencyBlock` until A closes, and A waits in the normal pool, so the priority does nothing. When you prioritise a ticket, everything it waits for, directly or through other tickets, should go first too. These tickets get **implicit** priority: it's worked out from the graph and never stored, so it disappears as soon as B loses its priority or closes. The UI must show both sides: B depends on A, and A is prioritised because of B.

## Approach

- **Work it out from the stored blockers.** `tickets.blocked_by` already holds each open ticket's *open* blockers as refs (`#2`, `other/repo#5`). Together they form a dependency graph. For every explicitly prioritised open ticket, walk its blockers transitively and record that ticket on each one it reaches. A visited set per walk handles cycles and shared ancestors, so the result is correct for any graph, not only a DAG. Nothing is stored, so there's no migration, nothing to clear when B is deprioritised or closes, and no way for the result to go stale.
- **Implicit priority counts the same as explicit priority in the scheduler**: the same sort tier, and the same bypass of the repository priority gate (`priorityBlock`). It lifts no other gate (mode, hours, limits, nomination), just as explicit priority doesn't. Blockers outside Workshop's database (a disabled repo, an author you don't allow) can't be reached, and are just shown as refs.
- **Sync keeps the chain moving.** `syncBlockers` already re-reads the blockers of prioritised held tickets first. Implicitly prioritised ones are added to that list, so a chain A → C is noticed as soon as C closes.
- **Show it in the views.** `TicketView` gains `dependsOn` and `prioritisedFor`, and `QueueItem` gains `prioritisedFor`. The card, the ticket page and the dashboard queue show them. The "Prioritised" tag and the brown edge stay for explicit priority only, as the ticket asks.

## Changes

- `server/src/scheduler/gates.ts`: a pure function:
  ```ts
  /** For each ticket, the explicitly prioritised tickets that wait on it, directly or through others (sorted). Keys are `owner/repo#n`, lower case. */
  export function implicitPriority(nodes: { key: string; prioritised: boolean; blockers: string[] }[]): Map<string, string[]>
  ```
  For each prioritised node, do an iterative DFS over `blockers` (skipping keys that aren't nodes), with its own visited set, and add the root's key to every node it reaches except the root itself. A node that is itself prioritised can still be listed (if B and A are both prioritised, A's list holds B). The UI decides what to show.
- `server/src/tickets.ts`:
  - `refKey(ref: string, repoFullName: string)`: turns `#n` into `repo#n` and lowercases it (the same normalisation as `looksFree` in `sync.ts`; use it there too).
  - `displayRef(key, repo)`: `#n` when `key` is in `repo`, otherwise `owner/repo#n` with its original case (keep a key → `{ id, ref }` map from the rows).
  - `priorityGraph()`: reads open tickets in enabled repos (`openTicketsSql` joined to get `full_name`), builds the nodes and calls `implicitPriority`. It returns `{ prioritisedFor(t: TicketRow, repo: RepoRow): TicketRefView[]; resolve(ref: string, repo: RepoRow): TicketRefView }`, where `resolve` maps a blocker ref to `{ ref, ticketId }` (`ticketId` is null when Workshop doesn't have it).
  - `ticketView(t, repo, graph = priorityGraph())`: adds `dependsOn: blockersOf(t).map((r) => graph.resolve(r, repo))` and `prioritisedFor: graph.prioritisedFor(t, repo)`. `listTicketViews` builds the graph once and passes it in. Single-ticket callers in `api.ts` keep the default.
- `server/src/scheduler/loop.ts` (`buildQueue`): build the graph once. For each row, `const prioritisedFor = graph.prioritisedFor(t, repo).map((r) => r.ref)` and `const boosted = Boolean(t.prioritised) || prioritisedFor.length > 0`. Use `boosted` instead of `t.prioritised` in the `priorityReason` bypass and in the sort (the `prioritised` field stays the explicit flag). `Candidate` gains `prioritisedFor: string[]`. `queueView` passes it through.
- `server/src/scheduler/sync.ts` (`syncBlockers`): `urgent` also includes held tickets with a non-empty `prioritisedFor` (build the graph once per call).
- `server/src/http/openapi.ts`: a `TicketRef` schema `{ ref: str, ticketId: nullable(int) }`. `TicketView` gains `dependsOn: array(ref('TicketRef'))` and `prioritisedFor: array(ref('TicketRef'))`. `QueueItem` gains `prioritisedFor: array(str)`. Update the `/tickets/{id}/prioritised` description to say that tickets it depends on go first too.
- `client/src/pages/Tickets.tsx`:
  - `Card`: when `!t.prioritised && t.prioritisedFor.length`, show a tag "Prioritised for #B" (refs joined with ", "), with the title "#B is prioritised and depends on this ticket". B's card already shows "Next: Depends on #A".
  - Column sort (line ~354): explicit priority first, then implicit, then the rest: rank `prioritised ? 2 : prioritisedFor.length ? 1 : 0`.
- `client/src/pages/Ticket.tsx`: below the tag row, show a small line "Depends on #A, #C" when `dependsOn` is non-empty, and "Prioritised because #B depends on it" when `!prioritised && prioritisedFor.length`. Each ref links to `/tickets/:ticketId` when `ticketId` isn't null, and is plain text otherwise. Use the same tag in the tag row as on the card.
- `client/src/pages/Dashboard.tsx` (queue list): next to "Prioritised by you", show `{!q.push && !q.prioritised && q.prioritisedFor.length > 0 && <span className="small muted">Prioritised for {q.prioritisedFor.join(', ')}</span>}`.
- Docs: in `docs/design/workflow.md` under "Prioritising a ticket", add a paragraph on implicit priority. In `docs/api.md`, describe the new fields in the `prioritised` paragraph.

## Data and interfaces

No schema change. In `server/src/api-types.ts`:

```ts
/** Another ticket, by its display ref (`#2`, `other/repo#5`), and its Workshop id when Workshop tracks it. */
export interface TicketRefView { ref: string; ticketId: number | null }
// TicketView
  /** Open tickets this one waits for. */
  dependsOn: TicketRefView[];
  /** Prioritised tickets that wait on this one, directly or through others; it goes first for them. */
  prioritisedFor: TicketRefView[];
// QueueItem
  /** Refs of the prioritised tickets this one goes first for. */
  prioritisedFor: string[];
```

## Tests

- `server/test/gates.test.ts`, `implicitPriority`: a chain (B → A → C, B prioritised: A and C list B, B lists nothing), a diamond, a cycle (A ↔ B with B prioritised ends without listing B for itself), a blocker that isn't a node, and two prioritised roots sharing a blocker (sorted, no duplicates).
- `server/test/pipeline.test.ts`, near "manual pushes" and the repository priority tests:
  - B (prioritised, `blocked_by '["#A"]'`) and A, plus another unprioritised ticket that would normally sort first: `buildQueue()[0]` is A, with `prioritisedFor: ['#B']` and `prioritised: false`. After `setPrioritised(B, false)`, the normal order returns.
  - A in a lower-priority repo isn't held by `priorityBlock` while B is prioritised.
  - A cross-repo blocker ref (`other/repo#n`) resolves.
  - `syncBlockers` re-reads an implicitly prioritised held ticket first (extend the test at line ~2330).
- `server/test/api.test.ts`: `GET /api/tickets/:id` for A shows `prioritisedFor: [{ ref: '#B', ticketId }]`, and for B shows `dependsOn` with A's id. `/api/overview` queue items carry `prioritisedFor`.
- Browser check: seed two tickets in the dev server, prioritise B, then screenshot the board, A's ticket page and the dashboard.

Run `npm run typecheck` and `npm test`.

## Risks and open questions

- The graph is rebuilt on every `buildQueue`, `listTicketViews` and single `ticketView`. That's one query over open tickets plus a linear walk per prioritised ticket. That's cheap at Workshop's scale, and `listTicketViews` builds it only once.
- An implicitly prioritised ticket that isn't nominated in a nominated-only repository still won't run, and B waits. Its card shows "Not nominated" with the "Prioritised for #B" tag, so you can see why. Auto-nominating it is out of scope.
- Chain links that the Classifier hasn't found yet (an unclassified blocker that will itself turn out to be blocked) appear only after it does. Implicit priority speeds that up, because A is classified first.
