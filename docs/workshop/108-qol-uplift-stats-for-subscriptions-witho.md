# 108: Burn rate and backlog projections

## Context

The Usage page's Projections panel (`client/src/projections.ts`, fed by `GET /api/usage/history`) only talks about subscription windows, today's API cap and month-end totals. A subscription that Claude doesn't report usage for (`AllowanceView.unknown`) gets one line, "Claude doesn't report this subscription's usage.", and nothing else. That's the owner's screenshot (`/work/media/issue-1.jpg`, Claude-2).

Outcome:

- **Burn rate** for every Claude connection and for API billing: cost and tokens over the last 5 hours, the last 24 hours, and per day over the last 7 days. This is what a subscription without usage readings needs most.
- **Backlog projection**: how many tickets are left, what they should cost (subscription work as token-equivalent, API work in real dollars), and when they'll finish at the current pace.
  - Windowed subscriptions take their 5-hour and weekly limits and reset times into account.
  - API work takes the daily limit into account.
  - Unmetered work (a subscription that doesn't report usage, or API with room under its cap) just says "At this pace it finishes about … for …".
- A burn-down chart and a regrouped Projections panel, so the panel reads as sections rather than one long list.

## Approach

All maths stays pure in `server/src/projection.ts`, and `usageHistory` gathers its inputs, the same split #106 used. The projection is served on the existing endpoint, so API consumers get it too.

1. **Cost of a backlog ticket = what finished tickets of the same size spent on the stages it has left.**
   - History is the ledger from the last 90 days, joined to tickets (`spend.repo` = `repos.full_name`, `spend.ticket` = `tickets.number`). Only tickets that are **closed and had an `implement` run** count as finished.
   - For each size, and for every size together, take the **mean per finished ticket** of each agent's spend: the total that agent spent on tickets of that size, divided by how many finished tickets of that size there are. The mean is an expected value. It already includes retries and reworks, a Merge agent that runs only on conflicts, and Design runs that XS tickets never have (those count as 0).
   - A ticket's remaining agents follow its stage (`remainingAgents`, below). Its estimate is the sum of those agents' means for its size. A size with fewer than 3 finished tickets falls back to the all-sizes means, and so do unclassified tickets. With no finished tickets at all, there's no estimate.
   - A stage that's running now is counted in full. In-flight spend isn't in the ledger until the invocation ends.
   - Each agent's spend is split by billing using that agent's **current** `agent_classes.billing`. That's where the remaining work will be billed.

   I rejected an estimate by ticket count times average ticket cost, because it ignores stage and size. An L ticket in code review and an L ticket that hasn't been designed differ a lot.

2. **Pace = the last 7 days' average**, in token-equivalent USD per hour: `perDayUsd / 24`, the figure the month-end line already uses. A last-24-hours pace jumps around too much. "At this pace" includes idle hours and operating hours, which keeps it honest about how Workshop actually runs.

3. **Finish time comes from a small simulation: `drain()` in 15-minute steps, up to a 60-day horizon.**
   - Demand per step is pace × step. The work is served by **accounts**, in order, and each has zero or more **windows** `{ kind, left, perWindow, resetsAt, length }`, measured in USD.
   - In each step, an account can take at most the smallest `left` among its windows. That amount is subtracted from all of its windows. When a step passes a window's `resetsAt`, its `left` becomes `perWindow` again and `resetsAt` moves on by `length`.
   - An account with no windows is unlimited.
   - This handles stacked 5-hour and weekly ceilings, waiting for resets, several subscriptions, and the API daily limit, all with one function and no special cases.
   - The binding limit is reported as `limitedBy`: the window kind that most often left demand unmet. `unlimitedAt` is `now + work / pace`, so the copy can say what the limit costs.

4. **Sizing a subscription's windows.** Claude reports percentages, not amounts.
   - Convert with `usdPerPct = (this connection's ledger cost since the window began) / pct`, where the window began at `resetsAt − length`.
   - This needs a current-window reading (`windowProjection` isn't null) with `pct ≥ 5`, because smaller readings are too noisy. A window that can't be sized is left out, and listed in `unsized` so the copy can say it was ignored.
   - `left = max(0, limit − pct) × usdPerPct`, and `perWindow = limit × usdPerPct`, using your Settings limit, because that's where Workshop stops launching.
   - Cost-equivalent is a better proxy for Claude's percentage than raw tokens, which cache reads inflate. That's the 239M tokens in 5 hours in the screenshot.
   - A connection with `blockedUntil` gets a window with `left = 0` that resets at `blockedUntil` to unlimited. In practice: give it `{ kind: 'limit', left: 0, perWindow: Infinity, resetsAt: blockedUntil, length: Infinity }`.
   - An `unknown` connection has no windows, so it's unlimited. Workshop can't hold it at limits either (see the sidebar tooltip in `Layout.tsx`).
   - Paused connections are left out.

5. **API account.** One account with a `daily` window: `left = max(0, cap − todayUsd)` and `perWindow = cap`.
   - It resets at the next local midnight. Compute that as `startOfDay(dayStart + 36 h, tz)`, which is DST-safe, with a length of 24 h. The 23/25-hour days are ignored after the first reset, which is fine at this precision.
   - A cap of 0 means `reason: 'api-off'`.

The subscription work and the API work each drain on their own and run in parallel. The overall finish is the later of the two.

## Changes

### `server/src/projection.ts`

```ts
export const BACKLOG_HISTORY = 90 * 86400_000, MIN_TICKETS = 3, STEP = 15 * 60_000, HORIZON = 60 * 86400_000;

/** Agents a ticket at `stage` may still need, in pipeline order. Empty for pr-review (waiting on you). */
export function remainingAgents(stage: Stage | null): AgentName[];
// null, reclassify → classifier, design, design-review, implement, code-review, merge
// design → design…merge; design-review → design-review…merge; implement → implement, code-review, merge
// code-review → code-review, merge; merge, reconcile → merge; pr-review → []

export type CostTable = Record<Size | 'all', { tickets: number; byAgent: Partial<Record<AgentName, { usd: number; tokens: number }>> }>;
/** Mean spend per finished ticket by agent, per size and for all sizes. `rows` are one per finished ticket and agent. */
export function costTable(rows: { ticket: number; size: Size | null; agent: AgentName; usd: number; tokens: number }[]): CostTable;
/** A ticket's expected remaining spend by agent, or null when no finished ticket exists to estimate from. */
export function ticketEstimate(table: CostTable, size: Size | null, stage: Stage | null): Partial<Record<AgentName, { usd: number; tokens: number }>> | null;

export interface DrainWindow { kind: 'five-hour' | 'weekly' | 'daily' | 'limit'; left: number; perWindow: number; resetsAt: number; length: number }
export interface DrainResult { finishAt: number | null; unlimitedAt: number | null; limitedBy: DrainWindow['kind'] | null; curve: [number, number][] }
/** Simulates `work` USD drawn at `perHour` across `accounts` (each a list of windows; [] is unlimited). */
export function drain(work: number, perHour: number, accounts: DrainWindow[][], now: number): DrainResult;
```

- `drain`:
  - `work ≤ 0`: returns `finishAt = now` and an empty curve.
  - `perHour ≤ 0`, or no accounts: returns all nulls. The caller sets `reason`.
  - Otherwise it loops in `STEP` steps to `now + HORIZON`, finishing mid-step by interpolation.
  - `curve` holds `[ts, fraction of work left]` at `now`, then hourly, then at `finishAt`. That's at most 1,441 points.
  - `limitedBy` is null when demand was never unmet. A `limit` window never counts as `limitedBy`; the copy reports blocked subscriptions separately.
  - `unlimitedAt = now + work / perHour × 1 h`.
  - Beyond the horizon, `finishAt` is null; the caller sets `reason: 'beyond'`.
- `windowCapacity(w: WindowProjection | null, limit: number, usdSinceStart: number, kind, length): DrainWindow | null`. It returns null when `w` is null or `w.pct < 5`, as described in Approach 4.

### `server/src/spend.ts` (`usageHistory`)

- **Burn rates.** Add `burn(rows, now)`, which returns `{ fiveHours, day, perDay }` (each `{ usd, tokens }`): the last 5 h, the last 24 h, and the 7-day average per day (the same `paceDays` rule as `pace`).
  - Per connection: rows with that `connection_id` and non-api billing. Fetch the last 7 days once and filter in JS.
  - Per billing: added to `projection.api` and `projection.subscription` as `burn`.
- **Window sizing.** For each subscription connection, read the ledger cost since each window's start, `SELECT SUM(cost_usd) … WHERE connection_id = ? AND billing != 'api' AND ts >= ?`, which the existing `spend_connection` index covers. Pass it to `windowCapacity`.
- **Backlog.** Add `backlog(now, tz, allowance, api, subscription)`:
  - Tickets: open tickets in enabled repos (the `openTicketsSql` condition) whose author `isAllowedAuthor` allows and that `ticketInScope` keeps, using `parseLabels`. Skip `needsInfo`, `skip` and `failed`, and skip stage `pr-review`. Active runs stay in.
  - History rows:

    ```sql
    SELECT t.id AS ticket, t.labels, s.agent, SUM(s.cost_usd) AS usd, SUM(s.input_tokens + s.output_tokens) AS tokens
    FROM spend s JOIN repos r ON r.full_name = s.repo JOIN tickets t ON t.repo_id = r.id AND t.number = s.ticket
    WHERE t.state = 'closed' AND s.ts >= ? AND s.agent IS NOT NULL GROUP BY t.id, s.agent
    ```

    Then keep only tickets with an `implement` row, and get the size from `parseLabels(JSON.parse(labels)).size`.
  - Sum `ticketEstimate` over the tickets and split by `getAgent(a).billing`. Count tickets that have no estimate as `unestimated`.
  - Subscription accounts: `allowance` rows whose connection isn't paused (`getConnection(id)?.paused`), in `listConnections` order, which is the order `pickSubscription` uses. Each one's windows are its sized `five-hour` and `weekly` windows, plus a `limit` window when it's blocked. Add a window that can't be sized to `unsized` (as `"<name> 5-hour"` or `"<name> weekly"`), unless the connection is `unknown`.
  - API: one account with its `daily` window. If no API work remains, the pool is null.
  - The pace is `perDayUsd / 24` from the existing `pace()` results.
  - `reason`:
    - `'no-subscription'` when subscription work remains and every subscription is paused or none exists;
    - `'api-off'` when the cap is 0;
    - `'no-pace'` when the pace is 0;
    - `'beyond'` past the horizon.

### `server/src/api-types.ts`

Add the types listed under Data and interfaces.

### `server/src/http/openapi.ts`

Add `burn` to `AllowanceHistory` and to both projection objects, and add the `backlog` schema.

### `docs/api.md`

Add one sentence after the history example: the response includes burn rates and a backlog projection.

### `client/src/format.ts`

Add `when(ms)`:
- `clock(ms)` within 6 days;
- otherwise `toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })`, for example "Mon 7 Dec, 14:00".

`clock` alone can't name a weekday more than a week out unambiguously.

### `client/src/projections.ts`

Split the output into sections. `projectionLines` is replaced by:

```ts
export function projectionSections(data, now, time = when): {
  backlog: { lead: string; rows: BacklogRow[]; notes: string[]; detail: string } | null;  // null: hide the section
  burn: { key: string; name: string; cells: [Cell, Cell, Cell] }[];   // Cell = { cost: string; tokens: string }
  windows: { key: string; text: string }[];   // today's windowLine/subscriptionLines output
  month: { key: string; text: string }[];     // today's api-today, api-month, subscription-month lines
}
```

- **`backlog.lead`**:
  - "14 tickets left, about $222.00 (80.1M tokens). At the current pace they're done by about Sat 14:00."
  - With no estimate: "14 tickets left. There are no finished tickets from the last 90 days to estimate them from yet."
  - With an empty backlog: "Nothing in the backlog."
- **`rows`**: one per pool, with these columns:
  - Billing: "Subscriptions" or "API";
  - Left: "$180.00 token-equivalent" and "61.0M tokens" for subscriptions, "$42.00" for API;
  - Pace: "$12.40 an hour";
  - Finishes: `when(finishAt)`, or the reason in words: "Not at the current pace" (no-pace), "API agents are off" (api-off), "Every subscription is paused" (no-subscription), "More than 60 days" (beyond).
- **`notes`**, in order:
  - `limitedBy` is `weekly` or `five-hour`: "Your weekly limits hold subscription work back. At the pace alone it would be done by Fri 09:00."
  - `limitedBy` is `daily`: "The $20.00 API daily limit stretches API work to Mon 11:00. Without it, Fri 18:00."
  - `unsized`: "Ignores Claude-1's 5-hour limit: there's too little use in this window yet to tell how much it holds."
  - A subscription pool where some account is `unknown` (the owner's case): "Claude-2 doesn't report usage, so Workshop can't hold it at your limits. This assumes the current pace holds."
  - `unestimated > 0`: "2 tickets have no estimate yet and aren't counted."
- **`detail`** (small, muted):
  - "3 to classify · 4 in design · 5 to implement · 2 in code review."
  - Then "Estimated from 23 tickets finished in the last 90 days, by size and the stages each ticket has left."
- **`burn`**: one row per `allowance` entry, named after the connection, then "API" when API billing has spend in the last 7 days. Cells: last 5 hours, last 24 hours, a day (last 7 days).
- **`windows`**: change the `unknown` line to "Claude-2: Claude doesn't report this subscription's usage. See its burn rate above." The other window lines stay as they are.

### `client/src/pages/Usage.tsx` (`Projections`)

Keep one panel, and use `h3` sub-headings inside `panel-body stack`, in this order:

1. **Backlog**:
   - `lead` as a plain `<p>`;
   - a `.table-wrap` table of `rows` (Billing, Left, Pace, Finishes), with the token figure on a second line in `small muted`;
   - `notes` as a `ul.projections`;
   - a **burn-down `LineChart`** titled by its `aria-label` "Share of backlog left until it's done". It has one series per pool ("Subscriptions", "API"), uses the pool's `curve` × 100, runs from `start = now` to `end = max(finishAt) or the curve's last point`, and has no marks. Show it only when some pool's curve spans more than 2 hours, because a shorter one is just a straight drop. Plateaus show where a window ceiling holds work back, and that's the point of the chart;
   - then `detail`.
2. **Burn rate**: a `.table-wrap` `spend-table`. Columns: Connection, Last 5 hours, Last 24 hours, A day (last 7 days). Each cell shows cost, and the tokens on a second line in `small muted`.
3. **Subscription windows**: `windows` as `ul.projections`. Hidden when it's empty.
4. **This month**: `month` as `ul.projections`.

Then the existing footnote. Add to it: "Backlog estimates use what finished tickets of the same size spent on the stages left."

Show the empty state ("Nothing to project yet…") only when every section is empty.

`LineChart`'s tooltip already formats values as %. Its daily x ticks work for spans of a day or more. For shorter spans it draws no ticks, which is acceptable, because the Finishes column holds the time.

### `client/src/theme.css`

Add `.projections-section h3 { margin-top: 4px }` if the spacing needs it, and a `.cell-sub` style for the second line of a cell. Don't add new colour tokens: the series slots 1 and 2 are reused.

## Data and interfaces

No migration.

```ts
export interface Burn { usd: number; tokens: number }
/** Last 5 hours, last 24 hours, and the average per day over the last 7 days (or since first use). */
export interface BurnRate { fiveHours: Burn; day: Burn; perDay: Burn }

// AllowanceHistory gains:
  burn: BurnRate;
// UsageHistory.projection.api and .subscription each gain:
  burn: BurnRate;
// UsageHistory.projection gains:
  backlog: BacklogProjection;

export interface BacklogPool {
  /** Expected spend left: token-equivalent for subscriptions. */
  usd: number;
  tokens: number;
  /** The pace the projection uses: the last 7 days' average. */
  perHourUsd: number;
  finishAt: number | null;
  /** At the pace alone, ignoring limits. */
  unlimitedAt: number | null;
  /** The limit that holds the work back, or null when the pace alone decides. */
  limitedBy: 'five-hour' | 'weekly' | 'daily' | null;
  /** Why finishAt is null. */
  reason: 'no-pace' | 'no-subscription' | 'api-off' | 'beyond' | null;
  /** [time, fraction of this work left], hourly from now. */
  curve: [number, number][];
  /** Windows the projection ignores because they can't be sized yet, e.g. "Claude-1 5-hour". */
  unsized: string[];
  /** Subscriptions in the pool that don't report usage. */
  unmetered: string[];
}

export interface BacklogProjection {
  tickets: number;
  byStage: { stage: Stage | 'new'; count: number }[];
  /** Tickets with nothing to estimate from; counted but not costed. */
  unestimated: number;
  /** Finished tickets the estimate comes from. */
  basis: number;
  /** Null when no work of that billing is left. */
  subscription: BacklogPool | null;
  api: BacklogPool | null;
  /** The later pool's finishAt; null if either pool can't finish. */
  finishAt: number | null;
}
```

The curves add up to about 30 KB of JSON at the 60-day worst case. That's acceptable for this page. If it matters, thin the curve to every 4 hours once it runs past 7 days.

## Tests

- **`server/test/projection.test.ts`**:
  - `remainingAgents` for every stage.
  - `costTable` and `ticketEstimate`:
    - the mean includes zeros for agents a ticket never ran;
    - a size with fewer than 3 finished tickets uses `all`;
    - unclassified tickets use `all`;
    - an empty history gives null;
    - an `implement`-stage ticket sums implement, code-review and merge only.
  - `drain`:
    - unlimited: `finishAt = unlimitedAt`, and `limitedBy` is null;
    - a weekly window exhausted with a reset in 2 days: the work finishes after the reset, `limitedBy` is `'weekly'`, and the curve is flat between;
    - a 5-hour window refilling over several cycles;
    - two accounts, where the second picks up when the first is exhausted;
    - a blocked `limit` window that opens at `blockedUntil`;
    - pace 0 and no accounts give nulls;
    - beyond the horizon gives null;
    - work 0 gives now.
  - `windowCapacity`: `pct < 5` gives null, and the left and per-window amounts use your limit.
- **`server/test/spend.test.ts`**, in `usageHistory`:
  - burn rates per connection and per billing;
  - a backlog built from seeded repos, tickets (closed with an implement run, and open at various stages: `pr-review`, `needs-info` and failed excluded) and ledger rows, checking ticket count, `byStage`, `basis`, and the billing split after switching an agent class to `api`;
  - an `unknown` subscription is listed in `unmetered` and makes the pool unlimited;
  - a paused-only pool gives `reason: 'no-subscription'`.
- **`client/test/projections.test.ts`**: update it for `projectionSections`. Test:
  - the lead and its three variants;
  - each Finishes reason;
  - each note;
  - the burn rows, including the API row being omitted with no API spend;
  - the new `unknown` window line;
  - `when` for near and far times (pass a fixed `time` as the existing tests do).
- **`server/test/api.test.ts`**: the history response has `projection.backlog` and `allowance[].burn`.
- **Browser check**: build, then seed a database with:
  - one `unknown` subscription;
  - one windowed subscription at 60% of its weekly window with a 70% limit;
  - API spend with a $20 cap;
  - 10 closed tickets and 8 open ones.

  Screenshot `/usage` at 1280 px and 390 px in both themes into `/work/media/`. Check that the burn-down plateau is visible, the tables don't push the page sideways, and the tooltip shows on the chart.
- Run `npm run typecheck` and `npm test`.

## Risks and open questions

- **The estimate depends on history.** Until a few tickets finish, the backlog shows only a count. Sizes are taken from the closed tickets' current labels, and a ticket relabelled later moves to another size bucket. Both are acceptable.
- **The 7-day pace includes empty-backlog days**, so after a quiet week the finish time is pessimistic. The rate is shown next to every projection, so this is visible. A "busy hours only" pace was rejected: it needs the run timeline, and it would overpromise when operating hours apply.
- **Window sizing assumes Claude's percentage tracks token-equivalent cost on this connection.** Use outside Workshop on the same account breaks that assumption: it inflates the percentage, so the window looks smaller than it is, and the projection comes out on the cautious side. The note about unsized windows covers the low-data case.
- **Agents' billing can change** between now and when the work runs. The split uses current settings.
- **The simulation ignores operating hours and scheduled mode.** The footnote already says projections assume the same pace continues.
