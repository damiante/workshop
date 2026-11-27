# Visualise dependencies (#120)

## Context

Tickets can wait on other tickets (GitHub "blocked by" links, see #4), but the only place that shows it is the dashboard queue's "Waiting: #2" line. You want a per-repo picture of the dependency tree, including finished tickets, so you can see progress through it.

Today Workshop can't draw that. `tickets.blocked_by` keeps only *open* blockers, as display refs. When a blocker closes, sync drops it from the list, and nothing remembers the edge. Tickets whose blockers were all closed before Workshop looked are never read at all, because sync only reads links for tickets whose list entry reports open blockers.

Outcome: Workshop stores every "blocked by" edge it sees, open and closed. A new Dependencies page draws one graph per enabled repo, with closed tickets included, and updates live.

## Approach

- **Store every edge in a new table.** `ticket_links` has one row per (ticket, blocker), with the blocker's repo, number, title, URL and last known state. `tickets.blocked_by` stays as it is: the scheduler's hold logic and its tests don't change. The table is written wherever `source.blockers()` is already called, so most edges cost no extra requests.
- **Find edges that sync doesn't read today.** GitHub's `issue_dependencies_summary` also has `total_blocked_by` (open and closed). `listChanged` copies it into `RemoteTicket.totalBlockers`. `syncBlockers` also reads the links of:
  - listed tickets whose `totalBlockers` differs from their stored edge count (a link was added or removed);
  - tickets never read (`tickets.links_checked_at IS NULL`), up to `LINK_BACKFILL_PER_SYNC = 20` per repo per sync, open first, then newest. This backfills tickets that already exist, closed ones included. Edges that closed before this ships come back this way, because GitHub keeps closed links.
- **Draw the graph on the client with a small pure layout** in the style of `Chart.tsx`: hand-drawn SVG, no package. Blockers sit on the left and the tickets they block on the right. Columns use longest-path layering, and each column is ordered by its blockers' average position. Each connected group of tickets gets its own band, stacked vertically. A tree with several parents can't be drawn as an indented list without duplicating nodes, so it's an SVG.
- **One endpoint for every repo.** `GET /api/dependencies` returns a graph per enabled repo. The page picks the repo from that response, so it needs no second call, and API consumers get the same data. It goes on `apiRouter`, in `openapi.ts` and in `docs/api.md`.

## Changes

### Server

- `server/src/db.ts`: append one migration:
  ```sql
  CREATE TABLE ticket_links (
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    blocker_repo TEXT NOT NULL,      -- full name, e.g. me/app
    blocker_number INTEGER NOT NULL,
    blocker_title TEXT,
    blocker_url TEXT NOT NULL,
    blocker_state TEXT NOT NULL,     -- open or closed, as GitHub last said
    PRIMARY KEY (ticket_id, blocker_repo, blocker_number)
  );
  ALTER TABLE tickets ADD COLUMN links_checked_at INTEGER; -- epoch ms of the last full read of its blockers; null = never
  ```
- `server/src/providers/types.ts`:
  - `RemoteTicket.totalBlockers?: number`, documented as "open and closed; undefined means the source didn't say";
  - `TicketLink.title?: string`.
- `server/src/providers/github/index.ts`:
  - `listChanged` reads `issue_dependencies_summary.total_blocked_by` into `totalBlockers`. Leave it undefined when the field is missing, unlike `openBlockers`, so a missing field doesn't look like "zero links";
  - add `title?: string` to `IssueLike`, and have `toLink` copy it.
- `server/src/tickets.ts`:
  - `links_checked_at: number | null` on `TicketRow`;
  - `setLinks(t, links: TicketLink[]): boolean`: in a `BEGIN`/`COMMIT` (as in `spend.ts`), replace the ticket's rows and set `links_checked_at = Date.now()`. Returns whether the rows changed; it doesn't publish, so a backfill of 20 tickets causes one refresh, not 20;
  - `addLinks(t, links)`: upsert without deleting, for the Classifier path. It leaves `links_checked_at` alone (the list isn't known to be complete) and calls `publish('tickets')` if anything changed;
  - `linkCount(ticketId)`;
  - `dependencyGraphs(): DependencyGraph[]`, which builds the API view (below).
- `server/src/scheduler/sync.ts` (`syncBlockers`):
  - after every `source.blockers()` call, in every group, also call `setLinks(t, links)` with the full list, unfiltered. The rest of the loop body (`setBlockers` with the open ones, `blockers_checked_at`) stays the same for all groups, so one loop serves them all;
  - append the two new target groups after the existing ones, de-duplicated by ticket id: listed tickets with a changed count (any state, rows that exist), then the backfill batch;
  - when a read in the changed-count group fails (any error, including the rate limit), set that ticket's `links_checked_at = NULL`. The sync still completes and `since` moves on, so the ticket won't be listed again; clearing the column hands it to the backfill, which retries it on a later sync;
  - backfill order: open before closed, then newest first (`ORDER BY state = 'closed', number DESC`);
  - call `publish('tickets')` once at the end if any `setLinks` call changed rows;
  - the `fresh` group stays first, so the rate-limit return value `i >= fresh.length` keeps its meaning. A failure in a new group only logs, like held re-reads. Update the function's doc comment.
- `server/src/scheduler/runner.ts` (`blockers` step): after `setBlockers`, call `addLinks(t, links)` with every link `addBlocker` returned. The graph then shows the Classifier's links straight away. The step stays idempotent.
- `server/src/http/api.ts`: `apiRouter.get('/dependencies', …)` returns `dependencyGraphs()`.
- `server/src/http/openapi.ts`: add the route and the `DependencyGraph`, `DependencyNode` and `DependencyEdge` schemas.
- `docs/api.md`: one curl example and a short paragraph.

### Client

- `client/src/graph.ts` (pure, tested): `layoutGraph(graph, { hideClosed })`. It returns positioned nodes, edge paths and an overall size, plus `nodeStatus(node)`, which gives `{ tone, text }` for a node. Cycles (GitHub may allow them, and stale data can make them) are broken before layering by dropping back edges found in a depth-first walk in node order; the dropped edges are still drawn, just not used for columns.
- `client/src/pages/Tickets.tsx`: `TicketStatus` and `nodeStatus` must agree. Move `TicketStatus`'s order into a pure `ticketStatus(t): { tone, text } | null` in `client/src/format.ts`, have `TicketStatus` render it, and build `nodeStatus` on it, so the two pages can't drift.
- `client/src/pages/Dependencies.tsx`: route `dependencies`, with the repo chosen by `?repo=<id>`. The default is the first repo that has any edges.
  - Header: `<h1>Dependencies</h1>`, a repo `<select>`, and a checkbox "Hide closed tickets" (off by default).
  - One sentence of progress: "5 of 9 tickets in these trees are closed."
  - The SVG sits in a `.graph-wrap` panel that scrolls sideways itself, like `.table-wrap`, so the page never does.
  - An unknown or disabled `?repo` falls back to the default, so an old link never shows a blank page.
  - Empty state: "No tickets in me/app depend on others. Links you add on GitHub with "Blocked by" show up here after the next sync."
  - Live through `useApi<DependencyGraph[]>('/dependencies', ['tickets', 'runs'])`.
- `client/src/main.tsx`: register the route.
- `client/src/pages/Tickets.tsx`: add a "Dependencies" link next to the `<h1>`. Don't add a sidebar entry: the phone bottom bar is already full.
- `client/src/theme.css`: `.graph-wrap`, plus node, edge and dot styles using existing tokens only.

**Node drawing:** a 240×56 box (`--surface` fill, `--line` stroke, 6px radius).

- Line 1: the ref in Plex Mono, such as `#12`, or `other/repo#5` for another repo.
- Line 2: the title, cut to fit with an ellipsis, with the full title in an SVG `<title>`.
- Line 3: a status dot and words from `nodeStatus`, checked in this order:
  1. closed → "Closed" (`ok`);
  2. not in Workshop → "Not in Workshop" (`idle`);
  3. `ticketStatus(t)`, the Tickets page's order: active run → "Agent working" (`running`), failed → "Stopped after failures" (`error`), needs info → "Waiting for your answer" (`attention`), skipped → "Skipped" (`idle`);
  4. `attention === 'review'` → "Waiting for your review" (`attention`);
  5. any open blocker → the server's `t.next`, which already reads "Depends on #2 and #5" (`attention`). Don't rebuild the wording on the client;
  6. otherwise the stage from `STAGE_TEXT`, or "To classify" (`idle`).

Closed nodes are drawn at reduced opacity, with text still AA against `--surface`. A Workshop node is an SVG `<a>` to `/tickets/:id` (client-side navigation via `useNavigate` on click and Enter). An external node opens its GitHub URL in a new tab (`target="_blank" rel="noopener noreferrer"`). Each node link has an `aria-label` with its ref, title and status (for example "#12 Add login, Agent working"), a visible focus ring, and tab order follows the layout (column, then row). The `<svg>` has `role="group"` and an `aria-label` naming the repo.

**Edges:** a cubic curve from the blocker's right edge to the dependent's left edge, with an arrowhead. Use `--muted` while the blocker is open and `--line` once it's closed.

## Data and interfaces

In `server/src/api-types.ts`:

```ts
export interface DependencyNode {
  /** "#12", or "other/repo#5" for a ticket in another repository. */
  ref: string;
  number: number;
  title: string | null;
  url: string;
  state: 'open' | 'closed';
  /** Null when the ticket isn't in Workshop (another repository, or an author Workshop doesn't work for). */
  ticket: TicketView | null;
}
/** `blocker` must finish before `ticket`; both are node refs. */
export interface DependencyEdge { blocker: string; ticket: string }
export interface DependencyGraph {
  repoId: number;
  repo: string;
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}
```

`dependencyGraphs()` works per enabled repo:

- **Edges:** every `ticket_links` row whose ticket is in that repo.
- **Nodes:** each ticket that appears in any of those edges, as either end. A blocker that is a Workshop ticket row, matched by repo full name (case-insensitive) and number in *any* enabled repo, uses that row (its `state` and a `ticketView`), so a blocker in another enrolled repo links to its Workshop page and shows a live state. Otherwise the node is built from the link's stored fields, with `ticket: null`.
- **Queries:** load the repo's links and the matching ticket rows in one query each, not one per node; `ticketView` already costs a few lookups per ticket.
- **Sorting:** nodes by number, then edges.
- **Repos with no edges:** still listed, with empty arrays, so the picker shows every repo.

## Tests

- `server/test/pipeline.test.ts` (in the sync blockers `describe`):
  - a held ticket whose blocker closes keeps the edge in `ticket_links` with state `closed`, while `blocked_by` becomes `[]`;
  - a listed ticket with `openBlockers: 0, totalBlockers: 1` and no stored links is read, and its edge is stored;
  - a matching count is not read again;
  - a failed read in the changed-count group clears `links_checked_at`, and the next sync's backfill reads it;
  - one sync that changes links publishes `tickets` once;
  - the backfill reads at most `LINK_BACKFILL_PER_SYNC` never-read tickets, closed ones included, and sets `links_checked_at`;
  - a rate limit during backfill still returns complete (`synced_at` advances);
  - the Classifier's `blocked` result writes the link rows.
- `server/test/api.test.ts`: `GET /api/dependencies` returns:
  - nodes for both ends;
  - a `ticket: null` external node with the stored title;
  - the blocker's state from its ticket row, including a blocker in another enabled repo (`ticket` set);
  - empty arrays for a repo without links;
  - 401 without a session.

  The existing OpenAPI coverage test checks the route is documented.
- `client/test/graph.test.ts`:
  - layering: a chain gets columns 0, 1, 2, and a diamond puts its join in column 2;
  - a cycle doesn't loop forever;
  - disconnected groups are stacked without overlapping;
  - `hideClosed` drops closed nodes and their edges;
  - barycenter ordering;
  - `nodeStatus` follows its precedence order, and agrees with `ticketStatus` for open Workshop tickets.
- Run `npm run typecheck` and `npm test`. Then check the page with Playwright at desktop and phone (375px) widths, in both themes, against a seeded database. There's no seed tool: write a throwaway script outside the repo that runs the migrations on a database in a temporary `DATA_DIR` and inserts a repo (enabled), a few tickets (open, closed, running, needs info) and `ticket_links` rows, including a diamond, a cross-repo blocker and a blocker not in Workshop. Sync will fail for the fake repo; that only logs. Save screenshots to `/work/media/`.

## Risks and open questions

- **`total_blocked_by` is assumed** to be in the issue list's `issue_dependencies_summary`, alongside `blocked_by`. If GitHub omits it, `totalBlockers` stays undefined. Edges are still captured by held re-reads, by the Classifier and by the one-time backfill, but a link added later to a ticket that was never held isn't seen.
- **Adding a dependency on GitHub is assumed to bump the issue's `updated_at`**, so `since` lists it. If it doesn't, such links show up only when the ticket next changes.
- **Rate limits:** the backfill adds at most 20 requests per repo per sync. It ends once every ticket has `links_checked_at`. A large existing backlog takes a few hours to fill in, so the page may look incomplete for that time after the upgrade.
- **External blockers' state goes stale:** another repo's ticket, or one by an author Workshop doesn't work for, shows the state from the last read. That read is refreshed whenever the dependent ticket is re-read.
- **Not every past ticket can be shown.** Enrolment lists open issues only, so tickets closed before the repo was enrolled have no row. They still appear as closed blocker nodes when a tracked ticket links to them, but links *between* two such old tickets are never read. Tickets by authors Workshop doesn't work for have no row either, so they appear only as blockers. Reading every closed issue once would fix this but costs one request per issue; leave it out unless asked.
- **`total_blocked_by` isn't documented by GitHub.** Community reports confirm the field exists next to `blocked_by` and counts closed links too, and one reports a zero summary on an issue that had blockers. The design never treats a count as proof of "no links": the backfill reads every ticket once regardless, and the count only adds reads.
- **Removing a link on GitHub** may not bump `updated_at`. The stale edge stays until the ticket is next re-read (any listed change with a count mismatch, a held re-read, or a Classifier run).
- **Large graphs:** there's no virtualisation. A repo with hundreds of linked tickets gives a big SVG inside a scrolling panel, which is acceptable for now.

## Review

Design review against the code on `main` (`server/src/scheduler/sync.ts`, `server/src/tickets.ts`, `server/src/providers/github/index.ts`, `client/src/pages/Tickets.tsx`).

1. **A failed read in the changed-count group is lost for good.** `syncBlockers` returns true for failures after `fresh`, so `synced_at` advances and the ticket isn't listed again. Its stored count stays wrong until something else changes it. *Fix:* clear `links_checked_at` on failure so the backfill retries it. **Adopted.**
2. **`setLinks` publishing per ticket** would send up to 20+ `tickets` refreshes per sync, each refetching every graph and the ticket lists. *Fix:* `setLinks` returns whether it changed anything, and `syncBlockers` publishes once. `addLinks` (Classifier path, one ticket) publishes itself. **Adopted.**
3. **`nodeStatus` copied the Tickets page's status order and missed parts of it.** "Skipped" and "Waiting for your review" were missing, and "Waiting for #2, #5" rebuilt wording that `ticketView` already produces as `next` ("Depends on …"). *Fix:* pull `TicketStatus`'s order into a pure `ticketStatus` in `format.ts`, used by both pages, and use `t.next` for the blocked line. **Adopted.**
4. **Blockers in another enrolled repo showed as "Not in Workshop"** with stale state, because only same-repo rows were matched. *Fix:* match blocker rows by full name and number across every enabled repo. **Adopted.**
5. **The backfill order wasn't specified in SQL, and neither was which groups run `setBlockers`.** *Fix:* every group uses the same loop body, and the backfill order is written out. **Adopted.**
6. **Cycle handling wasn't defined**, only tested for "doesn't loop forever". *Fix:* drop back edges found in a depth-first walk before layering, but still draw them. **Adopted.**
7. **Accessibility of the SVG:** there were no labels, focus or tab order for node links. *Fix:* each node gets an `aria-label`, a focus ring and tab order by layout, and the SVG gets `role="group"`. External links get `rel="noopener noreferrer"`. **Adopted.**
8. **A stale `?repo` link** (repo disabled or removed) gave no defined result. *Fix:* fall back to the default repo. **Adopted.**
9. **Gap against the ticket ("past/completed ones too").** Enrolment lists open issues only, so tickets closed before enrolment have no row. Links between two such tickets are never read. *Fix considered:* a one-time read of every closed issue's links. It costs one request per closed issue and adds a lot for little gain, since those tickets still appear whenever a tracked ticket links to them. **Not adopted.** Stated as a limitation in Risks instead.
10. **`total_blocked_by` is undocumented.** Community reports confirm it exists and counts closed links. One reports a zero summary on an issue that had blockers. *Fix:* nothing treats a count as proof of "no links". The backfill reads every row once regardless, and the count only adds reads. **Adopted** (no design change beyond the Risks note).
11. **Removed links may not bump `updated_at`.** *Fix considered:* a slow rotation that re-reads every ticket's links. At a 3-minute poll that's a steady extra request load per repo, for a cosmetic problem. **Not adopted.** Noted in Risks.
12. **"Seeded database" for the Playwright check** had no mechanism, because the repo has no seed tool. *Fix:* a throwaway script, kept outside the repo, that migrates a temporary `DATA_DIR` and inserts fixture rows. **Adopted.**
13. **Per-node queries in `dependencyGraphs()`** would scale badly. *Fix:* one query for links and one for matching ticket rows per repo. **Adopted.**

Checked and fine as designed: `listChanged` reads `issue_dependencies_summary` already, so `total_blocked_by` costs nothing extra. `foreign_keys = ON` is set, so `ON DELETE CASCADE` works. `addBlocker` returns the full issue, so `toLink` can copy its title. The `fresh`-first ordering keeps the rate-limit return meaning.
