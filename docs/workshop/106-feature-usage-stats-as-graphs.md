# 106 — Usage stats as graphs

## Context

Usage is shown only as tables in the Lifetime usage panel at the bottom of Settings (`client/src/pages/Settings.tsx`, fed by `GET /api/usage/lifetime`). Those tables group by billing, model, project, connection and month. They have no time series and say nothing about where usage is heading.

Outcome:

- A new **Usage** page with charts over a chosen range (last 7, 30 or 90 days by day, or all time by month), grouped the same way the tables are (billing, model, project, connection), for cost or tokens.
- A chart of each subscription's 5-hour and weekly usage over the last 7 days, with its limits drawn on it.
- Projections in plain sentences: when a subscription window reaches your limit and 100% at its current pace, and whether that comes before the reset; when API spend reaches the daily limit today; and month-end cost for API billing and for subscriptions (token-equivalent), which have no dollar cap.
- The existing lifetime tables move to the Usage page unchanged.

## Approach

- **One new read endpoint, `GET /api/usage/history?range=`**, built from the `spend` ledger and `allowance_samples`. It returns aligned buckets, one series per group for every dimension, the subscription readings, and the projections. It's computed on the server so API consumers (scripts, home automation) can read "when do I hit my limit" too. The ledger is small (one row per claude invocation), so building every dimension in one pass is cheap, and switching the grouping in the UI needs no refetch.
- **The projection maths is pure** (`server/src/projection.ts`), with no DB and no clock, so it can be tested directly.
  - **Subscription window.** The pace is the average since the window began: `pct / (sampledAt − (resetsAt − length))`, with a length of 5 h or 7 d. This needs only the latest reading, it's easy to explain ("at this window's pace"), and it matches the meters. I rejected a regression over recent samples: readings only arrive while agents run or probes fire, so a slope is noisy and idle gaps distort it.
  - **API today.** The pace is today's spend divided by the time elapsed since local midnight. `apiSpendSince` gives the same figure the launch gate uses.
  - **Month end.** Month-to-date, plus the average per day over the last 7 days times the days left. When recording began less than 7 days ago, the average uses the days since the first ledger row (at least 1).
- **Charts are hand-rolled SVG** in one component file plus a small pure helper module. There's no chart library (AGENTS.md: few dependencies). Two forms cover it:
  - stacked columns for spend over time. Columns suit change over time with a part-to-whole split, and there's one axis;
  - lines for subscription percentages, on a fixed 0–100% axis with the limits as dashed reference lines.
- **Colours stay browns and greys** (client/AGENTS.md). There are four series slots plus Other, validated with the dataviz palette validator (see Data and interfaces). Adjacent-pair CVD and normal-vision separation pass in both themes. The lightness-band and chroma checks fail by construction, because the palette has to be brown and grey. Some slots are under 3:1 against the surface, so identity never relies on colour alone: a legend is always shown, there's a hover tooltip, and a table with the same numbers sits under the chart.

## Changes

### `server/src/projection.ts` (new, pure)

```ts
export const FIVE_HOURS = 5 * 3600_000, SEVEN_DAYS = 7 * 86400_000;
export function windowProjection(w: UsageWindow | null, length: number, limit: number, sampledAt: number | null, now: number): WindowProjection | null;
export function capAt(spent: number, cap: number, dayStart: number, now: number): number | null;
export function monthEnd(monthToDate: number, perDay: number, todayKey: string /* YYYY-MM-DD */, dayFraction: number): number;
```

