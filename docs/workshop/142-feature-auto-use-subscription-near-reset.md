# Design: weekly burndown per subscription (#142)

## Context

Each Claude subscription has a hand-set 5-hour and weekly limit (#86). The owner wants the weekly window used up, about 100% at the weekly reset, without starving their own chats early in the week. A hand-set weekly limit can't do that: it's either too low (allowance left over at the reset) or too high (Workshop burns it on day 1).

Outcome:
- A per-subscription toggle, **Follow the weekly burndown**. When it's on, Workshop computes a weekly ceiling that rises through the week and reaches a target just under 100% at the reset. The hand-set weekly limit still caps it: the effective weekly limit is `min(set, burndown)`. Setting the weekly limit to 100% hands control to the burndown.
- The ceiling's shape comes from rates Workshop learns from its usage readings: the owner's own use, how fast Workshop's agents burn the weekly window, and how often the 5-hour limit holds them. The target's margin adjusts itself week by week.
- Meters and charts show both lines: "I said stop here" (the set limit) and "I'll work up to here" (the burndown).
- Running agents aren't stopped and started every time the moving line passes them. Hand overrides still work: a ticket's **Ignore usage limits** setting passes both lines, but never a limit Claude reports.
- Every reading and every finished week is stored with the ceiling and estimates in force, so the owner can tell whether the method is too liberal or too conservative.

## Approach

### The ceiling

A pure function, `burndownCeiling`, in a new `server/src/burndown.ts`. It works in weekly percentage points:

- `r` = hours until the weekly reset, `L` = 168.
- `target` = `100 − margin`. The margin starts at 3 and is stored per connection, so it errs on the side of undershooting.
- `U` = other use, in points per hour: everything that isn't Workshop's agents (mostly the owner's chats).
- `M` = Workshop's agents' net weekly rate while they run, in points per hour.
- `d` = the 5-hour duty cycle, `min(1, fiveHourLimit / (5 × f))`. `f` is the 5-hour window's rate (points per hour) while agents run. In each 5-hour window, agents burn at `f` until they reach the 5-hour limit, then wait for the reset.
- If the latest reading's weekly `resetsAt` has already passed (the week turned over in the last few minutes), the reading counts as 0% and the reset rolls forward by whole weeks (`resetsAt + k·L`), so the ceiling starts the new week near 0. It is not null: a null ceiling would leave only the set limit, and every free slot would launch in the first minutes of the week.
- `A` = hours Workshop may start agents before the reset: the operating hours in `scheduled` mode, otherwise `r`. `paused` mode counts as `always`, because a pause is temporary. Counted in 15-minute steps with `withinHours`.

```
linear  = target × (1 − r / L)                     // even share of the week, by the clock
catchUp = target − U·r − CATCH_UP_SHARE · M·d·A    // the lowest ceiling from which Workshop, at 75% of its real speed, still reaches the target
userCap = target − USER_SAFETY · U·r               // always leave room for 1.5× your usual own use until the reset
ceiling = clamp(min(max(linear, catchUp), userCap), 0, target)
```

Why this shape:
- `linear` is the line the owner asked for. It rises slowly and reaches the target at the reset. It also hedges: in a heavy week for the owner, their own use pushes the reading into the line and Workshop gets less, automatically.
- `catchUp` is where the 5-hour readings come in. A cap only matters while it holds agents back, and holding them back is wasteful when they couldn't catch up later anyway. That happens with restricted operating hours, a low 5-hour limit, or slow agents. `catchUp` lifts the line early in exactly those cases. It's left out (−∞) until `M` and `f` have at least 2 hours of data each.
- `userCap` keeps the owner's own use protected when they use a lot of Claude, at the cost of undershooting.

Alternative considered: reserve only the owner's expected use (`target − U·r`) and let Workshop take the rest at once. That gives better utilisation when `U` is accurate, but it front-loads the week, which is exactly the "sad days" the ticket describes. The owner also asked for a line that rises slowly, so I rejected it.

### Learning the rates

`learnRates(readings)` is pure. It reads the last 14 days of `probe` readings for the connection and looks at consecutive pairs. A pair is skipped when it's more than 2 h apart, when the two readings are from different weekly windows (resets differ by ≥ 1 h), or when its weekly reading falls. Each kept pair is classified by the new `active` column (the connection's agents in their claude step when the reading was taken):
- **Idle**: both ends 0. Weekly rise and time add to `U`. `U` is shrunk towards a prior of 0.15 points/h (about 25% a week), weighted as 24 hours of data: `U = (0.15·24 + Σdw) / (24 + Σdt_h)`.
- **Busy**: both ends > 0. Then `M = max(0, Σdw/Σdt_h − U)`. Pairs in the same 5-hour window also give `f = Σd5/Σdt_h`.
- **Mixed or unknown** (`null` on older rows): skipped.

The sums telescope, so the 0.1-point rounding in readings only matters at the ends.

An agent that starts and ends between two idle readings doesn't make a false idle pair. Its run records a reading every time its usage changes (`recordUsage` in the runner), and those readings have `active > 0`, so the pair is split into mixed pairs that are skipped. Mixed pairs lose a little of Workshop's own use from `M`, never add it to `U`.

**Data collection changes.** Today readings only exist while agents run or a launch is waiting for a check, so there are almost no idle readings. Two changes:
- On the 60-second tick, Workshop probes every unpaused subscription whose latest reading is older than 60 minutes (`IDLE_SAMPLE_MS`). That's about 24 tiny probes a day per subscription. It happens whether or not the burndown is on, so the owner has data before turning it on.
- In the 30 minutes before a subscription's weekly reset, the tick also probes it when its latest reading is older than 15 minutes. Without it, `final_pct` could be up to an hour stale, and the margin feedback depends on it.
- `recordProbe` stores `active`, the burndown `ceiling`, whether the burndown was on (`burndown`) and which term set the ceiling (`bound`: `linear`, `catchUp`, `userCap` or `target`) with each reading. `bound` tells the owner why a week ended low, for example `userCap` holding agents back on a week their own use was overestimated.

### Adjusting week by week

`closeWeeks(now)` (in `allowance.ts`, called from the tick) writes one `burndown_weeks` row for each weekly window of a subscription that has ended and has no row yet (looking back 14 days). The row holds:
- `final_pct`: the highest weekly reading in that window;
- `enabled`: the burndown was on for most of the window's readings (the new `burndown` column; a toggle mid-week doesn't count the whole week);
- `held_hours`: hours between readings where the burndown was on and the reading was ≥ the stored ceiling;
- `blocked`: a `limit` row whose `blocked_until` is within 1 h of the reset;
- the estimates at that moment and the margin before and after.

