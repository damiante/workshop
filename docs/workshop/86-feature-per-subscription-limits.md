# Design: per-subscription usage limits (#86)

## Context

The 5-hour and weekly limits (`Settings.fiveHourMax`, `Settings.weeklyMax`) are global. With more than one Claude subscription (now ranked, with agents using the first one that isn't held back), the owner wants each one used differently: say, a personal subscription kept at 40% so there's headroom for their own use, and a spare one run up to 90%.

Outcome: every Claude connection has its own 5-hour and weekly limit. Launch gates, subscription picking, threshold pauses, resumes and the top-bar meters all use the limit of the connection in question. Existing installs keep their current behaviour: each connection starts with the old global values.

## Approach

- **Store the limits as two columns on `connections`** (`five_hour_max`, `weekly_max`), with schema defaults of 70 and 80, the current defaults. A migration copies the current global values onto every existing connection and removes the keys from the settings JSON. Columns rather than keys in `config`: the defaults live in the schema, a deleted connection takes its limits with it, and the connection edit form (which runs a paid connection test on every save) stays out of it. A new connection gets 70/80, not a copy of another connection's limits. That's simple and predictable, and the owner can change it straight away.
- **Expose them on `AllowanceView.limits`.** `allowanceOf` already reads per connection, and every gate (`allowanceBlock` in `buildQueue`, `pickSubscription`, `resumePaused`, refresh) goes through it. `thresholdBlock` takes the limits explicitly. So per-subscription picking and resuming work without further changes: an agent moves on to the next subscription when the first is over *its own* limit.
- **Edit them in Settings**, where the owner looks for limits today. The "Claude subscription allowance" panel shows one row per subscription with its two fields, saved by the page's existing "Save settings" button. They're saved through a new `apiRouter` route, so API tokens can still change limits (as they could through `PUT /api/settings`), and saving doesn't probe the connection.
- The global `thresholds` field on `Overview` and `Usage` goes away; each allowance entry carries its own `limits`. `PUT /api/settings` with `fiveHourMax` or `weeklyMax` returns 400 and points to the new route, so old scripts fail loudly instead of silently doing nothing.

## Changes

- `server/src/db.ts`: append to `MIGRATIONS`:
  ```sql
  -- Usage limits per Claude connection (were global settings).
  ALTER TABLE connections ADD COLUMN five_hour_max REAL NOT NULL DEFAULT 70;
  ALTER TABLE connections ADD COLUMN weekly_max REAL NOT NULL DEFAULT 80;
  UPDATE connections SET
    five_hour_max = COALESCE((SELECT json_extract(value, '$.fiveHourMax') FROM settings WHERE key = 'settings'), 70),
    weekly_max = COALESCE((SELECT json_extract(value, '$.weeklyMax') FROM settings WHERE key = 'settings'), 80);
  UPDATE settings SET value = json_remove(value, '$.fiveHourMax', '$.weeklyMax') WHERE key = 'settings';
  ```
  (`json_extract`/`json_remove` work in Node 24's SQLite; checked.)
- `server/src/providers/index.ts`: `Row` gains `five_hour_max`, `weekly_max`. `Connection` gains `limits: Limits`, filled in `fromRow`. New `setLimits(id: number, limits: Limits)` updates both columns and calls `publish('allowance')`. `toView` is unchanged.
- `server/src/api-types.ts`:
  - `export interface Limits { fiveHour: number; weekly: number }` (percentages);
  - `AllowanceView.limits: Limits`, documented as "No new agents start on this subscription above these, and its running agents pause";
  - remove `Settings.fiveHourMax`, `Settings.weeklyMax`, `Overview.thresholds` and `Usage.thresholds`.
- `server/src/settings.ts`: drop the two keys from `DEFAULT_SETTINGS`. In `getSettings`, nothing else: the migration removed the stored keys.
- `server/src/allowance.ts`: `allowanceOf(connectionId, name = '')` adds `limits`, read from the connection: `getConnection(connectionId)?.limits ?? DEFAULT_LIMITS`. Export `DEFAULT_LIMITS: Limits = { fiveHour: 70, weekly: 80 }` from here, and use it for a connection that no longer exists. `allowanceViews()` can pass `c.limits` through to avoid a second lookup.
- `server/src/scheduler/gates.ts`:
  - `thresholdBlock(w, limits: Limits, s: Pick<Settings, 'timezone'>, now)`: compare against `limits.fiveHour` and `limits.weekly`. Messages are unchanged;
  - `allowanceBlock` calls `thresholdBlock(a, a.limits, s, now)`;
  - update the doc comments: "the thresholds in Settings" becomes "this subscription's limits".
- `server/src/scheduler/runner.ts`, `overThreshold`: read `stored = allowanceOf(r.model_connection_id)` first, and judge both the run's own reading and the stored one against `stored.limits`. Without a `model_connection_id`, use `DEFAULT_LIMITS`. Raising a connection's limit lets its threshold-paused runs resume through `resumePaused`, as before.
- `server/src/scheduler/loop.ts`: no logic change. Update the comments that mention "the thresholds" (lines 60 and 204) to say each subscription's limits.
- `server/src/http/api.ts`:
  - remove `thresholds` from `/overview` and `/usage`;
  - `PUT /settings`: if `b.fiveHourMax !== undefined || b.weeklyMax !== undefined`, throw 400 "Usage limits are set per subscription now: PUT /api/usage/limits/:connectionId.". Remove the two `num(...)` lines;
  - new `PUT /usage/limits/:connectionId`, body `{ fiveHour?, weekly? }`. It checks that `getConnection(id)` exists, is `kind === 'model'` and has `secret.oauthToken`, and otherwise returns 404 "That isn't a Claude subscription connection.". It validates each field with `num(..., '5-hour limit', 0, 100)` and `num(..., 'Weekly limit', 0, 100)`, merges them with the current limits, calls `setLimits` and `kick()` (as `/connections/order` does, so launches and resumes are reconsidered at once), and answers with `allowanceOf(id, name)`. This route is a write, so read-only tokens are refused by the existing write check.
- `server/src/http/openapi.ts`: remove `fiveHourMax`/`weeklyMax` from `Settings` and `thresholds` from the Overview and Usage schemas. Add `limits: object({ fiveHour: num, weekly: num })` to the allowance schema. Add the new route (body schema plus `ok: ref('Allowance')`, or whatever the allowance schema is called).
- `client/src/components/Layout.tsx`: `threshold={a.limits.fiveHour}` and `threshold={a.limits.weekly}`.
- `client/src/pages/Settings.tsx`, "Claude subscription allowance" panel:
  - load `useApi<Usage>('/usage', ['allowance', 'connections'])` and keep a draft `Record<connectionId, Limits>`, set from `allowance` when it loads;
  - render one block per subscription: the connection name (`<strong>`) and, below it, the two existing `NumberField`s with their current help texts. Help on the 5-hour field: "No new agents start on this subscription above this, and its running agents pause after their current step until usage drops back under it. Claude's own warning at 90% also holds them, so higher values have no effect." The weekly field uses the same text without the last sentence. With a single subscription, still show its name;
  - above the rows, the panel text says "Each subscription has its own limits. Subscription agents use the first one in your order (Connections) that's under them.";
  - with no subscriptions: "No Claude subscription connected yet. Add one on the Connections page.";
  - `save` PUTs `/settings` as now, then PUTs `/usage/limits/:id` for each subscription whose draft differs from what was loaded. Any error shows in the existing `saveError`. Any edit to a limit sets `saved` to false.
- Docs:
  - `docs/api.md`: in the usage example, say "allowance and limits per subscription". Add a curl example for `PUT /api/usage/limits/3` with `{"fiveHour":50}` and a sentence about the 400 from `/settings`;
  - `README.md` line 109: limits are per subscription;
  - `docs/design/architecture.md` lines 69 and 96: "a threshold in Settings" becomes "its subscription's limit".

## Data and interfaces

- DB: `connections.five_hour_max REAL NOT NULL DEFAULT 70` and `connections.weekly_max REAL NOT NULL DEFAULT 80`, initialised from the old global values. The settings JSON loses `fiveHourMax` and `weeklyMax`.
- API (breaking, documented):
  - `Settings` loses `fiveHourMax` and `weeklyMax`, and `PUT /api/settings` rejects them with 400;
  - `Overview.thresholds` and `Usage.thresholds` are removed;
  - `AllowanceView.limits: { fiveHour, weekly }` is new;
  - `PUT /api/usage/limits/:connectionId` with `{ fiveHour?, weekly? }` (0–100) returns an `AllowanceView`.

## Tests

- `server/test/gates.test.ts`:
  - `thresholdBlock` uses the limits it's given: 74% passes with `{ fiveHour: 80, weekly: 80 }` and blocks with 70;
  - `allowanceBlock` reads `a.limits`. Update the fixtures that build an `AllowanceView` to include `limits`, and the `s({ fiveHourMax })` call.
- `server/test/pipeline.test.ts`:
  - replace `saveSettings({ fiveHourMax: … })` with `setLimits(connId, …)` in the threshold-pause tests;
  - new: two subscriptions both at 60% 5-hour usage, the first limited to 50 and the second to 70. The launch uses the second (picking honours per-connection limits);
  - new: a run paused for `threshold` resumes once *its* connection's limit is raised, and stays paused when only the other connection's limit is raised.
- `server/test/api.test.ts`:
  - `/usage` returns `allowance[].limits` and no `thresholds`. Update the existing assertion at line 231;
  - `PUT /api/usage/limits/:id` saves the limits, rejects 101 and -1 with 400, returns 404 for a host connection or an API-key-only Claude connection, and is refused for a read-only token;
  - `PUT /api/settings` with `fiveHourMax` returns 400 with the message;
  - migration, following the pattern in `server/test/spend.test.ts` (applies `MIGRATIONS.slice(0, -1)` to a database, inserts rows, then the last one): with a settings row of `{ fiveHourMax: 55, weeklyMax: 65 }` and a connection, the connection ends up 55/65 and the settings JSON no longer has the keys. Without a settings row, it ends up 70/80.
- The OpenAPI route-coverage test picks up the new route automatically.
- Browser check (Playwright): with two Claude connections, Settings shows a limits block per subscription. Changing one and choosing "Save settings" persists it after a reload, and the top-bar meter's marker moves for that connection only. Save screenshots to `/work/media/`.
- Run `npm run typecheck` and `npm test`.

## Risks and open questions

- Removing `thresholds` and the settings fields breaks any API consumer that read them. Workshop is self-hosted with one owner, `docs/api.md` documents the change, and the 400 makes scripts that write the old fields fail loudly. Keeping a derived global value would be misleading.
- An API-key-only Claude connection also gets the columns. They're unused, and Settings doesn't show it, since `allowanceViews` lists only connections with a subscription token. Adding a token later gives it 70/80.
- The limit can't follow a token moved to a new connection. A new connection starts at 70/80. That's acceptable and visible in Settings.
