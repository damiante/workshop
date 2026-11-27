# Manual limit bypass for a ticket (#110)

## Context

Each Claude subscription has limits you set, a 5-hour % and a weekly % (`Limits`, edited on Settings). When usage goes over either one, Workshop stops launching agents on that subscription (`allowanceBlock` → `thresholdBlock`). Running agents pause at their next turn boundary (`pause_reason: 'threshold'`), and those runs resume only once usage drops back under. You want to pick one ticket that goes through its lifecycle past those limits, while the rest of the backlog keeps waiting.

Outcome:
- Each open ticket card gets an **Ignore usage limits** button. Once it's on, the card shows a "Ignores limits" tag and a **Respect usage limits** button.
- A flagged ticket's agents launch, keep running and resume even when a subscription is over your limits.
- Limits Claude itself reports still apply to flagged tickets: a usage-limit block (`blockedUntil`) and a `limit` pause, which resumes at its reset. So does the fail-closed rule (no fresh reading means no subscription launch).
- The flag lasts through the ticket's whole lifecycle, like **Prioritise**, and is cleared when the ticket closes.

## Approach

- **A separate flag, `tickets.bypass_limits`, in the same shape as `prioritised`** (#75). A bypass only lifts a gate. It changes neither the order nor the mode and hours, so the ticket can still be held by "Workshop is paused" or wait its turn behind other tickets. You can combine it with **Prioritise** or a push if you want it to go first. Folding it into a push or into priority would make those mean something else.
- **One option on the allowance gate:** `allowanceBlock(a, s, now, ignoreLimits = false)`. With `ignoreLimits` it still returns the `blockedUntil` reason and `'Checking allowance'`, but skips `thresholdBlock`. Every gate path that knows its ticket passes `Boolean(ticket.bypass_limits)`:
  - the launch queue (`buildQueue` through `subscriptions`/`pickSubscription`);
  - `resumePaused` and `resumeNow`;
  - `moveTarget`;
  - the runner's `overThreshold`, which returns null for a flagged ticket.

  The runner re-reads the ticket each time it checks, so turning the flag on or off takes effect at the next turn boundary.
- **Subscription choice for a flagged ticket** keeps your order: the first subscription that isn't blocked when your limits are ignored. In practice that's your first subscription Claude hasn't limited.
- **Out of scope: the API daily cap.** The ticket is about subscription limits. The cap is a money limit, and lifting it per ticket is a separate decision (see Risks).
- **Lifetime:** the flag is cleared in `settleManual()` when the ticket closes, as `prioritised` is. Removing it is always allowed. Setting it needs an open ticket that is in scope.

## Changes

### `server/src/db.ts`
Append a migration: `ALTER TABLE tickets ADD COLUMN bypass_limits INTEGER NOT NULL DEFAULT 0; -- you let it run past your subscription limits; cleared when it closes`.

### `server/src/tickets.ts`
- `TicketRow`: add `bypass_limits: number`.
- Add `setBypassLimits(t, on)` next to `setPrioritised`, with the same body: update the column, mirror it on `t`, then `publish('tickets')` and `publish('runs')`.
- `ticketView`: add `bypassLimits: Boolean(t.bypass_limits)`.

### `server/src/api-types.ts`
- `TicketView`: `/** Workshop's usage limits don't hold this ticket's agents; limits Claude reports still do. Cleared when it closes. */ bypassLimits: boolean;`
- `QueueItem`: `bypassLimits: boolean;`

### `server/src/scheduler/gates.ts`
`allowanceBlock` gains a 4th parameter `ignoreLimits = false`. Its last line becomes `return ignoreLimits ? null : thresholdBlock(...)?.reason ?? null;`. Update the doc comment.

### `server/src/scheduler/loop.ts`
- `subscriptions(s, now, ignoreLimits = false)` passes the flag on to `allowanceBlock`.
- `buildQueue`: build `pool` as today. Also build `bypassPool = subscriptions(s, now, true)`, but only when some row has `bypass_limits`, to avoid the extra reads. Use `t.bypass_limits ? bypassPool : pool` in `pickSubscription(offering(...))` and in the "every subscription is paused" checks.
- `Candidate`: add `bypassLimits: boolean`. `queueView` adds `bypassLimits: c.bypassLimits`.
- `moveTarget(r, s, now)`: pass `Boolean(getTicket(r.ticket_id)?.bypass_limits)` to `subscriptions`.
- `resumePaused` and `resumeNow`: call `allowanceBlock(allowanceOf(id), s, now, bypass)`, where `bypass` is `Boolean(getTicket(r.ticket_id)?.bypass_limits)`. Both paths keep the existing `resets_at` wait for `limit` pauses unchanged, so a run Claude stopped still waits for the reset.
- `settleManual()`: add `for (const t of all<TicketRow>("SELECT * FROM tickets WHERE bypass_limits = 1 AND state = 'closed'")) setBypassLimits(t, false);`, and extend its doc comment.

### `server/src/scheduler/runner.ts`
In `runAgent`'s `overThreshold`, add `if (getTicket(r.ticket_id)?.bypass_limits) return null;` after the billing check. Claude's own limit handling (`recordLimit`, the `limit` pause) is untouched. Turning the flag on doesn't send a pause signal. Turning it off takes effect when the run's next output line triggers the pause check.

### `server/src/http/api.ts`
Add this after `/tickets/:id/prioritised`, modelled on it:
```ts
apiRouter.put('/tickets/:id/bypass-limits', (req, res) => {
  const { t, repo } = pushableTicket(req.params.id);
  const bypassLimits = req.body?.bypassLimits;
  check(typeof bypassLimits === 'boolean', 'Say whether this ticket should ignore your usage limits.');
  if (bypassLimits) {
    check(t.state === 'open', 'This ticket is closed.', 409);
    check(ticketInScope(t, repo), 'This repository only works on nominated tickets. Nominate this ticket first.', 409);
  }
  setBypassLimits(t, bypassLimits);
  if (bypassLimits) kick(); // launches it, or resumes its run paused at your limits
  res.json(ticketView(t, repo));
});
```

### `server/src/http/openapi.ts`
- Add `bypassLimits: bool` to the `TicketView` and `QueueItem` schemas.
- Add the route `'/tickets/{id}/bypass-limits'`:
  - `put`, with summary `'Lets this ticket\'s agents start, run and resume past your subscription usage limits for its whole lifecycle, or removes that. Send { "bypassLimits": true | false }. Limits Claude reports, the API daily cap, mode and hours still apply. Cleared when the ticket closes.'`;
  - `params: ['id']`, `body: object({ bypassLimits: bool })`, `ok: ref('TicketView')`, `errors: [400, 403, 404, 409]`.

### `client/src/pages/Tickets.tsx`
- Add `BypassControls({ t })`, a copy of `PriorityControls`. It calls `PUT /tickets/${t.id}/bypass-limits` with `{ bypassLimits }`.
  - Buttons: **Ignore usage limits** / **Respect usage limits**.
  - When the flag is on, put `<span className="muted">Ignores usage limits</span>` before the button.
  - Render nothing when `t.state !== 'open' && !t.bypassLimits`.
  - The button's `title`: "Agents on this ticket keep going past your 5-hour and weekly limits. Limits Claude reports still stop them."
- `Card`:
  - Header tags: add `{t.bypassLimits && <span className="tag">Ignores limits</span>}` after the Prioritised tag.
  - Render `<BypassControls t={t} />` after `<PriorityControls t={t} />`, inside the same `t.nominated !== false` block.
  - No new card colour or sort order.

### `client/src/pages/Ticket.tsx`
In the header tags, next to Prioritised, add `{t.bypassLimits && <span className="tag">Ignores limits</span>}`.

### `client/src/pages/Dashboard.tsx`
Up next: next to the "Prioritised by you" line, add `{q.bypassLimits && <span className="small muted">Ignores your usage limits</span>}`.

### Docs
- `docs/design/workflow.md`: after "Prioritising a ticket", add an "Ignoring usage limits for a ticket" section. It should cover:
  - what the flag lifts: your 5-hour and weekly limits, for launches, running agents and resumes;
  - what still applies: limits Claude reports, fail-closed on a stale reading, the API cap, mode and hours, order and every other gate;
  - how long it lasts (until close, or **Respect usage limits**);
  - that it combines with Prioritise or a push to also go first.

  In the line "A push lifts only the mode gate…", nothing changes.
- `docs/api.md`: add a paragraph on `PUT /api/tickets/:id/bypass-limits` after the prioritised paragraph. Cover the same body, response and 400/404/409 cases, and `bypassLimits` in `queue`. Add a curl example after the prioritised one.

## Data and interfaces

- DB: `tickets.bypass_limits INTEGER NOT NULL DEFAULT 0`, added by a new migration.
- API: `PUT /api/tickets/:id/bypass-limits` with `{ bypassLimits: boolean }` returns a `TicketView`. Errors:
  - 400 when `bypassLimits` isn't a boolean;
  - 404 when the ticket is unknown, in a disabled repository or by an author who isn't allowlisted;
  - 409 when turning it on for a closed ticket, or for a ticket that isn't nominated in a nominated-only repository.
- Views: `TicketView.bypassLimits` and `QueueItem.bypassLimits` (boolean).
- `allowanceBlock(a, s, now, ignoreLimits?)`: the new parameter is optional, so existing callers don't change.

## Tests

- `server/test/gates.test.ts`: `allowanceBlock` with `ignoreLimits`:
  - with usage over the limits, it returns null;
  - it still returns the `blockedUntil` reason;
  - it still returns `'Checking allowance'` for a stale or missing reading.
- `server/test/pipeline.test.ts`, in a new `describe('ignoring usage limits')`, using the setups from `pausing at the usage thresholds` and `manual priority`:
  - with a fresh reading over the 5-hour limit, a flagged ticket's queue item has no `blockedBy`, while an unflagged ticket shows the "5-hour allowance at …" reason;
  - with a `recordLimit` block, the flagged ticket is still blocked ("Claude reported …");
  - with no fresh reading, it's still "Checking allowance";
  - a flagged ticket's run doesn't pause on a reading over the threshold, and an unflagged one does (as in the existing threshold test);
  - a run paused for `threshold` resumes through `resumePaused` once its ticket is flagged, and a `limit`-paused run with a future `resets_at` doesn't;
  - `resumeNow` resumes a manually paused run over the limits when the ticket is flagged;
  - `settleManual()` clears the flag on a closed ticket and leaves an open one alone;
  - while Workshop is paused, a flagged ticket is still "Workshop is paused".
- `server/test/api.test.ts`: `PUT /tickets/:id/bypass-limits` returns:
  - 400 for a non-boolean;
  - 404 for an unknown ticket;
  - 200 when setting the flag (`body.bypassLimits === true`) and 200 when removing it;
  - 409 when turning it on for a closed ticket;
  - 200 when turning it off for a closed ticket.

  The openapi coverage test catches a missing schema entry.
- In the browser, check the Tickets page at desktop and phone widths, in light and dark themes:
  - the button toggles;
  - the tag shows on the card and on the ticket page;
  - the card's header row doesn't overflow when all of Prioritised, Ignores limits and the size tag are present.

  Save screenshots to `/work/media/`.
- Run `npm run typecheck` and `npm test`.

## Risks and open questions

- **Running into Claude's real limit.** A flagged ticket can use a subscription up to Claude's own limit. When Claude reports that limit, launches on that subscription stop for every ticket until it resets (`blockedUntil`). That is what you're opting into, and the button's title says so.
- **API daily cap left in place.** If the owner also wants the flag to lift `apiCapBlock` for API-billed agents, that's one more `t.bypass_limits ? null : apiCapBlock(...)` in `buildQueue`, plus updated copy ("Ignore limits"). `--max-budget-usd` per run would still apply. I recommend leaving the cap in place, as the ticket is about subscription limits.
- **No queue jump.** By design, the flag doesn't change the order. When Workshop is otherwise idle because everything else is over the limits, the flagged ticket is the only one that can launch, so it runs next anyway.
