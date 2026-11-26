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
export function windowProjection(w: UsageWindow | null, length: number, limit: number, sampledAt: number | null): WindowProjection | null;
export function capAt(spent: number, cap: number, dayStart: number, now: number): number | null;
export function monthEnd(monthToDate: number, perDay: number, todayKey: string /* YYYY-MM-DD */, dayFraction: number): number;
```

- `windowProjection`: returns null when `w`, `w.resetsAt` or `sampledAt` is missing, or when `sampledAt` falls before the window's start (a stale reading from the previous window). Otherwise:
  - `elapsed = sampledAt − start`, and `ratePerHour = elapsed < 15 min ? 0 : pct / hours(elapsed)`. Under 15 minutes the pace is too noisy.
  - `limitAt`: `sampledAt` if `pct ≥ limit`. Otherwise `sampledAt + (limit − pct) / rate` when the rate is above 0 and that time is before `resetsAt`, else null.
  - `fullAt`: the same calculation for 100.
- `capAt`: `now` if `spent ≥ cap`; null if `cap ≤ 0`, `spent = 0` or under 15 minutes have passed since midnight. Otherwise `dayStart + cap / (spent / (now − dayStart))`, or null if that lands 24 h or more after `dayStart`.
- `monthEnd`: the days left are `(daysInMonth − day) + (1 − dayFraction)`. Get `daysInMonth` from `Date.UTC(y, m, 0)`, which is calendar arithmetic and so DST-safe. Returns `monthToDate + perDay × daysLeft`.

### `server/src/spend.ts`

Add `usageHistory(range: UsageRange, timeZone: string, now = Date.now()): UsageHistory`:

- **Bucket keys.** Use an `Intl.DateTimeFormat('en-CA', { timeZone, year, month, day })` formatter like `dimensions()` already does. Day keys are `YYYY-MM-DD` and month keys `YYYY-MM`.
- **Buckets.** For day ranges, take today's key and step back N−1 calendar days with `Date.UTC` arithmetic (no gaps or duplicates around DST). Select rows with `ts ≥ now − (N + 1) × 86400_000` and keep those whose key is in the set. For `all`, list every month from the first row's month to the current one.
- **Series.** For each dimension, bucket the rows with the existing `groupBy` logic per bucket (a run counts once per bucket) and emit `SpendSeries`, sorted by total cost over the range, descending. Use the existing keys from `dimensions()`. Names:
  - billing: `Subscription`, `API`;
  - project: `owner/name`, or `Unknown` when null;
  - connection: `<name> (subscription)` or `<name> (API key)`, with the name resolved as `connectionTotals` does, or `Unknown`;
  - model: its id.
- **Allowance.** For each connection in `allowanceViews()`:
  - samples are its `source = 'probe'` rows from the last 7 days, oldest first. Add a helper `allowanceSamples(connectionId, since)` in `allowance.ts`;
  - `fiveHour` is `windowProjection(view.fiveHour, FIVE_HOURS, view.limits.fiveHour, view.sampledAt)`. `sevenDay` is the same with `SEVEN_DAYS` and `limits.weekly`.
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
  - `foldSeries(series, metric, n = 4)` keeps the first n series (already cost-sorted; for tokens, re-sort by token total) and sums the rest into `{ key: 'other', name: 'Other' }`. Series that are zero throughout the range are dropped;
  - `bucketLabel(key, bucket)` returns `26 Nov` for days and `Nov 2026` for months, using `toLocaleDateString` on the key read as UTC with `timeZone: 'UTC'`;
  - `value(t: SpendTotals, metric)` returns cost or input plus output tokens.
- **`client/src/components/Chart.tsx` (new)**. Both components measure their container width with a `ResizeObserver` (`useWidth` hook in the same file), draw at that pixel width with a fixed height (200 px), and never scroll sideways. Axis text is 12 px in `--muted`, gridlines are 1 px in `--line` on ticks only, and both use `role="img"` with an `aria-label` summarising the chart.
  - `StackedColumns({ labels, series: { name, color, values }[], format })`:
    - one column per bucket, with a 2 px gap between stacked segments and a 4 px rounded top on the top segment only (path, not `rx`);
    - the y axis comes from `niceTicks`, formatted with `money` or `tokens`;
    - x labels are thinned to fit at about 1 label per 56 px;
    - hovering anywhere in a column's full-height hit area highlights it and shows an HTML tooltip (absolutely positioned `div.chart-tip`) with the bucket label and each non-zero series value, plus the total.
  - `LineChart({ start, end, series: { name, color, points: [ts, value][] }[], marks: { label, value }[] })`:
    - the y axis is fixed at 0–100%;
    - lines are 2 px, broken (separate paths) wherever two readings are more than 2 h apart, so idle time doesn't show as a slope;
    - each `mark` is a dashed 1 px line labelled at the right edge ("5-hour limit 70%");
    - a crosshair and tooltip at the nearest reading show the time (`clock`) and both values.
  - `Legend({ items })`: a swatch and a name in text colour, shown above every chart with 2 or more series.
- **`client/src/pages/Usage.tsx` (new)**, route `usage`, nav link **Usage** after Runs in `Layout.tsx`, registered in `main.tsx`. It calls `useApi<UsageHistory>(`/usage/history?range=${range}`, ['runs', 'allowance', 'settings'])`. Panels, in order:
  1. **Filters** (one row above the charts; not a panel): `Range` select (Last 7 days, Last 30 days, Last 90 days, All time), `Group by` select (Billing, Model, Project, Connection), `Show` select (Cost, Tokens). The state is held in the URL search params so that reloading keeps the choice.
  2. **Projections**. One line per item, for example:
     - "Claude-1, 5-hour window: 42% used, 8% an hour. Reaches your 70% limit at 14:30 and resets at 17:00." Or "…resets at 17:00 before reaching your 70% limit." Or "Over your 70% limit until it resets at 17:00." Add "Reaches 100% at …" when `fullAt` is set.
     - The same line for the weekly window.
     - "API: $6.20 today. At today's pace it reaches the $20.00 daily limit at 18:10." Or "…stays under the $20.00 daily limit today."
     - "API this month: $41.00 so far, about $120.00 by the end of the month at $11.30 a day (last 7 days)."
     - "Subscriptions this month: $300.00 token-equivalent so far, about $900.00 by the end of the month (12.0M tokens a day)."
     - The API lines are omitted when API billing has no spend in the range and no cap is relevant. The subscription lines are omitted when there are no subscriptions. When a reading is stale or missing, say "No current reading." Footnote: "Projections assume the same pace continues. Workshop stops starting agents at your limits, so real use levels off there."
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
export interface SpendSeries { key: string; name: string; points: SpendTotals[] }

export interface WindowProjection {
  pct: number;
  resetsAt: number;
  /** Average use since the window began, in percentage points per hour. */
  ratePerHour: number;
  /** When usage reaches your limit at that pace; the reading's time if already over; null if it resets first or nothing is used. */
  limitAt: number | null;
  /** The same for 100%, where Claude itself stops. */
  fullAt: number | null;
}

export interface AllowanceHistory {
  connectionId: number;
  connectionName: string;
  limits: Limits;
  /** Readings from the last 7 days, oldest first. */
  samples: { ts: number; fiveHour: number | null; sevenDay: number | null }[];
  /** Null without a current reading. */
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
  - `windowProjection`: under the limit with the limit reached before the reset; the reset coming first (null); already over (`limitAt = sampledAt`); a stale reading from the previous window (null); `resetsAt` null; under 15 minutes elapsed (rate 0, nulls).
  - `capAt`: reaches the cap today; never today; already over; cap 0.
  - `monthEnd`: 30-, 31- and 28-day months, and the last day of the month.
- **`server/test/spend.test.ts`**, add `describe('usageHistory')` with fixed `now` and ledger rows:
  - `7d` yields exactly 7 contiguous day keys across a DST change (`Europe/London`, late October);
  - a resumed run counts once per bucket;
  - series are sorted by cost, and `Unknown` names appear for null project or connection;
  - `all` yields contiguous months from the first row;
  - the month-to-date and per-day figures split by billing.
- **`server/test/api.test.ts`**: `GET /api/usage/history` with a read token returns 200 with 30 buckets by default. `range=1y` returns 400 with the message. The existing OpenAPI coverage test then requires the route in `openapi.ts`.
- **`client/test/chart.test.ts`** (new): `niceTicks` (0, 7, 1234, 0.37), `foldSeries` (fewer than n, more than n into Other, zero series dropped, token re-sort), `bucketLabel`.
- **Browser check** (the ticket needs a browser): build, run the server with seeded spend and allowance rows, and screenshot `/usage` with Playwright at 1280 px and 390 px in both themes into `/work/media/`. Check for label collisions, tooltips, no sideways scroll, and that Settings no longer has the lifetime panel.
- Run `npm run typecheck` and `npm test`.

## Risks and open questions

- **The pace is an average since the window started.** A burst right after a quiet start underestimates, and the reverse overestimates. The copy says "at this window's pace", and the footnote says projections assume the same pace. Operating hours aren't modelled. A weekly projection made during a run-heavy afternoon may look alarming, but Workshop's own limit gate stops launches anyway.
- **API "today" uses `runs.started_at`**, like the launch gate, while the charts use ledger `ts`. Small differences around midnight are expected. Keeping the gate's figure means the projection agrees with what actually holds launches.
- **Colour follows rank within the range**, not a fixed entity. A model can change colour when you change the range. This is acceptable because the legend is always shown. Pinning colours by entity would need stored assignments.
- Moving Lifetime usage off Settings changes where existing users look. The link in Settings covers it.
