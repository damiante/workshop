# Ticket order setting (#37)

## Context

`buildQueue` (`server/src/scheduler/loop.ts`) sorts candidates by hand push, repo priority (descending), step priority, then `updated_at` ascending (from SQL, kept by the stable sort). The last key is fixed: the ticket that has waited longest since its last change goes first. The owner wants to pick that order, for example "most recently updated first" so tickets they are actively approving go ahead of the backlog.

Outcome: a `ticketOrder` operating setting with four choices. It replaces only the last sort key. Push, repo priority and step priority still come first.

## Approach

- **Four orders**, stored as a string union:
  - `updated-asc`: "Least recently updated first" (default, today's behaviour);
  - `updated-desc`: "Most recently updated first";
  - `created-asc`: "Oldest first";
  - `created-desc`: "Newest first".
- **Put the choice in SQL.** `buildQueue` already loads rows `ORDER BY t.updated_at` and relies on `Array.sort` being stable. Pick the `ORDER BY` clause from a fixed map keyed by the setting, so no user input reaches the SQL. ISO strings from GitHub sort correctly as text.
- **Store the creation time.** Tickets have no creation time yet. Add `tickets.created_at TEXT` (GitHub's ISO string, like `updated_at`) and fill it during sync. Existing rows: the migration also runs `UPDATE repos SET synced_at = NULL`, so the next sync re-lists every ticket and backfills it. That is the same thing that happens when the author list changes. Until then, and for any source that doesn't report a creation time, sort by `COALESCE(t.created_at, t.updated_at)`. We don't use the ticket number instead because numbers can't be compared across repos.
- **Session and API.** The setting rides on the existing `GET/PUT /api/settings`, so API consumers get it for free. Saving already publishes `settings`, and the dashboard's overview refetches on that topic, so the queue redraws with the new order.

## Changes

### `server/src/api-types.ts`
- `export type TicketOrder = 'updated-asc' | 'updated-desc' | 'created-asc' | 'created-desc';`
- `Settings`: add `ticketOrder: TicketOrder;` with the doc comment `Order of tickets within the same push, repo priority and step.`

### `server/src/settings.ts`
- `DEFAULT_SETTINGS.ticketOrder = 'updated-asc'`. Stored settings without the key pick this up through the existing spread.

### `server/src/db.ts`
- Append a new migration at the end of `MIGRATIONS`:
  ```sql
  ALTER TABLE tickets ADD COLUMN created_at TEXT;
  UPDATE repos SET synced_at = NULL;
  ```

### `server/src/providers/types.ts`, `server/src/providers/github/index.ts`
- `RemoteTicket`: add `createdAt?: string` (optional, so the test fakes and other sources still type-check).
- GitHub `listChanged`: map `createdAt: i.created_at`.

### `server/src/tickets.ts`
- `TicketRow`: add `created_at: string | null`.

### `server/src/scheduler/sync.ts`
- `syncRepo` upsert: insert `created_at` (`t.createdAt ?? null`). In the conflict clause, use `created_at = COALESCE(excluded.created_at, tickets.created_at)` so a source that omits it doesn't wipe a stored value.

### `server/src/scheduler/loop.ts`
- A module constant:
  ```ts
  const ORDER_SQL: Record<TicketOrder, string> = {
    'updated-asc': 't.updated_at',
    'updated-desc': 't.updated_at DESC',
    'created-asc': 'COALESCE(t.created_at, t.updated_at)',
    'created-desc': 'COALESCE(t.created_at, t.updated_at) DESC',
  };
  ```
- `buildQueue`: `all<TicketRow>(\`${openTicketsSql} ORDER BY ${ORDER_SQL[s.ticketOrder] ?? ORDER_SQL['updated-asc']}, t.id\`)`. The `t.id` tie-break keeps the order stable. Update the comment above the final sort to say that the setting decides the order within ties.

### `server/src/http/api.ts`
- `PUT /settings`: export `TICKET_ORDERS` (the four values) from `settings.ts` and validate with `check(TICKET_ORDERS.includes(b.ticketOrder), 'Unknown ticket order.')`, then set `patch.ticketOrder`. This follows how `mode` is validated.

### `server/src/http/openapi.ts`
- Add the schema `TicketOrder: enumOf('updated-asc', 'updated-desc', 'created-asc', 'created-desc')`, and `ticketOrder: ref('TicketOrder')` in `Settings`.

### `client/src/pages/Settings.tsx`
- In the "Tickets" panel, before the polling field, add a `<label className="field">` with the text `Work on tickets in this order`, a `<select>` bound to `draft.ticketOrder` (`set({ ticketOrder: e.target.value as TicketOrder })`) with the four labels above, and the help text: `Pushed tickets, higher-priority repositories and work already in progress still go first. This decides the order among the rest.`
- Keep the labels in a small `const ORDERS: { value: TicketOrder; label: string }[]` in this file. Nothing else displays them.

### Docs
- `docs/design/workflow.md`: near the push and priority notes, one sentence on the queue order (push, repo priority, step, then the ticket order setting).
- `docs/api.md`: one line saying `ticketOrder` can be set through `PUT /api/settings`, with the four values.

## Data and interfaces

- DB: `tickets.created_at TEXT` (nullable). The migration resets `repos.synced_at` so the next sync does a full re-list.
- `Settings.ticketOrder: TicketOrder`, default `updated-asc`. `PUT /api/settings` accepts it. Any other value gives 400 `Unknown ticket order.`
- `RemoteTicket.createdAt?: string`.
- OpenAPI: a new `TicketOrder` enum, and `Settings.ticketOrder`.

## Tests

Run `npm run typecheck` and `npm test`.

**`server/test/pipeline.test.ts`** (uses `buildQueue`. Insert several tickets in `me/app` at the same stage with distinct `updated_at` and `created_at`, and set the order with `saveSettings`)
- Default: least recently updated first (today's order).
- `updated-desc`: most recently updated first.
- `created-asc` and `created-desc`: order by `created_at`. A row with null `created_at` falls back to `updated_at`.
- The setting never beats the earlier keys: a pushed ticket still sorts first, and a ticket at a later step (for example `stage:implement` against an unclassified one) still sorts by step priority under `updated-desc`.
- Sync stores `createdAt` from the fake source, and a later sync without `createdAt` keeps the stored value.

**`server/test/api.test.ts`**
- `PUT /api/settings` with `ticketOrder: 'created-desc'` saves it and `GET` returns it. `ticketOrder: 'random'` gives 400 `Unknown ticket order.`
- The existing OpenAPI field-match test should pass with `ticketOrder` added to the `Settings` schema.

**Browser** (the ticket has `workshop/needs:browser`): open Settings, choose "Most recently updated first", save, reload and check that it stuck. Check the field at phone width in both themes.

## Risks and open questions

- **Workshop's own edits bump `updated_at`.** Every label change and comment Workshop makes updates GitHub's time. Under `updated-desc`, a ticket that has just finished a stage tends to come back first. That suits "prefer what I'm actively working on", but it isn't purely the owner's activity. The setting's help text doesn't promise more than "updated".
- The migration's full re-sync costs one listing per repo (paged, 100 per page) on the first tick after upgrade. This is acceptable, and it's the same as an author change.
