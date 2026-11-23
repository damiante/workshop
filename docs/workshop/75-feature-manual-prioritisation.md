# Manual prioritisation (#75)

## Context

You can already **push** a ticket from the Tickets page. A push lifts the operation-mode gate and puts the ticket at the front of the queue. It ends where Workshop would wait for you (a question, your review, failed, skip, closed), or after one stage for a stage push. You want something different and longer-lived: a toggle that says "work on this one before anything else". It should last for the ticket's entire lifecycle, through any pauses for you, until the ticket closes or you turn it off.

Outcome:
- Each ticket card gets a **Prioritise** button, and **Remove priority** once it's set.
- A prioritised ticket sorts ahead of every ticket that isn't prioritised, in every stage. Running agents aren't interrupted. When a run ends, `onRunSettled(kick)` starts a tick, and `buildQueue` picks the best prioritised ticket that's ready.
- Prioritised tickets are clearly marked on the Tickets page, the ticket page and the dashboard's Up next list.
- When several tickets are prioritised, the existing order decides between them: repository priority, then step order, then the `ticketOrder` setting.

## Approach

- **A separate flag, not a third push scope.** A push is permission to run outside the operation mode and hours, and it ends on its own. Prioritisation only changes order. It keeps respecting mode and hours, allowance, the API cap, dependencies and free hosts, and it stays set until you clear it or the ticket closes. Mixing the two would change what a push means. Store it as `tickets.prioritised INTEGER NOT NULL DEFAULT 0`. A boolean is enough because ties use the existing order, as the ticket asks.
- **Queue order** becomes: pushed, then prioritised, then repository priority, then step, then `ticketOrder`. Pushes stay first because a push is an explicit "run this now", often while Workshop is paused, when a prioritised ticket couldn't run anyway.
- **The repository-priority gate** (`priorityBlock`: wait until higher-priority repos are classified) is lifted for prioritised tickets, as it is for pushed ones. Otherwise a prioritised ticket in a low-priority repo would still wait behind other repos, so it wouldn't be "above everything". The mode gate is **not** lifted.
- **Lifetime:** the flag stays through questions, review, failed and skip. Those tickets have no next step, so `buildQueue` already skips them, and they go first again once you act on them. The scheduler clears it when the ticket is closed (merged or closed on GitHub), so a reopened ticket doesn't jump the queue. Nothing else clears it.
- **API:** `PUT /api/tickets/:id/prioritised` with `{ "prioritised": true | false }`, modelled on `/nominated` and `/dismissed`. It goes on `apiRouter`, in `openapi.ts` and in `docs/api.md`, because a script could reasonably use it.

## Changes

### `server/src/db.ts`
Append a migration: `ALTER TABLE tickets ADD COLUMN prioritised INTEGER NOT NULL DEFAULT 0; -- you prioritised it by hand; cleared when it closes`.

### `server/src/tickets.ts`
- `TicketRow`: add `prioritised: number`.
- Add this next to `setPush`:
  ```ts
  export function setPrioritised(t: TicketRow, on: boolean) {
    run('UPDATE tickets SET prioritised = ? WHERE id = ?', on ? 1 : 0, t.id);
    t.prioritised = on ? 1 : 0;
    publish('tickets');
    publish('runs');
  }
  ```
  `runs` makes the dashboard's queue refetch, as `setPush` does.
- `ticketView`: add `prioritised: Boolean(t.prioritised)`.

### `server/src/api-types.ts`
- `TicketView`: `/** You put this ticket ahead of the rest of the queue; it stays until you remove it or the ticket closes. */ prioritised: boolean;`
- `QueueItem`: `prioritised: boolean;`
- `Settings.ticketOrder` doc: "Order of tickets within the same push, prioritisation, repo priority and step."

### `server/src/scheduler/loop.ts`
- `Candidate`: add `prioritised: boolean`. Set it in `buildQueue` from `Boolean(t.prioritised)`.
- `buildQueue`: `let blockedBy = dependencyBlock(blockersOf(t)) ?? (t.push ? null : modeReason ?? (t.prioritised ? null : priorityReason));`
- Sort: `Number(b.pushed) - Number(a.pushed) || Number(b.prioritised) - Number(a.prioritised) || b.repoPriority - a.repoPriority || a.priority - b.priority`.
- `queueView`: add `prioritised: c.prioritised`.
- `settlePushes()`: also clear the flag on closed tickets. Rename it to `settleManual()`, update the call in `tick` and the test imports, and update its doc to "Clears hand pushes that are finished or no longer eligible, and priority on closed tickets." Add:
  ```ts
  for (const t of all<TicketRow>("SELECT * FROM tickets WHERE prioritised = 1 AND state = 'closed'")) setPrioritised(t, false);
  ```

### `server/src/http/api.ts`
Add this route after `/tickets/:id/dismissed`:
```ts
apiRouter.put('/tickets/:id/prioritised', (req, res) => {
  const { t, repo } = pushableTicket(req.params.id);
  const prioritised = req.body?.prioritised;
  check(typeof prioritised === 'boolean', 'Say whether to prioritise the ticket.');
  if (prioritised) {
    check(t.state === 'open', 'This ticket is closed.', 409);
    check(ticketInScope(t, repo), 'This repository only works on nominated tickets. Nominate this ticket first.', 409);
  }
  setPrioritised(t, prioritised);
  if (prioritised) kick();
  res.json(ticketView(t, repo));
});
```
Removing priority is always allowed.