When the burndown was on for that week, a pure function `nextMargin` adjusts the margin:
- `final_pct ≥ 100` or `blocked` (overshot): margin + 2, at most 10.
- `held_hours ≥ 6` and `final_pct < target − 3` (held back and still ended low): margin − 1, at least 1.
- Otherwise unchanged.

### Effect on running agents, and hand overrides

- **Launches** gate at the effective weekly limit, `min(set, ceiling)`.
- **Running agents** (`overThreshold` in the runner) are judged against `min(set, ceiling + RUN_GRACE_PCT)`, where `RUN_GRACE_PCT` is 2. The set limit stays strict, as today. Paused runs resume through `allowanceBlock`, which has no grace, so the 2 points act as hysteresis. Without it, every agent would pause and resume each time the line moved, and each resume rebuilds its prompt cache.
- **Turning the toggle on, or a lower re-estimate**, can put usage above the new line. Launches stop at once. Running agents pause at their next turn boundary only if usage is over the line by more than the grace, the same as lowering a limit by hand today. `PUT /usage/limits` and `closeWeeks` margin changes `kick()` so that paused runs are reconsidered.
- **Pushing work through**: a ticket's existing **Ignore usage limits** (`bypass_limits`) skips both the set limit and the burndown, for launches and running agents. Claude-reported limits still apply. You can also turn the burndown off or raise the 5-hour limit. Nothing new is needed.
- With the toggle on but no current weekly reading (`ceiling` null), only the set limit applies. The existing missing-or-stale reading rule ("Checking allowance") still fails closed.

