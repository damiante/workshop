# Overview builds every ticket view and the whole queue on each refresh (#145)

## Context

`GET /api/overview` (`server/src/http/api.ts`) took ~3.6 s and returned 885 KB with ~2,600 open tickets. The sidebar (`client/src/components/Layout.tsx`) fetches it on every page and refetches on `runs` events, about once a second while agents run. It uses only `mode`, `withinHours`, `allowance` and `alerts.length`. The cost comes from three things:

- `listTicketViews()` builds a `TicketView` for every open ticket. Each one runs its own `activeRunId` query, plus `attentionKey`, `mediaCount` and so on. The endpoint then keeps only the few with `attention`.
- `queueView()` returns the whole queue, which is most of the payload. The Dashboard renders `queue.slice(0, 8)`, and there's no "show all" (only an "All tickets" link).
- The sidebar pulls all of this for four fields.

When this is done, the overview builds views only for tickets that need you and returns only the front of the queue plus a total. The sidebar reads a small new `GET /api/status` and doesn't subscribe to `runs`.

## Approach

1. **Attention from rows first.** Fetch all active run ids in one query, and work out attention for each open-ticket row from `parseLabels(labelsOf(t))`, `t.pr_status` and that map, using the existing `attentionOf`. Build full `TicketView`s only for the rows that match. `listTicketViews` and `buildQueue` use the same map instead of running `activeRunId` once per ticket.
2. **`GET /api/status`** returns `{ mode, withinHours, allowance, openAlerts }`, where `openAlerts` is a `COUNT(*)`. `Layout` subscribes it to `settings`, `allowance`, `alerts` and `connections`. Mode saves publish `settings`, and an operating-hours boundary already publishes `settings` through `clockTopics`, so `ModeSwitch`'s pending/unlock logic still works. A small endpoint is better than reusing `/settings` plus `/usage`: that would take two requests and still not give the alert count. An API consumer such as home automation can use it too.
3. **Cap the overview queue** at `OVERVIEW_QUEUE_LIMIT = 8`, the number the Dashboard renders, and add `queueTotal`. `buildQueue` still orders every candidate, because the order needs all of them. Only the response shrinks.

## Changes

**`server/src/tickets.ts`**
- Add `activeRunIds(): Map<number, string>`: `SELECT ticket_id, id FROM runs WHERE status IN ('starting', 'running', 'publishing', 'paused')`. Keep the same status list as `activeRunId`, written inline as it is there; tickets.ts doesn't import runs.ts.
- `ticketView(t, repo, graph = priorityGraph(), activeRun: string | null = activeRunId(t.id))`: take a new optional 4th parameter and use it in place of the internal `activeRunId(t.id)` call. Existing callers don't change.
- Pull the row query out of `listTicketViews` into a private `openTicketRows(includeClosed)`, keeping the same SQL and order. `listTicketViews` builds `activeRunIds()` once and passes `active.get(t.id) ?? null`.
- Add `needsYouViews(): TicketView[]`. Using `openTicketRows(false)` and `activeRunIds()`, keep the rows where `attentionOf({ ...parseLabels(labelsOf(t)), skipped: state.skip, prStatus: t.pr_status, activeRunId })` is non-null. Then build views for those rows only, with a single `priorityGraph()` that is created only when at least one row matches. The order stays `updated_at DESC`, as before.

**`server/src/scheduler/loop.ts`**
- In `buildQueue`, build `const active = activeRunIds()` once and replace `activeRunId(t.id)` in the loop with `active.has(t.id)`. Drop the import if nothing else uses it.

**`server/src/http/api.ts`**
- `/overview`: use `needsYouViews()` in place of `listTicketViews().filter(...)`. Then `const queue = queueView()` and return `queue: queue.slice(0, OVERVIEW_QUEUE_LIMIT), queueTotal: queue.length`. Declare `const OVERVIEW_QUEUE_LIMIT = 8;` next to `EFFORTS`, with a comment saying it matches what the Dashboard shows.
- New `apiRouter.get('/status', ...)` that returns a `StatusSummary`: `mode`, `withinHours: withinHours(s, new Date())`, `allowance: allowanceViews()`, and `openAlerts: one<{ n: number }>('SELECT COUNT(*) AS n FROM alerts WHERE ack_at IS NULL')!.n`.

