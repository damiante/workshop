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
  - `setLinks(t, links: TicketLink[])`: in a `BEGIN`/`COMMIT` (as in `spend.ts`), replace the ticket's rows and set `links_checked_at = Date.now()`. Call `publish('tickets')` only if the rows changed;
  - `addLinks(t, links)`: upsert without deleting, for the Classifier path;
  - `linkCount(ticketId)`;
  - `dependencyGraphs(): DependencyGraph[]`, which builds the API view (below).
- `server/src/scheduler/sync.ts` (`syncBlockers`):
  - after every `source.blockers()` call, also call `setLinks(t, links)` with the full list, unfiltered;
  - append the two new target groups after the existing ones, de-duplicated by ticket id: listed tickets with a changed count (any state, rows that exist), then the backfill batch;
  - the `fresh` group stays first, so the rate-limit return value `i >= fresh.length` keeps its meaning. A failure in a new group only logs, like held re-reads. Update the function's doc comment.
- `server/src/scheduler/runner.ts` (`blockers` step): after `setBlockers`, call `addLinks(t, links)` with every link `addBlocker` returned. The graph then shows the Classifier's links straight away. The step stays idempotent.
- `server/src/http/api.ts`: `apiRouter.get('/dependencies', …)` returns `dependencyGraphs()`.
- `server/src/http/openapi.ts`: add the route and the `DependencyGraph`, `DependencyNode` and `DependencyEdge` schemas.
- `docs/api.md`: one curl example and a short paragraph.

### Client

- `client/src/graph.ts` (pure, tested): `layoutGraph(graph, { hideClosed })`. It returns positioned nodes, edge paths and an overall size, plus `nodeStatus(node)`, which gives `{ tone, text }` for a node.
- `client/src/pages/Dependencies.tsx`: route `dependencies`, with the repo chosen by `?repo=<id>`. The default is the first repo that has any edges.
  - Header: `<h1>Dependencies</h1>`, a repo `<select>`, and a checkbox "Hide closed tickets" (off by default).
  - One sentence of progress: "5 of 9 tickets in these trees are closed."
  - The SVG sits in a `.graph-wrap` panel that scrolls sideways itself, like `.table-wrap`, so the page never does.
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
  2. active run → "Agent working" (`running`);
  3. failed → "Stopped after failures" (`error`);
  4. needs info → "Waiting for your answer" (`attention`);
  5. any open blocker → "Waiting for #2, #5" (`attention`);
  6. not in Workshop → "Not in Workshop" (`idle`);
  7. otherwise the stage from `STAGE_TEXT`, or "To classify".

Closed nodes are drawn at reduced opacity, with text still AA against `--surface`. A Workshop node is an SVG `<a>` to `/tickets/:id` (client-side navigation via `useNavigate` on click and Enter). An external node opens its GitHub URL in a new tab.

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
- **Nodes:** each ticket that appears in any of those edges, as either end. A blocker that is a Workshop ticket row in the same repo uses that row (its `state` and a `ticketView`). Otherwise the node is built from the link's stored fields, with `ticket: null`.
- **Sorting:** nodes by number, then edges.
- **Repos with no edges:** still listed, with empty arrays, so the picker shows every repo.

## Tests

- `server/test/pipeline.test.ts` (in the sync blockers `describe`):
  - a held ticket whose blocker closes keeps the edge in `ticket_links` with state `closed`, while `blocked_by` becomes `[]`;
  - a listed ticket with `openBlockers: 0, totalBlockers: 1` and no stored links is read, and its edge is stored;
  - a matching count is not read again;
  - the backfill reads at most `LINK_BACKFILL_PER_SYNC` never-read tickets, closed ones included, and sets `links_checked_at`;
  - a rate limit during backfill still returns complete (`synced_at` advances);
  - the Classifier's `blocked` result writes the link rows.
- `server/test/api.test.ts`: `GET /api/dependencies` returns:
  - nodes for both ends;
  - a `ticket: null` external node with the stored title;
  - the blocker's state from its ticket row;
  - empty arrays for a repo without links;
  - 401 without a session.

  The existing OpenAPI coverage test checks the route is documented.
- `client/test/graph.test.ts`:
  - layering: a chain gets columns 0, 1, 2, and a diamond puts its join in column 2;
  - a cycle doesn't loop forever;
  - disconnected groups are stacked without overlapping;
  - `hideClosed` drops closed nodes and their edges;
  - barycenter ordering;
  - `nodeStatus` follows its precedence order.
- Run `npm run typecheck` and `npm test`. Then check the page with Playwright at desktop and phone (375px) widths, in both themes, against a seeded database. Save screenshots to `/work/media/`.

## Risks and open questions

- **`total_blocked_by` is assumed** to be in the issue list's `issue_dependencies_summary`, alongside `blocked_by`. If GitHub omits it, `totalBlockers` stays undefined. Edges are still captured by held re-reads, by the Classifier and by the one-time backfill, but a link added later to a ticket that was never held isn't seen.
- **Adding a dependency on GitHub is assumed to bump the issue's `updated_at`**, so `since` lists it. If it doesn't, such links show up only when the ticket next changes.
- **Rate limits:** the backfill adds at most 20 requests per repo per sync. It ends once every ticket has `links_checked_at`. A large existing backlog takes a few hours to fill in, so the page may look incomplete for that time after the upgrade.
- **External blockers' state goes stale:** another repo's ticket, or one by an author Workshop doesn't work for, shows the state from the last read. That read is refreshed whenever the dependent ticket is re-read.
- **Large graphs:** there's no virtualisation. A repo with hundreds of linked tickets gives a big SVG inside a scrolling panel, which is acceptable for now.