### Caching

`allowanceOf` runs for every candidate on every allocation pass, so `burndownOf(connectionId)` caches its `Burndown` for 60 s. The rates are cached for 10 minutes. The ceiling depends on the clock, the rates, the margin, the settings and the weekly `resetsAt`, not on the latest percentage. So `recordProbe` clears the 60-second cache only when the weekly `resetsAt` changes; it never clears the rates. Running agents record a reading on almost every reply, and clearing on each would re-read 14 days of readings many times a minute. `setLimits`/`setBurndown`, `PUT /settings` and margin changes clear the 60-second cache for the connection (`forgetBurndown(id?)`). In 60 s the ceiling moves less than 0.1 points.

## Changes

- `server/src/db.ts`: append one migration:
  ```sql
  -- Weekly burndown per Claude subscription (#142).
  ALTER TABLE connections ADD COLUMN burndown INTEGER NOT NULL DEFAULT 0;         -- the weekly limit follows the burndown
  ALTER TABLE connections ADD COLUMN burndown_margin REAL NOT NULL DEFAULT 3;     -- target = 100 - margin; adjusted weekly
  ALTER TABLE allowance_samples ADD COLUMN active INTEGER;  -- this connection's agents in their claude step at the reading; null on older rows
  ALTER TABLE allowance_samples ADD COLUMN ceiling REAL;    -- the burndown ceiling at the reading (on or off); null without a weekly reading
  ALTER TABLE allowance_samples ADD COLUMN burndown INTEGER; -- the burndown was on at the reading; null on older rows
  ALTER TABLE allowance_samples ADD COLUMN bound TEXT;      -- which term set the ceiling: linear, catchUp, userCap, target
  CREATE TABLE burndown_weeks (
    connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    resets_at INTEGER NOT NULL,       -- the weekly window's end, epoch ms
    enabled INTEGER NOT NULL,
    final_pct REAL,
    held_hours REAL NOT NULL,
    blocked INTEGER NOT NULL,
    margin_before REAL NOT NULL,
    margin_after REAL NOT NULL,
    other_per_hour REAL,              -- U
    workshop_per_hour REAL,           -- M
    five_per_hour REAL,               -- f
    PRIMARY KEY (connection_id, resets_at)
  );
  ```
- `server/src/burndown.ts` (new, pure; no DB, no clock): the constants (`CATCH_UP_SHARE = 0.75`, `USER_SAFETY = 1.5`, `RUN_GRACE_PCT = 2`, the priors, `MIN_RATE_HOURS = 2`, `MAX_PAIR_GAP = 2 h`), `learnRates`, `allowedHours(from, to, settings)` (uses `withinHours` from `scheduler/gates.ts`), `burndownCeiling`, `nextMargin`, and `heldHours(readings)`.
- `server/src/providers/index.ts`: `Row` and `Connection` gain `burndown: boolean` and `burndownMargin: number`. Add `setBurndown(id, on)` and `setBurndownMargin(id, margin)`. Both publish `allowance`.
- `server/src/allowance.ts`:
  - `burndownOf(connectionId, limits?)` (cached) builds `Burndown` from the readings, the connection, `getSettings()` and the latest weekly reading;
  - `allowanceOf` adds `burndown`;
  - `recordProbe` writes `active` (`SELECT COUNT(*) FROM runs WHERE model_connection_id = ? AND status = 'running' AND step = 'run'`), `ceiling`, `burndown` and `bound`, and calls `forgetBurndown(id)` only when the weekly `resetsAt` changed;
  - `allowanceSamples` also returns `ceiling` and `burndown`;
  - new `closeWeeks(now)` and `burndownWeeks(connectionId, n = 8)`;
  - export `weeklyLimit(a: AllowanceView, running = false)`, the effective weekly limit, so the gates, the runner and `spend.ts` agree.