**`server/src/api-types.ts`**
- `Overview`: add `/** Every queued ticket; \`queue\` holds only the first few. */ queueTotal: number;`.
- Add `export interface StatusSummary { mode: Mode; withinHours: boolean; allowance: AllowanceView[]; /** Unacknowledged alerts. */ openAlerts: number; }`.

**`server/src/http/openapi.ts`**
- `Overview` schema: add `queueTotal: int`.
- Add a `StatusSummary` schema and the path `'/status': { get: { summary: 'Mode, operating hours, Claude allowance and the number of open alerts: what the top bar and sidebar show.', ok: ref('StatusSummary') } }`, placed next to `/overview`. Change the `/overview` summary to say "the front of the queue".

**`docs/api.md`**
- Under Examples, add `# Read status: mode, within operating hours, allowance and open alert count` with a `curl $WORKSHOP/api/status` call.
- Add one sentence: `/api/overview`'s `queue` holds the first 8 tickets in queue order, and `queueTotal` counts all of them.

**`client/src/components/Layout.tsx`**
- `useApi<StatusSummary>('/status', ['settings', 'allowance', 'alerts', 'connections'])`, with `openAlerts = data?.openAlerts ?? 0`. Update the `ModeSwitch` comment ("refreshed status"). Nothing else changes. The badge used to stop at 20 because of the overview's alert limit; it now shows the real count.

**`client/src/pages/Dashboard.tsx`**
- Render `data.queue` directly instead of `.slice(0, 8)`. When `data.queueTotal > data.queue.length`, add `<p className="small muted" style={{ padding: '8px 16px' }}>And {n} more in the queue.</p>` under the list, using the same padding as the "Show dismissed" button. `waiting` (`data.queue.find(...)`) now looks only at the first 8. That's fine, because the copy says "Next up".

## Data and interfaces

- No schema migration.
- New `GET /api/status` → `StatusSummary`. It works with read tokens, like `/overview`.
- `Overview.queue` is capped at 8 items, and the new field is `Overview.queueTotal`. Scripts that read the whole queue from `/api/overview` now get only its front. This is documented in `docs/api.md`.

## Tests

`server/test/api.test.ts`:
- **Needs-you parity.** Add a test in `describe('dismissing Needs you items')` or beside it. Using the existing fixture ticket (number 4) or a few inserted rows in repo 1, set each state and check `needsYou`/`dismissed` and `attention`:
  - `needs-info` → question;
  - `failed` → failed;
  - `stage:pr-review` → review;
  - `stage:pr-review` with an active run (insert a `runs` row with status `running`) → absent;
  - `stage:pr-review` with `pr_status = 'changes_requested'` → absent;
  - `needs-info` + `skip` → absent;
  - a dismissed question → in `dismissed`, not in `needsYou`.

  Also assert that the items are deep-equal to `GET /api/tickets/:id`'s view, so `needsYouViews` builds the same views `listTicketViews` does.
- **Queue cap.** Insert more than 8 ready open tickets (e.g. 10 with `workshop/stage:design` labels in repo 1). Assert `queue.length === 8`, `queueTotal >= 10`, and that `queue` equals the first 8 in order. Remove them afterwards so the other tests stay unaffected; follow how nearby tests clean up.
- **Status.** Add `['/status', 'StatusSummary']` to the `matches its schema fields` `it.each`. Add a test that `openAlerts` counts unacknowledged alerts (insert two, acknowledge one) and that `mode` follows `PUT /api/settings`. The `documents every route` test enforces the openapi entry.
- `Overview`'s fields-match test picks up `queueTotal` once it's in the schema.

Run:

```sh
npm run typecheck
npm test
```

## Risks and open questions

- Any outside script that reads the full queue from `/api/overview` loses everything past the 8th item. No client page needs more than that. If a full queue is needed later, a `GET /api/queue` can be added.
- `needsYouViews` must use the same filter as `TicketView.attention` (open tickets, enabled repos, the same `attentionOf` inputs). The parity test covers this.
- `alertRunId` still runs one query per alert, but only for the 20 alerts in the overview, so it isn't worth changing here.