- `windowProjection`: returns null when `w`, `w.resetsAt` or `sampledAt` is missing, when `sampledAt` falls before the window's start (a stale reading from the previous window), or when `resetsAt ≤ now` (the window has reset since the reading; the launch gate's `used()` in `gates.ts` counts that as empty too). Otherwise:
  - `elapsed = sampledAt − start`, and `ratePerHour = elapsed < 15 min ? 0 : pct / hours(elapsed)`. Under 15 minutes the pace is too noisy.
  - `over = pct > limit`, strictly, matching `thresholdBlock` (a window at exactly its limit doesn't block).
  - `limitAt`: `sampledAt` if `pct ≥ limit`. Otherwise `sampledAt + (limit − pct) / rate` when the rate is above 0 and that time is before `resetsAt`, else null. It may be earlier than `now` when the reading is old; the copy handles that (see Projections).
  - `fullAt`: the same calculation for 100.
- `capAt`, in this order: null if `cap ≤ 0` (a $0 limit means API launches are off, since `apiCapBlock` blocks at `spent ≥ cap`; the copy says so); `now` if `spent ≥ cap`; null if `spent = 0` or under 15 minutes have passed since midnight. Otherwise `dayStart + cap / (spent / (now − dayStart))`, or null if that lands 24 h or more after `dayStart`.
- `monthEnd`: the days left are `(daysInMonth − day) + (1 − dayFraction)`. Get `daysInMonth` from `Date.UTC(y, m, 0)`, which is calendar arithmetic and so DST-safe. Returns `monthToDate + perDay × daysLeft`.

### `server/src/spend.ts`

Add `usageHistory(range: UsageRange, timeZone: string, now = Date.now()): UsageHistory`:

- **Bucket keys.** Use an `Intl.DateTimeFormat('en-CA', { timeZone, year, month, day })` formatter like `dimensions()` already does. Day keys are `YYYY-MM-DD` and month keys `YYYY-MM`.
- **Buckets.** For day ranges, take today's key and step back N−1 calendar days with `Date.UTC` arithmetic (no gaps or duplicates around DST). Select rows with `ts ≥ now − (N + 1) × 86400_000` and keep those whose key is in the set. For `all`, list every month from the first row's month to the current one; with no rows at all, that's just the current month.
- **Series.** For each dimension, bucket the rows with the existing `groupBy` logic per bucket (a run counts once per bucket) and emit `SpendSeries`, sorted by total cost over the range, descending. Each series also carries `totals`, from `groupBy` over all the range's rows, not the sum of its points: a run that spans midnight is in two day buckets but must count as one run in the table. Use the existing keys from `dimensions()`. Names:
  - billing: `Subscription`, `API`;
  - project: `owner/name`, or `Unknown` when null;
  - connection: `<name> (subscription)` or `<name> (API key)`, with the name resolved as `connectionTotals` does, or `Unknown`;
  - model: its id.
- **Allowance.** For each connection in `allowanceViews()`:
  - samples are its `source = 'probe'` rows from the last 7 days, oldest first. Add a helper `allowanceSamples(connectionId, since)` in `allowance.ts`;
  - `fiveHour` is `windowProjection(view.fiveHour, FIVE_HOURS, view.limits.fiveHour, view.sampledAt, now)`. `sevenDay` is the same with `SEVEN_DAYS` and `limits.weekly`;
  - `sampledAt`, `blockedUntil` and `unknown` are copied from the view so the copy can explain a missing projection.
- **Projection.**
  - `todayUsd = apiSpendSince(startOfDay(now, tz))`. Import `startOfDay` from `scheduler/loop.ts`, as `api.ts` does.
  - `capAt` uses `getSettings().apiDailyCapUsd`.
  - `perDay` is computed per billing over `[now − 7 d, now)` from the ledger, divided by `min(7, max(1, (now − firstTs) / day))`. Tokens are input plus output.
  - Month-to-date comes from the rows whose month key equals the current month.

Keep `lifetimeSpend` as it is.

### `server/src/allowance.ts`

Add `allowanceSamples(connectionId: number, since: number)`, which returns `{ ts, fiveHour, sevenDay }[]`.

### `server/src/http/api.ts`

```ts
apiRouter.get('/usage/history', (req, res) => {
  const range = req.query.range ?? '30d';
  check(typeof range === 'string' && RANGES.includes(range), 'Range must be 7d, 30d, 90d or all.');
  res.json(usageHistory(range as UsageRange, getSettings().timezone));
});
```

It sits on `apiRouter` and is readable with a read token. Add it to `openapi.ts` with a `UsageHistory` schema, and update the `/usage/lifetime` summary only if its wording changes.

### `docs/api.md`

Add an example after the lifetime one: `# Usage over time with projections: range 7d, 30d (default), 90d or all`.

### Client

- **`client/src/chart.ts` (new, pure)**:
  - `niceTicks(max, count = 4)` returns round tick values from 0 (1/2/5 × 10ⁿ steps), never empty, and `[0, 1]` when max is 0;
  - `foldSeries(series, metric, n = 4)` keeps the first n series (already cost-sorted; for tokens, re-sort by token total) and sums the rest, points and `totals`, into `{ key: 'other', name: 'Other' }`. Series that are zero throughout the range are dropped. When exactly n + 1 series remain, keep all of them rather than fold one into Other;
  - `bucketLabel(key, bucket)` returns `26 Nov` for days and `Nov 2026` for months, using `toLocaleDateString` on the key read as UTC with `timeZone: 'UTC'`;
  - `value(t: SpendTotals, metric)` returns cost or input plus output tokens;
  - `readFilters(params: URLSearchParams)` returns `{ range, group, metric }`, falling back to `30d`, `billing` and `cost` for missing or unknown values, so a mistyped URL never sends a request that gets a 400;
  - `spreadLabels(ys: number[], minGap = 14)` nudges label positions apart so the two limit labels never overlap (5-hour 75% and weekly 80% are only 10 px apart at 200 px).
- **`client/src/components/Chart.tsx` (new)**. Both components measure their container width with a `ResizeObserver` (`useWidth` hook in the same file), draw at that pixel width with a fixed height (200 px), and never scroll sideways. Until the first measurement the container keeps its 200 px height and draws nothing, so the page doesn't jump. Hover uses pointer events (`pointermove`, plus `pointerdown` for touch) so a tap shows the tooltip on a phone; `pointerleave` hides it. Axis text is 12 px in `--muted`, gridlines are 1 px in `--line` on ticks only, and both use `role="img"` with an `aria-label` summarising the chart.
  - `StackedColumns({ labels, series: { name, color, values }[], format })`:
    - one column per bucket, with a 2 px gap between stacked segments and a 4 px rounded top on the top segment only (path, not `rx`). The column is 75% of its band, at least 1 px wide; when the band is under 4 px (90 days on a phone) drop the segment gaps and the rounding, which would otherwise swallow the column;
    - the y axis comes from `niceTicks`, formatted with `money` or `tokens`;
    - x labels are thinned to fit at about 1 label per 56 px;
    - hovering anywhere in a column's full-height hit area highlights it and shows an HTML tooltip (absolutely positioned `div.chart-tip`) with the bucket label and each non-zero series value, plus the total.
  - `LineChart({ start, end, series: { name, color, points: [ts, value][] }[], marks: { label, value }[] })`:
    - the y axis is fixed at 0–100%; readings above 100 are drawn at 100;
    - lines are 2 px, broken (separate paths) wherever two readings are more than 2 h apart, so idle time doesn't show as a slope;
    - each `mark` is a dashed 1 px line labelled at the right edge ("5-hour limit 70%"), label positions passed through `spreadLabels`;
    - a crosshair and tooltip at the nearest reading show the time (`clock`) and both values.
  - `Legend({ items })`: a swatch and a name in text colour, shown above every chart with 2 or more series.
- **`client/src/pages/Usage.tsx` (new)**, route `usage`, nav link **Usage** after Runs in `Layout.tsx`, registered in `main.tsx`. It calls `useApi<UsageHistory>(`/usage/history?range=${range}`, ['runs', 'allowance', 'settings'])`. Panels, in order:
  1. **Filters** (one row above the charts; not a panel): `Range` select (Last 7 days, Last 30 days, Last 90 days, All time), `Group by` select (Billing, Model, Project, Connection), `Show` select (Cost, Tokens). The state is held in the URL search params so that reloading keeps the choice.
  2. **Projections**. One line per item, for example:
     - "Claude-1, 5-hour window: 42% used, 8% an hour. Reaches your 70% limit at 14:30 and resets at 17:00." Or "…resets at 17:00 before reaching your 70% limit." Or, when `over`, "Over your 70% limit until it resets at 17:00." Add "Reaches 100% at …" when `fullAt` is set.
     - When the reading is older than 10 minutes (`ALLOWANCE_MAX_AGE_MS`, the age at which the gate re-checks), start with "As of 13:05:". If `limitAt` is then before now, say "At that pace it may already be at your 70% limit." instead of a time in the past.
     - When there's no projection, say why: "Claude reported a usage limit; resumes at 17:00." (`blockedUntil`), "Claude doesn't report this subscription's usage." (`unknown`), "The window has reset since the last reading." (a reading exists but the projection is null), else "No current reading."
     - The same lines for the weekly window.
     - "API: $6.20 today. At today's pace new API agents stop starting at about 18:10, when the $20.00 daily limit is reached." Or "…stays under the $20.00 daily limit today." Or "API daily limit reached; new API agents start again tomorrow." The limit is a launch gate: agents already running finish, so spend can go past it. With a $0 limit: "API agents are off: the daily limit is $0."
     - "API this month: $41.00 so far, about $120.00 by the end of the month at $11.30 a day (last 7 days)."
     - "Subscriptions this month: $300.00 token-equivalent so far, about $900.00 by the end of the month (12.0M tokens a day)."
     - The API lines are omitted when API billing has no spend this month and none today. The subscription lines are omitted when there are no subscription connections and no subscription spend this month. Footnote: "Projections assume the same pace continues. Workshop stops starting agents at your limits, so real use levels off there."
  3. **Spend over time**: `StackedColumns` for the chosen grouping and metric. Colours are assigned by folded order (`--series-1…4`, `--series-other`). Below it is a `SpendTable` of the range's per-group totals, which is the table view.
  4. **Subscription usage**: one `LineChart` per subscription connection over the last 7 days. It shows two series (5-hour, weekly) and marks at its two limits. The heading is the connection name, and the empty state is "No readings in the last 7 days."
  5. **Lifetime usage**: `LifetimeUsage` and `SpendTable` moved here verbatim from Settings.

  Empty state when `buckets` hold no spend: "No agent runs in this range." Use `ErrorNote` for errors.
- **`client/src/pages/Settings.tsx`**: remove `LifetimeUsage` and `SpendTable` (and the now-unused imports). Add one line under the API billing panel: "See usage and projections on the Usage page." with a `Link`.
- **`client/src/theme.css`**: series tokens in each of the three theme blocks, plus `.chart`, `.chart-tip` (uses `--raised`, `--line`, radius 4px, no shadow), `.legend` and `.filters` (wraps on phones).

## Data and interfaces

No migration. `allowance_samples` keeps 8 days (`loop.ts` cleanup), enough for the 7-day line chart.

New types in `server/src/api-types.ts`:

```ts
export type UsageRange = '7d' | '30d' | '90d' | 'all';

/** One group's totals per bucket; `points[i]` belongs to `buckets[i]`. */
export interface SpendSeries {
  key: string;
  name: string;
  points: SpendTotals[];
  /** Over the whole range; a run in two buckets counts once here, so this isn't the sum of `points`. */
  totals: SpendTotals;
}

export interface WindowProjection {
  pct: number;
  resetsAt: number;
  /** Average use since the window began, in percentage points per hour. */
  ratePerHour: number;
  /** When usage reaches your limit at that pace; the reading's time if already over; null if it resets first or nothing is used. */
  limitAt: number | null;
  /** The same for 100%, where Claude itself stops. */
  fullAt: number | null;
  /** Above your limit, strictly, as the launch gate judges it. */
  over: boolean;
}

export interface AllowanceHistory {
  connectionId: number;
  connectionName: string;
  limits: Limits;
  /** Readings from the last 7 days, oldest first. */
  samples: { ts: number; fiveHour: number | null; sevenDay: number | null }[];
  sampledAt: number | null;
  blockedUntil: number | null;
  unknown: boolean;
  /** Null without a reading from the current window. */
  fiveHour: WindowProjection | null;
  sevenDay: WindowProjection | null;
}

export interface UsageHistory {
  range: UsageRange;
  bucket: 'day' | 'month';
  /** 'YYYY-MM-DD' or 'YYYY-MM' in the settings time zone, oldest first, no gaps. */
  buckets: string[];
  /** Each sorted by cost over the range, highest first. */
  byBilling: SpendSeries[];
  byModel: SpendSeries[];
  byProject: SpendSeries[];
  byConnection: SpendSeries[];
  allowance: AllowanceHistory[];
  projection: {
    api: { todayUsd: number; dailyCapUsd: number; capAt: number | null; perDayUsd: number; monthToDateUsd: number; monthEndUsd: number };
    /** Token-equivalent; subscriptions aren't billed per token. */
    subscription: { perDayUsd: number; perDayTokens: number; monthToDateUsd: number; monthEndUsd: number };
  };
}
```

Series colour tokens (validated with the dataviz `validate_palette.js`; re-run it if you change a value):

| Token | Dark | Light |
|---|---|---|
| `--series-1` | `#c99a6b` | `#8a5a30` |
| `--series-2` | `#7d6a58` | `#9c948a` |
| `--series-3` | `#b0a89c` | `#4f3a28` |
| `--series-4` | `#8c5a36` | `#b08a63` |
| `--series-other` | `#ddd3c4` | `#cdc7be` |

## Tests

- **`server/test/projection.test.ts`** (new, pure):
  - `windowProjection`: under the limit with the limit reached before the reset; the reset coming first (null); already over (`limitAt = sampledAt`, `over` true); exactly at the limit (`limitAt = sampledAt`, `over` false); a stale reading from the previous window (null); the window reset since the reading (`resetsAt ≤ now`, null); `resetsAt` null; under 15 minutes elapsed (rate 0, nulls).
  - `capAt`: reaches the cap today; never today; already over; cap 0 with nothing spent (null, not `now`).
  - `monthEnd`: 30-, 31- and 28-day months, and the last day of the month.
- **`server/test/spend.test.ts`**, add `describe('usageHistory')` with fixed `now` and ledger rows:
  - `7d` yields exactly 7 contiguous day keys across a DST change (`Europe/London`, late October);
  - a resumed run counts once per bucket, and a run with rows either side of midnight counts once in `totals` but in both day buckets;
  - no ledger rows: `all` gives the current month only, and every series list is empty;
  - series are sorted by cost, and `Unknown` names appear for null project or connection;
  - `all` yields contiguous months from the first row;
  - the month-to-date and per-day figures split by billing.
- **`server/test/api.test.ts`**: `GET /api/usage/history` with a read token returns 200 with 30 buckets by default. `range=1y` returns 400 with the message. The existing OpenAPI coverage test then requires the route in `openapi.ts`.
- **`client/test/chart.test.ts`** (new): `niceTicks` (0, 7, 1234, 0.37), `foldSeries` (fewer than n, exactly n + 1 kept, more into Other with summed `totals`, zero series dropped, token re-sort), `bucketLabel`, `readFilters` (unknown and missing values fall back), `spreadLabels` (close labels pushed 14 px apart, far ones untouched).
- **Browser check** (the ticket needs a browser): build, run the server with seeded spend and allowance rows, and screenshot `/usage` with Playwright at 1280 px and 390 px in both themes into `/work/media/`. Seed one subscription with 5-hour and weekly limits 5 points apart. Check for label collisions, the tooltip on hover and on tap (Playwright `tap` with `hasTouch` at 390 px), the 90-day range at 390 px, no sideways scroll, and that Settings no longer has the lifetime panel.
- Run `npm run typecheck` and `npm test`.

## Risks and open questions

- **The pace is an average since the window started.** A burst right after a quiet start underestimates, and the reverse overestimates. The copy says "at this window's pace", and the footnote says projections assume the same pace. Operating hours aren't modelled. A weekly projection made during a run-heavy afternoon may look alarming, but Workshop's own limit gate stops launches anyway.
- **API "today" uses `runs.started_at`**, like the launch gate, while the charts use ledger `ts`. Small differences around midnight are expected. Keeping the gate's figure means the projection agrees with what actually holds launches.
- **Colour follows rank within the range**, not a fixed entity. A model can change colour when you change the range. This is acceptable because the legend is always shown. Pinning colours by entity would need stored assignments.
- Moving Lifetime usage off Settings changes where existing users look. The link in Settings covers it.
- **Readings are sparse.** Workshop only reads a subscription's usage when a launch is waiting and the last reading is over 10 minutes old, so when nothing is queued the latest reading can be hours old. The projection is then "as of" that reading, and the line chart has gaps.
- **Times mix two clocks**, as the rest of the UI does: buckets and "today" use the settings time zone, while `clock` shows times in the browser's. They differ only when the browser is in another zone.

## Review

Design review against the code at a5a9cf2. Each item gives the criticism, the fix, and whether the body above now adopts it.

1. **A window that reset since the last reading still gets a projection.** `windowProjection` had no `now`, so a 5-hour reading from 13:00 for a window that reset at 15:00 would still say "42% used, reaches 70% at 16:10" at 18:00. The gate (`used()` in `gates.ts`) treats a reset window as empty. *Fix:* pass `now`; return null when `resetsAt ≤ now`, with the copy "The window has reset since the last reading." **Adopted.**
2. **Readings can be hours old.** Probes only run when a launch is waiting and the reading is over `ALLOWANCE_MAX_AGE_MS` (10 min) old, so `limitAt` can land in the past. *Fix:* prefix old readings with "As of 13:05:" and replace a past `limitAt` with "may already be at your limit". **Adopted.**
3. **"Over your limit" disagreed with the gate at exactly the limit.** `thresholdBlock` blocks on `pct > limit`; the design used `≥`. *Fix:* add `over` (strict) to `WindowProjection` and use it for the "Over" copy; `limitAt` still marks when the limit is reached. **Adopted.**
4. **No reason given for a missing projection.** A subscription Claude reported as limited (`blockedUntil`), or one that doesn't report usage (`unknown`), would just say "No current reading." *Fix:* carry `sampledAt`, `blockedUntil` and `unknown` in `AllowanceHistory` and give each case its own sentence. **Adopted.**
5. **A $0 daily limit isn't "no cap".** `apiCapBlock` blocks when `spent ≥ cap`, so $0 turns API launches off. The design's check order made `capAt` return `now`, next to the copy "stays under the $0.00 daily limit". *Fix:* check `cap ≤ 0` first and say "API agents are off: the daily limit is $0." **Adopted.**
6. **The daily limit is a launch gate, not a spend ceiling.** Running agents carry on (each up to the per-run cap), so "reaches the limit at 18:10" overstates it. *Fix:* "new API agents stop starting at about 18:10", plus a sentence for when it's already reached. **Adopted.**
7. **Range totals summed from day buckets double-count runs.** `groupBy` counts a run once per bucket, so a run across midnight sits in two buckets, and the table's runs column (and Other in `foldSeries`) would overcount. *Fix:* `SpendSeries.totals` from `groupBy` over the whole range; the table reads that. **Adopted.**
8. **Hover-only tooltips don't work on phones.** *Fix:* pointer events, with `pointerdown` showing the tooltip on tap, checked with Playwright touch at 390 px. The table under the chart still carries every number. **Adopted.**
9. **90 columns at 390 px are about 4 px wide.** The 2 px segment gaps and 4 px rounding would swallow the column. *Fix:* the column takes 75% of its band, at least 1 px; no gaps or rounding when the band is under 4 px. **Adopted.**
10. **Limit labels collide.** Limits of 75% and 80% are 10 px apart on a 200 px chart. *Fix:* a pure `spreadLabels` pushes them at least 14 px apart. It's tested, and the browser check seeds the case. **Adopted.**
11. **Bad URL params would send a 400.** The filters live in the URL, so `?range=1y` would reach the server. *Fix:* a pure `readFilters` with fallbacks. **Adopted.**
12. **First render before `ResizeObserver` reports.** A width of 0 draws a broken chart and the page jumps. *Fix:* keep the 200 px height and draw nothing until measured. **Adopted.**
13. **Folding one series into Other.** With five series, "Other" would hold a single named group. *Fix:* fold only when more than n + 1 remain. **Adopted.**
14. **Small gaps:** `all` with an empty ledger (now the current month only); readings above 100% (clamped in the line chart); and when the API and subscription lines show. They now depend on this month's and today's spend, not the chosen range, because the projections don't change with the range. **Adopted.**
15. **API pace since midnight underestimates when work starts late,** or when operating hours apply. An alternative is the pace since today's first API run, but that overestimates after one expensive run, and midnight matches how the gate counts "today". **Not adopted.** The footnote already says the projection assumes the same pace.
16. **Times mix two time zones.** Buckets and "today" use the settings time zone; `clock` uses the browser's. Switching `clock` to the settings zone would make this page disagree with every other page. **Not adopted;** recorded under Risks.
17. **The endpoint scans the ledger on every `runs` event, and `spend` has no `ts` index.** `/usage/lifetime` already does the same on Settings, and the ledger has one row per invocation. **Not adopted.** Add an index only if it shows up as slow.
18. **The ticket doesn't ask to move Lifetime usage off Settings.** Moving it puts all usage in one place, and Settings keeps a link. **Kept as designed.**
19. **Security:** the endpoint shows the same project and connection names as `/usage/lifetime`, to the same read tokens, and takes only a validated enum. No new risk. **No change.**