- `server/src/scheduler/gates.ts`: `thresholdBlock(w, limits, s, now, burndown: number | null = null)` compares the weekly reading with `min(limits.weekly, burndown)`. When the burndown is the lower line, the reason reads `Weekly allowance at 52%, over the burndown ceiling of 50%, resets Sat 10:00`. `allowanceBlock` passes `a.burndown.enabled ? a.burndown.ceiling : null`.
- `server/src/scheduler/runner.ts`, `overThreshold`: pass the stored view's ceiling plus `RUN_GRACE_PCT` (when enabled and not null) to both `thresholdBlock` calls.
- `server/src/scheduler/loop.ts`, on the 60-second tick:
  - call `closeWeeks(Date.now())` and `kick()` if a margin changed;
  - probe idle subscriptions (unpaused, with a subscription token, latest reading older than `IDLE_SAMPLE_MS`, or older than 15 minutes within 30 minutes of the weekly reset; `probeAllowance(id)`, which already de-duplicates and backs off on failure);
  - add `Math.floor(ceiling)` per connection to the `blocks` fingerprint, so `clockTopics` publishes `allowance` as the line moves.
- `server/src/spend.ts`:
  - the Usage history adds `burndown` and `weeks` to each `AllowanceHistory`;
  - `windowProjection` for the weekly window uses `min(weekly, target)` when the burndown is on, not the moving ceiling: "reaches your 54% limit in 2 hours" means nothing when the line keeps rising;
  - the backlog `drain` sizes weekly windows with `min(weekly, target)` when the burndown is on, since the line reaches its target at each reset.
- `server/src/http/api.ts`, `PUT /usage/limits/:connectionId`: accept an optional `burndown` (when present, it must be a boolean: `check(b.burndown === undefined || typeof b.burndown === 'boolean', 'Say whether this subscription should follow the weekly burndown.')`; absent leaves it as it is), call `setBurndown`, clear the cache and `kick()` (already there). `PUT /settings` calls `forgetBurndown()`.
- `server/src/http/openapi.ts`:
  - a `Burndown` schema, plus `burndown` on `AllowanceView` and `AllowanceHistory`, `ceiling` on the samples and `weeks`;
  - the `/usage/limits/{connectionId}` body gains `burndown: bool`, and its summary mentions it.
- `docs/api.md`: the limits example and a paragraph on `burndown`.
- `server/AGENTS.md`: add the `burndown.ts` row to the map, and a line in the run lifecycle on the 2-point grace.
- `client/src/components/ui.tsx`, `Meter`:
  - a new optional `burndown?: number | null` prop renders a second mark `.meter-mark.burndown` (`border-left: 2px dotted var(--text)`, no background);
  - `over` compares with the lower of the two lines;
  - the title reads `Solid line: your limit, 80%. Dotted line: the burndown, 54% now, rising to 97% by the reset. No new agents start above the lower one.`;
  - the aria label mentions both.
- `client/src/theme.css`: the `.meter-mark.burndown` style.
- `client/src/components/Layout.tsx`: pass `burndown={a.burndown.enabled ? a.burndown.ceiling : null}` to the weekly meter.
- `client/src/pages/Settings.tsx`:
  - per subscription, below the two limit fields, a checkbox **Follow the weekly burndown**, with help text: `Workshop raises this subscription's weekly limit through the week, so usage reaches about {target}% when it resets. Your weekly limit above still caps it: set it to 100% to let the burndown decide. Now {ceiling}%.` (or `Needs a reading from this week.`). When the set weekly limit is below the target, add: `Your weekly limit of {weekly}% stops it first.` The default limit is 80%, so turning the toggle on alone would otherwise look like it does nothing late in the week;
  - the draft type becomes `Limits & { burndown: boolean }`, and save compares `burndown` too.
