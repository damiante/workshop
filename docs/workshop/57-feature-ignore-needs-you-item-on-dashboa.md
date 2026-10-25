# Dismiss a "Needs you" item (#57)

## Context

The dashboard's **Needs you** panel lists every open ticket waiting on you: a question (`workshop/needs-info`), a stop after failures (`workshop/failed`), or a pull request to review (`stage:pr-review`, no active run, not `changes_requested`). Some of these are low priority, and you want to clear them from the panel without acting on them. The filter is in `GET /api/overview` (`server/src/http/api.ts`), and `NeedsYou` in `client/src/pages/Dashboard.tsx` renders it.

Outcome: each item gets a **Dismiss** button. A dismissed item leaves the list and stays hidden until **the reason it needs you changes**: a new question, a new failure stop, or a new pull request or revision to review. You can bring back dismissed items from the panel. Dismissing changes nothing on GitHub and doesn't affect the scheduler. The ticket stays held as before. The Tickets page is unaffected.

## Approach

- **Remember what was dismissed, not just that something was.** Store an *attention key* on the ticket: `<reason>:<latest run id>`, where the reason is `question`, `failed` or `review`, and the latest run is the ticket's most recent run (`ORDER BY started_at DESC LIMIT 1`, `''` if there are none). An item counts as dismissed only while its stored key equals its current key.
  - Each reason is produced by a run: an agent asks a question, `fail()` stops the ticket after a run, and the implement or merge run opens or updates the PR. After you answer, retry or request changes, Workshop starts a new run, so when the ticket needs you again its key has changed and it shows up again. The same applies when a different reason appears, such as a question while in review.
  - The key is computed when it's read. No write path (sync, `publishRun`, `fail`, `editLabels`, merge) needs to clear anything, so stale state can't be left behind. The alternative was clearing the flag whenever a ticket leaves Needs you, which would need a hook in every place that changes labels or PR status, and it would miss a label removed and added back between two checks.
- **One helper decides why a ticket needs you**, so the overview filter and the dismissal check can't drift apart.
- **API:** `PUT /api/tickets/:id/dismissed` with `{ "dismissed": true | false }`, modelled on `PUT /tickets/:id/nominated`. It goes on `apiRouter` and into `openapi.ts` and `docs/api.md`, because a script might reasonably clear its own queue.
- **Overview** splits the list: `needsYou` keeps only items that aren't dismissed, and a new `dismissed` array holds the rest. The panel can then offer "Show N dismissed" and **Bring back**.

## Changes

### `server/src/db.ts`
- Append a migration: `ALTER TABLE tickets ADD COLUMN dismissed TEXT;` with the comment `-- the attention key you dismissed from Needs you; hidden while it still matches`.

### `server/src/tickets.ts`
- `TicketRow`: add `dismissed: string | null`.
- `export function attentionOf(v: Pick<TicketView, 'needsInfo' | 'failed' | 'stage' | 'activeRunId' | 'prStatus'>): 'question' | 'failed' | 'review' | null`: return `needsInfo` → `'question'`, otherwise `failed` → `'failed'`, otherwise `stage === 'pr-review' && !activeRunId && prStatus !== 'changes_requested'` → `'review'`, otherwise null. These are the same conditions as today's filter, in the same order the client uses to label items.
- `function attentionKey(t: TicketRow, reason): string | null`: return null when `reason` is null, otherwise `` `${reason}:${latestRunId ?? ''}` ``, with `latestRunId = one<{ id: string }>('SELECT id FROM runs WHERE ticket_id = ? ORDER BY started_at DESC LIMIT 1', t.id)?.id`. Query only when there is a reason.
- `ticketView`: build the view as now, then set `attention = attentionOf(view)` and `dismissed = attention !== null && t.dismissed === attentionKey(t, attention)`. Add both fields to the returned object.
- `export function setDismissed(t: TicketRow, on: boolean)`: `const key = on ? attentionKey(t, attentionOf(ticketView(t, getRepo(t.repo_id)!))) : null`; `run('UPDATE tickets SET dismissed = ? WHERE id = ?', key, t.id)`; `t.dismissed = key`; `publish('tickets')`.

### `server/src/api-types.ts`
- `TicketView`: add `attention: 'question' | 'failed' | 'review' | null` (doc: `Why the ticket is waiting on you, or null when it isn't.`) and `dismissed: boolean` (doc: `You dismissed it from Needs you; it comes back when the reason changes.`).
- `Overview`: add `dismissed: TicketView[]` (doc: `Needs-you items you dismissed.`).

### `server/src/http/api.ts`
- `/overview`: `const waiting = tickets.filter((t) => t.attention)`, then `needsYou: waiting.filter((t) => !t.dismissed)` and `dismissed: waiting.filter((t) => t.dismissed)`.
- New route after `/tickets/:id/nominated`:
  ```ts
  apiRouter.put('/tickets/:id/dismissed', (req, res) => {
    const { t, repo } = pushableTicket(req.params.id);
    const dismissed = req.body?.dismissed;
    check(typeof dismissed === 'boolean', 'Say whether to dismiss the ticket.');
    check(!dismissed || ticketView(t, repo).attention, "This ticket isn't waiting on you, so there's nothing to dismiss.", 409);
    setDismissed(t, dismissed);
    res.json(ticketView(t, repo));
  });
  ```