### `server/src/http/openapi.ts`
- `TicketView` schema: add `prioritised: bool`. `QueueItem` schema: add `prioritised: bool` (and the missing `push: nullable(enumOf('stage', 'lifecycle'))` while you're there).
- Route `'/tickets/{id}/prioritised'`: `put`, summary `'Puts the ticket ahead of every ticket you haven\'t prioritised, for its whole lifecycle, or removes that. Send { "prioritised": true | false }. Workshop\'s mode and hours still apply. Cleared when the ticket closes.'`, `params: ['id']`, `body: object({ prioritised: bool })`, `ok: ref('TicketView')`, `errors: [400, 403, 404, 409]`.

### `client/src/pages/Tickets.tsx`
- New `PriorityControls({ t })`, in the same shape as `NominateControls` (busy and error state, `ErrorNote`). It calls `api(\`/tickets/${t.id}/prioritised\`, { method: 'PUT', body: { prioritised: !t.prioritised } })`. Button text: **Prioritise** / **Remove priority**. When it's on, show `<span className="muted">Prioritised</span>` before the button, like "Nominated". Render nothing when `t.state !== 'open' && !t.prioritised`.
- `Card`: use `className={t.prioritised ? 'card prioritised' : 'card'}`, and in the header row show `<span className="tag">Prioritised</span>` before the size tag (wrap both tags in a `<span className="row">` so `spread` keeps them together). Render `<PriorityControls t={t} />` just before `PushControls`, under the same `t.nominated !== false` condition.
- `Tickets`: in each column, show prioritised tickets first: `const tickets = shown.filter(col.match).sort((a, b) => Number(b.prioritised) - Number(a.prioritised));` (`filter` returns a new array, and the sort is stable).

### `client/src/theme.css`
After `.card`: `.card.prioritised { border-left: 3px solid var(--accent); }`. This matches the existing `.notice` accent edge, uses no new colour, and the "Prioritised" tag carries the meaning in words.

### `client/src/pages/Ticket.tsx`
In the header tags (line ~60), add `{t.prioritised && <span className="tag">Prioritised</span>}`.

### `client/src/pages/Dashboard.tsx`
Up next: under the push line, add `{q.prioritised && !q.push && <span className="small muted">Prioritised by you</span>}`.

### `client/src/pages/Settings.tsx`
Ticket-order help: "Pushed and prioritised tickets, higher-priority repositories and work already in progress still go first. This decides the order among the rest."

### Docs
- `docs/design/workflow.md`: change the queue order to "hand push, then manual priority, then repository priority, …". In the repository-priority paragraph, say that prioritised tickets also bypass that gate. After "Pushing a ticket by hand", add a short "Prioritising a ticket" section covering what it does, what it doesn't lift (mode and hours, every other gate), that it lasts through waits for you, and that it's cleared on close or with **Remove priority**.
- `docs/api.md`: a paragraph on `PUT /api/tickets/:id/prioritised` (body, response, 400/404/409 cases) next to the nominated/dismissed paragraphs, plus a curl example in the examples block.

## Data and interfaces

- DB: `tickets.prioritised INTEGER NOT NULL DEFAULT 0` (new migration).
- API: `PUT /api/tickets/:id/prioritised` `{ prioritised: boolean }` → `TicketView`. The errors are:
  - 400 when `prioritised` isn't a boolean;
  - 404 for an unknown, disabled-repo or non-allowlisted ticket;
  - 409 when prioritising a closed ticket, or a ticket that isn't nominated in a nominated-only repo.
- `TicketView.prioritised: boolean`, `QueueItem.prioritised: boolean`.

## Tests

- `server/test/pipeline.test.ts`: a new `describe('manual priority')` modelled on `manual pushes`, which inserts a second ticket the way "sorts pushed tickets ahead of the rest" does:
  - a prioritised ticket sorts ahead of a ticket with a better step (merge conflict), and behind a pushed ticket;
  - it's still `Workshop is paused` while paused (mode not lifted);
  - with an unclassified ticket in a higher-priority repo, a prioritised ticket in the lower repo isn't held by `priorityBlock`, and a ticket that isn't prioritised is;
  - between two prioritised tickets, the higher repo priority goes first;
  - `settleManual()` clears the flag on a closed ticket and leaves an open one (including one with `needs-info`) alone.
- `server/test/api.test.ts`: `PUT /tickets/:id/prioritised` gives 400 for a non-boolean, 404 for an unknown ticket, 200 setting it (`body.prioritised === true`) and 200 removing it, 409 prioritising a closed ticket, and 200 removing priority from a closed ticket. The openapi coverage test will fail if the route is missing from `openapi.ts`.
- In the browser, check the Tickets page at desktop and phone widths in both themes: the button toggles, the tag and accent edge appear, and the card moves to the top of its column. Save screenshots to `/work/media/`.
- Run `npm run typecheck` and `npm test`.

## Risks and open questions

- **Push and priority order:** I chose pushed before prioritised (see Approach). If the owner wants prioritised first, swap the first two sort keys.
- **Several hosts or slots:** "picked up as soon as the current run finishes" holds when one slot is free. With spare slots, a prioritised ticket starts right away on the next tick (prioritising calls `kick()`). Paused runs that are resuming still go before new launches (`resumePaused` runs before the queue), and that counts as "the current run".
- Withdrawing a nomination, or disabling a repo, leaves the flag set but the ticket out of the queue. If you nominate it again, it's prioritised again. This is intended.