- `client/src/pages/Usage.tsx`, `SubscriptionUsage`:
  - when the burndown is on, a third series, **Burndown**, drawn from the samples' `ceiling`, plus a `Burndown ceiling {n}%` mark;
  - the weekly projection sentence names the target instead of the set limit when the burndown is on and the target is lower (`Reaches the {target}% burndown target at …`);
  - under the chart, one sentence: `Burndown {ceiling}% now ({bound in words, e.g. "rising evenly", "raised to catch up", "held for your own use"}), aiming for {target}% at the reset. Your own use about {U×24}% a day ({hours} hours of readings); agents add about {M}% an hour while running, {d×100}% of the time under your 5-hour limit.`;
  - a compact table of `weeks`: Reset, Ended at, Held back, Margin, with burndown on or off. These are the numbers to tune from.
- `client/src/projections.ts`: the weekly line uses `min(weekly, target)` when the burndown is on, matching the server.

## Data and interfaces

`server/src/api-types.ts`:

```ts
/** A subscription's weekly burndown: a weekly limit that rises to `target` by the reset. */
export interface Burndown {
  enabled: boolean;
  /** Where weekly usage may reach now (percent); null without a reading from the current week. Computed when off too. */
  ceiling: number | null;
  /** What it aims for at the reset: 100 minus a margin Workshop adjusts each week. */
  target: number;
  /** Weekly percentage points per hour: use that isn't Workshop's agents, and the agents' own while running (null until known). */
  otherPerHour: number;
  workshopPerHour: number | null;
  /** Share of the time the 5-hour limit lets agents run, 0 to 1; null until known. */
  duty: number | null;
  /** Which term set the ceiling now; null with no ceiling. */
  bound: 'linear' | 'catchUp' | 'userCap' | 'target' | null;
  /** Hours of readings behind otherPerHour and workshopPerHour. */
  basis: { otherHours: number; workshopHours: number };
}
export interface BurndownWeek { resetsAt: number; enabled: boolean; finalPct: number | null; heldHours: number; blocked: boolean; marginBefore: number; marginAfter: number }
```

- `AllowanceView.burndown: Burndown`. Update the `limits` comment: the weekly limit applies as `min(limits.weekly, burndown.ceiling)` when the burndown is on.
- `AllowanceHistory` gains `burndown: Burndown` and `weeks: BurndownWeek[]` (newest first, up to 8). `samples[]` gains `ceiling: number | null` and `burndown: boolean | null`.
- `PUT /api/usage/limits/:connectionId` body: `{ fiveHour?, weekly?, burndown?: boolean }`. A non-boolean `burndown` gets 400; leaving it out keeps the current setting.

## Tests

- `server/test/burndown.test.ts` (new, pure; fixed clocks):
  - `burndownCeiling`: a reading whose weekly reset has passed gives a ceiling near 0 for the new week, not null; reports the right `bound` for each term;
  - `burndownCeiling`: 0 at the week's start and `target` at the reset with no rates; rises monotonically for fixed rates; `catchUp` lifts it under restricted hours or a low duty cycle; `userCap` lowers it for heavy own use; clamped to [0, target]; ignores `catchUp` without enough data.
  - `learnRates`: idle and busy pairs are classified; pairs that are mixed, `null`, far apart, falling or across a reset are skipped; the prior dominates with little data; `f` comes only from pairs in the same 5-hour window.
  - `allowedHours`: always, scheduled (including overnight spans and DST through `withinHours`), paused counts as always.
  - `nextMargin`: overshoot +2 up to 10, held-and-low −1 down to 1, otherwise unchanged; off weeks unchanged.
  - `heldHours`: only counts readings with the burndown on.
