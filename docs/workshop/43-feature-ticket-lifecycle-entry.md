# Ticket lifecycle page (#43)

## Context

Cards on the dashboard and the Tickets board link to GitHub, to runs or to the media page, but nowhere shows a ticket as Workshop has handled it. The owner wants one page per ticket listing every time it was handed to an agent (classified, designed, adversaried, implemented, re-classified after review, …), with a link to each run and the screenshots each run took shown where they were taken. The page must be reachable from the dashboard and from the Tickets board.

## Approach

- **One new endpoint, one new page.** `GET /api/tickets/:id` returns the ticket's `TicketView`, all its runs oldest first, and its media items, so the page is a single `useApi` call that stays live on the `tickets`, `runs` and `media` topics. Composing it in the client from `/tickets` would not work: `/tickets` leaves out closed tickets and tickets in disabled repos, and `/runs?ticket=` is newest first and capped at 200.
- **Route `/tickets/:id`** (the ticket's own page; the existing `/tickets/:id/media` stays as the full-size gallery). Heading `<repo>#<n>`, panel titled "Lifecycle".
- **The lifecycle is the run list.** Runs carry `agent`, `mode`, `attempt`, `status`, times and `summary` (for the Classifier, `summarize()` already turns the decision into words such as "Sized M: …" or "Declined: …"). The stage name comes from `AGENT_LABEL[run.agent]`; `mode === 'delta'` adds "requested changes", the label used when the owner asks for changes on the PR. No new columns or migrations.
- **Screenshots in place**: each run entry shows the media items whose `runId` is that run as small thumbnails. Images from the issue and comments, and agent images whose run has since been deleted by retention, sit in one "From the issue and earlier runs" group above the runs.
- **Links in**: the `repo#n` reference on Tickets cards, on the dashboard's Running, Needs you and Up next items, in the Runs table and on the run page header becomes a `Link` to `/tickets/:id`. Existing GitHub links (titles) stay as they are.

## Changes

### Server

**`server/src/runs.ts`**
- `ticketRunViews(ticketId: number): RunView[]`: `${VIEW_SQL} WHERE runs.ticket_id = ? ORDER BY runs.started_at ASC, runs.rowid ASC`, no limit, mapped with `toView`.

**`server/src/http/api.ts`**
- Rename `mediaTicket` to `ticketParam` (same body, now used by three routes) and update the two media routes.
- New route, placed before the `/tickets/:id/…` routes for readability:
  ```ts
  apiRouter.get('/tickets/:id', (req, res) => {
    const t = ticketParam(req.params.id);
    const body: TicketLifecycle = { ticket: ticketView(t, getRepo(t.repo_id)!), runs: ticketRunViews(t.id), media: listMedia(t.id).map(mediaView) };
    res.json(body);
  });
  ```
  400 `Ticket ids are whole numbers.` / 404 `Ticket not found.` come from `ticketParam`. Works for closed tickets and disabled repos.

**`server/src/http/openapi.ts`**
- Path `'/tickets/{id}'`: `get`, summary "A ticket with every agent run on it, oldest first, and its media: the ticket's lifecycle in Workshop.", `params: ['id']`, `ok: ref('TicketLifecycle')`, `errors: [400, 404]`.
- Schema `TicketLifecycle: object({ ticket: ref('TicketView'), runs: array(ref('RunView')), media: array(ref('MediaItem')) })`.

**`docs/api.md`**: one paragraph (under "Media" or a new "Tickets" heading): `GET /api/tickets/{id}` returns the ticket, its runs oldest first and its media; finished runs are removed after the retention period in Settings, and media when the ticket finishes.

### Client

**`client/src/pages/Ticket.tsx`** (new), route `<Route path="tickets/:id" element={<Ticket />} />` in `main.tsx` (next to `tickets/:id/media`).
- `useApi<TicketLifecycle>(`/tickets/${id}`, ['tickets', 'runs', 'media'])`, `useNow()` for running durations. `ErrorNote` on error, `null` while loading.
- Header (`stack`): `<h1>{t.repo}#{t.number}</h1>`; title as an external link to `t.url`; a `row small` with the stage tag (`STAGE_TEXT`, below), size tag, "Closed" when `state === 'closed'`, the PR link (as on the card), and `Screenshots (n)` linking to `/tickets/:id/media` when `media.length > 0`. Reuse `TicketStatus` (export it from `Tickets.tsx`).
- `Panel title="Lifecycle"` containing `<ol className="list lifecycle">`:
  - First, when there are unmatched media items (runId null or not among `runs`), an item "From the issue and earlier runs" with their thumbnails.
  - One `<li>` per run, oldest first:
    - `spread`: `<Link to={/runs/:id}>{stageText(run)}</Link>` where `stageText = AGENT_LABEL[agent] + (mode === 'delta' ? ', requested changes' : '') + (attempt > 1 ? `, attempt ${attempt}` : '')`, and `<Status tone>` from `RUN_STATUS`.
    - `row small muted`: `clock(startedAt)`, `for {duration(startedAt, endedAt ?? now)}`, `model`, `environment` (as in the dashboard's `RunLine`).
    - `run.activity` (mono, muted) while active; `run.summary` (plain text, `overflow-wrap: anywhere`); `run.error` in `--error-text` when set.
    - Thumbnails: the run's media items in `<div className="media-grid thumbs">`, each `<figure>` with `<a href={m.url} target="_blank" rel="noreferrer"><img loading="lazy" alt={m.caption ?? m.name} /></a>` and a `figcaption` with the caption or name. Plus a small `Link` "Open this run's screenshots" to `/tickets/:id/media?run=<runId>`.
  - Empty state: "No agent has worked on this ticket yet. It starts when Workshop's mode and the queue allow it, or push it from the Tickets page."
- Under the list, `small muted`: "Finished runs are removed after the retention period in Settings, and screenshots when the ticket finishes."

**`client/src/pages/Tickets.tsx`** `Card`: the top `repo#n` span becomes `<Link to={`/tickets/${t.id}`}>{t.repo}#{t.number}</Link>`. Export `TicketStatus`.

**`client/src/pages/Dashboard.tsx`**
- `RunLine`: split the link: `<span><Link to={/runs/:id}>{AGENT_LABEL[run.agent]}</Link> on <Link to={/tickets/:ticketId}>{run.ticket}</Link></span>`.
- `NeedsYou`: the `repo#n` anchor (GitHub) becomes a `Link` to `/tickets/:id`; the title becomes the GitHub link (`<a href={ticket.url}>`), so GitHub stays one click away.
- Up next: `{q.ticket}` becomes `<Link to={/tickets/:ticketId}>{q.ticket}</Link>`.

**`client/src/pages/Runs.tsx`**: the Ticket cell's `{r.ticket}` becomes a `Link` to `/tickets/:ticketId`.

**`client/src/pages/RunView.tsx`**: a `Link className="button"` "Ticket lifecycle" to `/tickets/:ticketId` in the header button row, before "View screenshots".

**`client/src/pages/Media.tsx`**: the heading's `data.ticket` becomes a `Link` to `/tickets/:ticketId`, so the gallery leads back.

**`client/src/format.ts`**: `STAGE_TEXT: Record<Stage, string>` with the texts `STAGE_OPTIONS` uses today (Design, Design review, Implementation, Your review, Merge, Re-classify changes); a null stage shows "To classify". `Tickets.tsx` builds `STAGE_OPTIONS` from it.

**`client/src/theme.css`**: `.media-grid.thumbs { padding: 0; gap: 8px; }` and `.media-grid.thumbs figure { max-width: 160px; }`. No new colour tokens.

**`client/AGENTS.md`**: add "Ticket (a ticket's lifecycle, `tickets/:id`)" to the pages list.

## Data and interfaces

`server/src/api-types.ts`:

```ts
export interface TicketLifecycle {
  ticket: TicketView;
  /** Every run on the ticket still kept, oldest first. */
  runs: RunView[];
  media: MediaItem[];
}
```

New route `GET /api/tickets/:id` (session or API token, on `apiRouter`). No schema migration, no new settings.

## Tests

`server/test/api.test.ts`, new `describe('ticket lifecycle')` seeding a repo, a closed ticket in it, three runs (`classifier` normal, `implement` normal, `classifier` delta) with out-of-order `started_at`, and one media row for the implement run:
- needs sign-in (401);
- returns `ticket` (id, `state: 'closed'`, `mediaCount: 1`), `runs` oldest first with `agent`/`mode`/`summary`, and `media` with the run's `runId`;
- 400 for `abc`, 404 for an unknown id;
- the response's top-level keys equal `TicketLifecycle`'s schema properties in `OPENAPI` (as the existing `it.each` does for other views). The existing "documents every route" test covers the OpenAPI path.

Client: no reducer change, so no new Vitest test; `npm run typecheck` covers the page. Implementation must check it in the browser: seed or use a dev database with a ticket that has several runs and screenshots, open `/tickets/:id`, the dashboard and the Tickets board at desktop and 390 px widths in both themes, confirm the links and that nothing scrolls sideways, and save screenshots to `/work/media/`.

Run: `npm run typecheck && npm test`.

## Risks and open questions

- **Only runs are history.** Label changes the owner makes by hand (or on GitHub) are not recorded, so the page shows agent hand-offs, not every stage change. That matches the ticket's ask; a label-event log would be a separate change.
- **Retention**: finished runs are deleted after `retentionDays` and media when the ticket finishes, so an old or finished ticket's page can be short or empty of screenshots. The footer note says so.
- Route `/tickets/:id` sits beside `/tickets/:id/media`; no conflict in React Router or Express, since Express matches the exact path segments.