### `server/src/http/openapi.ts`
- `TicketView` schema: add `attention: nullable(enumOf('question', 'failed', 'review'))` and `dismissed: bool`.
- `Overview` schema: add `dismissed: array(ref('TicketView'))`.
- Path `/tickets/{id}/dismissed` → `put`: summary `Dismisses a ticket from Needs you on the dashboard, or brings it back. Send { "dismissed": true | false }. It comes back by itself when the reason changes: a new question, failure or pull request to review. Changes nothing on GitHub.`, `params: ['id']`, `body: object({ dismissed: bool })`, `ok: ref('TicketView')`, `errors: [400, 403, 404, 409]`.

### `client/src/pages/Dashboard.tsx`
- `NeedsYou` takes `ticket` plus an optional `dismissed?: boolean`. Switch the label and text on `ticket.attention` instead of re-deriving it from the flags (keep the current copy).
- Add a button to the header `spread` row, next to the `Status`, inside a `<span className="row">`: `<button className="link small" disabled={busy} onClick={…}>{dismissed ? 'Bring back' : 'Dismiss'}</button>`. It calls `api(`/tickets/${ticket.id}/dismissed`, { method: 'PUT', body: { dismissed: !dismissed } })` with local `busy` and `error` state, as `Tickets.tsx` does. Show errors under the row as `<span className="small error-text">`. Add `aria-label={`Dismiss ${ticket.repo}#${ticket.number}`}` (or `Bring back …`). The list refetches through the `tickets` topic, so don't update anything optimistically.
- Panel body: when `needsYou` is empty but `dismissed` isn't, show the empty text `Nothing is waiting on you.` as now. Below the list or empty text, when `data.dismissed.length`, add `<button className="link small">` that toggles a local `showDismissed` state: `Show ${n} dismissed` or `Hide dismissed`. When it's open, render a second `ul.list` with `<NeedsYou ticket={t} dismissed />` for each dismissed ticket.
- Add a short title attribute to the Dismiss button: `Hide this until the ticket needs you for something new`.
- The button and the status must wrap at phone width. `.spread` already wraps; check this in the browser.

### Docs
- `README.md`, the line about **Needs you**: append `Dismiss hides an item you don't want to deal with yet; it comes back when the ticket needs you for something new.`
- `docs/api.md`: in the section with `PUT /api/tickets/:id/nominated`, add a paragraph on `PUT /api/tickets/:id/dismissed`. Cover the body, what brings an item back, the 409, and the `dismissed` list in `/api/overview`.

## Data and interfaces

- DB: `tickets.dismissed TEXT NULL`, set by a new migration at the end of `MIGRATIONS`.
- `TicketView.attention`, `TicketView.dismissed`, `Overview.dismissed` (new fields).
- `PUT /api/tickets/:id/dismissed` `{ dismissed: boolean }` → `TicketView`. Errors: 400 for a non-boolean body (`Say whether to dismiss the ticket.`), 404 for an unknown or out-of-scope ticket (via `pushableTicket`), 409 when dismissing a ticket that isn't waiting on you. A write-scoped token works. Bringing back a ticket that isn't dismissed succeeds and does nothing.

## Tests

Run `npm run typecheck` and `npm test`.

**`server/test/api.test.ts`** (seed tickets the way the existing nominated and state tests do; set labels and insert `runs` rows directly)
- The `'/overview' matches its schema fields` case covers the new `dismissed` key once `openapi.ts` has it. "Documents every route" covers the new path.
- Dismissing a `needs-info` ticket moves it from `needsYou` to `dismissed` in `/api/overview`, with `dismissed: true` and `attention: 'question'` in the response. `{ dismissed: false }` moves it back.
- Validation: `{ dismissed: 'yes' }` gives 400, a ticket without a reason gives 409, and an unknown id gives 404.
- It comes back when the reason changes:
  - insert a newer run for the ticket, and the ticket is back in `needsYou`;
  - with no new run, swap `needs-info` for `failed`, and it's back too (different reason);
  - a `pr-review` ticket dismissed, then a newer run inserted, is back.
- It stays dismissed after an unrelated change, such as a label edit that keeps the same reason with no new run.
- A ticket that leaves Needs you (label removed) is in neither list.

**`server/test/workflow.test.ts`** or beside the API tests: `attentionOf` covers each reason, the precedence (needs-info over failed over review), an active run, and `changes_requested` → null.

**Browser:** build and run the app with a seeded ticket in each state. Screenshot the dashboard at 390px and 1280px wide, in both themes, with items listed and with the dismissed list open. Save the screenshots to `/work/media/`.

## Risks and open questions

- **Run retention:** if a ticket sits untouched longer than the retention period, cleanup deletes its latest run, the key changes and the item comes back. That's an acceptable reminder for something left for weeks. Document it in the `docs/api.md` paragraph.
- Adding or removing `needs-info` or `failed` by hand with no new run keeps the same key for the same reason. Removing `failed` and adding it back by hand doesn't resurface the item. That's acceptable, because you made the change yourself.
- `ticketView` gains one small query per ticket that needs you. That's negligible next to the existing `activeRunId` and `mediaCount` queries.