- `server/test/gates.test.ts`: `thresholdBlock` with a burndown below and above the set limit (the reason names the right line); `allowanceBlock` ignores both lines with `ignoreLimits`.
- `server/test/pipeline.test.ts` (providers mocked):
  - with the burndown on and the reading between the ceiling and the ceiling + 2, a queued ticket doesn't launch, but a running agent keeps going;
  - above the ceiling + 2, it pauses at a turn boundary (`threshold`), and resumes once the reading falls under the ceiling;
  - a ticket with `bypass_limits` launches over the line;
  - `closeWeeks` writes one row per ended window and changes the margin; a week with the burndown on for only a minority of readings is `enabled = 0` and keeps the margin;
  - the tick probes a subscription idle for over 60 minutes, and one idle for 20 minutes within 30 minutes of its weekly reset;
  - `recordProbe` stores `active`, `ceiling`, `burndown` and `bound`; a run's readings don't re-read the rates (the rates cache survives them);
  - with a fresh reading from before the weekly reset, a queued ticket doesn't launch with the burndown on.
- `server/test/api.test.ts`: `PUT /usage/limits/:id` with `burndown: true` returns `burndown.enabled`, a non-boolean gets 400, and a body without `burndown` leaves it on; the OpenAPI route test still passes.
- Browser check (Playwright, both themes, desktop and 760 px): seed a subscription with readings and the burndown on. Screenshot the top-bar weekly meter with both marks, the Settings toggle and the Usage chart with the Burndown series. Save the screenshots to `/work/media/`.
- Run `npm run typecheck` and `npm test`.

## Risks and open questions

- **Own-use bias.** `U` comes only from idle hours. If the owner uses Claude mostly while agents run, or mostly at night outside operating hours, `U` is off. `userCap` and the margin feedback soften this, and `burndown_weeks` plus the `ceiling` and `active` columns give the owner the data to retune `USER_SAFETY`, `CATCH_UP_SHARE` and the priors. These are code constants for now, not settings. Exposing them would add knobs the owner said they want to stop managing.
- **The idle probe costs a little usage** (about 24 one-turn probes a day per subscription). It shows up in `U` as noise.
- **The 2-point grace** means usage can end up to about 2 points over the line, plus whatever the turns in flight use. That's within "it's okay to go over a little". The margin adapts if weeks end over 100%.
- **`resetsAt` jitter.** Readings are grouped into weekly windows with a 1 h tolerance. If Claude moves a reset by more, a week may close early with a partial `final_pct`. That's harmless apart from one noisy margin step.
- **The 5-hour limit stays hand-set.** The ticket only asks to automate the weekly limit.
- **`M` depends on how many agents run at once.** It's averaged over busy pairs at whatever concurrency they had, so `catchUp` assumes the recent mix of slots and backlog continues. Changing host slots shifts it until 14 days of new readings replace the old ones.
- **The idle probe runs in `paused` mode and outside operating hours too.** That's where most of the idle readings for `U` come from. Pausing the subscription itself stops it.

## Review

Design review, checked against the code on `main` (`allowance.ts`, `scheduler/gates.ts`, `runner.ts`, `loop.ts`, `projection.ts`, `spend.ts`, `client/src/projections.ts`).

1. **A reading from just before the weekly reset left the week unguarded.** `used()` in `gates.ts` counts a window whose `resetsAt` has passed as 0%, and `allowanceBlock` only re-checks readings older than 10 minutes. The design made the ceiling null "without a reading from the current week", and a null ceiling falls back to the set limit. So for up to 10 minutes after each reset, every free slot could launch against an 80% limit, which is the day-1 burn the ticket is about. **Fix:** roll the reset forward by whole weeks and count the reading as 0%, so the ceiling is near 0, not null. **Adopted** (The ceiling; tests).
2. **The week's `enabled` flag and `held_hours` couldn't be computed.** Samples stored the ceiling whether the burndown was on or off, and nothing recorded when the toggle was on. A week where the toggle was switched on on its last day would adjust the margin, and so would hours "held" while it was off. **Fix:** a `burndown` column per reading. A week counts as on when most of its readings were, and `held_hours` only counts those. **Adopted.**
3. **Cache invalidation on every reading defeated the cache.** Running agents call `recordProbe` whenever their usage reading changes, which happens on nearly every reply because of the 0.1-point precision. The design had `recordProbe` clear the burndown cache, so the rates over 14 days of readings would have been re-read many times a minute. The ceiling doesn't depend on the latest percentage, only on the weekly `resetsAt`. **Fix:** clear only the 60-second cache, and only when `resetsAt` changes. Never clear the rates on a reading. **Adopted.**
4. **The projection against a moving line is misleading.** `windowProjection` computes when the window reaches its limit at its average pace. Measured against the current ceiling, it would say "reaches your 54% limit at 14:00" even though the line will be higher by then. **Fix:** project the weekly window against `min(weekly, target)` on the server and in `client/src/projections.ts`, and name the burndown target in the sentence. **Adopted.**
5. **`final_pct` could be an hour stale.** Margin feedback is based on how the week ended, but with an idle probe every 60 minutes the last reading could be from up to an hour before the reset. **Fix:** also probe in the 30 minutes before a weekly reset if the latest reading is older than 15 minutes. That adds about 2 probes a week. **Adopted.**
6. **Turning the toggle on with the default 80% weekly limit looks broken.** The effective limit is `min(80, ceiling)`, so from about day 5 on, the burndown has no effect and the dotted line passes the solid one. The owner's goal is to stop managing weekly limits. **Fix:** the Settings help text says `Your weekly limit of 80% stops it first.` whenever the set limit is below the target. I considered raising the limit to 100% automatically when the toggle goes on, but rejected it: it silently changes a limit the owner set. **Adopted (the help text).**
7. **There was no way to tell which assumption was wrong.** The margin is the only thing that adjusts itself. If a week ends low because `userCap` held agents back (the owner's use was overestimated), or because `catchUp` lifted the line too little, the readings didn't show which term was responsible. **Fix:** store `bound` (the term that set the ceiling) with each reading and in the `Burndown` view, and say it in words on the Usage page. **Adopted.** I also considered learning `CATCH_UP_SHARE` and `USER_SAFETY` per subscription from closed weeks. **Not adopted:** with one data point a week, two more feedback loops would take months to settle and could fight the margin. The stored `bound` and `held_hours` are what's needed to decide that later.
8. **`burndown` was required in `PUT /usage/limits`.** The check `typeof b.burndown === 'boolean'` would make existing callers that only send `fiveHour`/`weekly` (the API is documented in `docs/api.md`) get a 400. **Fix:** the field is optional, and leaving it out keeps the current setting. **Adopted.**
9. **Could an agent's use between two idle readings be counted as the owner's?** It looked like it, because `active` is only sampled at the endpoints. I checked: the runner's `recordUsage` writes a reading whenever an agent's usage changes, so any agent activity puts `active > 0` readings between the idle ones, and those pairs are skipped. **No change.** The reasoning is now in "Learning the rates" so the implementer doesn't "fix" it.
10. **`M` depends on concurrency.** Workshop's weekly rate scales with how many agents run at once, so `catchUp` assumes recent slot counts. **Not adopted** as a model change: modelling the rate per agent would need slot history, and the error only makes `catchUp` lift too early or too late, which the margin and `bound` make visible. It's listed under Risks.
11. **Should running agents ignore the burndown entirely?** That's simpler, and it would avoid restarting cached sessions. **Not adopted:** with several agents at about 1 point an hour each, a few long runs could carry usage well past the line late in the week. The ticket allows going "over a little", not unbounded. The 2-point grace is the compromise, and paused runs resume with no grace, which gives about 3 hours of hysteresis at the normal slope.
12. **Idle probes in `paused` mode.** Hourly `claude -p` probes continue while the scheduler is paused. **Not adopted** as a change: those are the readings `U` depends on, and the cost is tiny. Pausing the subscription stops them. Listed under Risks.
