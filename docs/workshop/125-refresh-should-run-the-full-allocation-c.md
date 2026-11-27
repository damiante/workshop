# 125 — Refresh runs the full allocation cycle

## Context

**Refresh** (`POST /api/refresh` → `refreshNow()` in `server/src/scheduler/loop.ts`) should mean "run the allocation process now". It doesn't:

- `refreshNow()` starts the allowance probes and calls `kick()` without waiting for them. The tick it triggers sees "Checking allowance" and starts nothing on those subscriptions.
- A tick starts at most two agents: one from the early queue and one after the sync (`find(...)` → `startCandidate`). With 9 free slots and 823 ready tickets, one agent was running minutes after a refresh.

Outcome:

- Every tick, the regular one and the one Refresh triggers, keeps starting the best ready candidate until no ready candidate fits a free slot.
- Refresh waits for its allowance probes (with a timeout) and then runs another allocation pass. A candidate held only by "Checking allowance" starts in the same Refresh once its probe succeeds.

## Approach

1. **An allocation loop.** A new exported `allocate(s, now)` in `loop.ts` rebuilds the queue, starts the first unblocked candidate, and repeats. It returns the last queue it built. `launch()` inserts the run row (`starting`) synchronously, so the next `buildQueue` → `hostLoads()` already counts that slot. Pools are never over-committed, and `pickHost` spreads runs across hosts as it does now. Rebuilding the whole queue also keeps every other gate exact (one agent per ticket, host busy, per-size pools). Patching a cached queue would duplicate that logic.

   ```ts
   /** Starts the best ready candidate again and again, until no ready one fits a free slot. Returns the last queue built. */
   export function allocate(s: Settings, now: number): Candidate[] {
     const tried = new Set<number>();
     for (;;) {
       const queue = buildQueue(s, now);
       const next = queue.find((c) => !c.blockedBy && !tried.has(c.ticket.id));
       if (!next) return queue;
       tried.add(next.ticket.id);
       startCandidate(next);
     }
   }
   ```

   `tried` guarantees the loop ends even if `launch()` returns null (unique-index conflict). Once a ticket has a run, `activeRunId` drops it from the queue anyway. The loop ends when every remaining candidate is blocked, including "Every agent host is busy or offline" once every pool its size uses is full.

2. **The tick uses it in both places.** In `tick()`, replace the early `early.find(...)`/`startCandidate` with `const early = allocate(getSettings(), Date.now())`. Replace the post-sync `queue.find(...)`/`startCandidate` with `const queue = allocate(s, now)`. `probeStale` and the `clock` queue keep using the returned queues. They now describe the state after the starts, which is what the dashboard should show. The early pass still fills slots before a slow sync. `resumePaused` stays before the post-sync allocation, so resumed runs keep their slots first.

3. **Refresh waits for its probes, then allocates.**

   ```ts
   const REFRESH_PROBE_WAIT_MS = 150_000; // a probe gives up after 120 s of output; allow for starting it

   export async function refreshNow() {
     lastSync.clear();
     probeFailedAt.clear();
     ...
     const checks = ...map((a) => probeAllowance(a.connectionId, true).catch(() => {}));
     kick(); // sync and fill slots with what's already startable while the checks run
     if (!checks.length) return;
     await withTimeout(Promise.all(checks), REFRESH_PROBE_WAIT_MS).catch(() => {});
     await tick(); // allocate again with the new readings
   }
   ```

   If a tick is already running, `tick()` sets `again` and returns. That tick then re-runs, and the re-run allocates fully. This covers "Refresh during a running tick". A probe that finishes after the timeout still calls `kick()` on success, as it does today, so its candidates start then.

4. **Await probes already in flight.** `probeAllowance` returns at once when `probing.has(id)`, so Refresh "waits" for nothing when the timer's probe is already running. Change `probing` from a `Set<number>` to a `Map<number, Promise<…>>`. A caller that finds a probe in flight gets the same promise. Move the current body after the `probing` check into an inner function, and store and delete its promise in `probing`. The `force`/`probeFailing` early return stays before the lookup, and existing `void probeAllowance(...).catch(() => {})` callers are unaffected.

## Changes

- `server/src/scheduler/loop.ts`: `allocate` (exported, for tests), the two call sites in `tick()`, `REFRESH_PROBE_WAIT_MS` and the new `refreshNow` tail, `probing` as a map of promises. Update `refreshNow`'s doc comment: it resolves after the post-probe allocation pass.
- `server/AGENTS.md`: map row for `loop.ts`: "the queue, launch one" → "the queue, fill every free slot".
- `docs/design/workflow.md` line 45: replace "Agents start one at a time, a scheduler tick apart, so allowance readings catch up between launches." with: each pass starts agents until no ready ticket fits a free slot, and runs over a subscription's limits pause at their next turn boundary.
- `docs/api.md` (`POST /api/refresh` paragraph) and the `/refresh` summary in `server/src/http/openapi.ts`: say that Refresh waits up to about 2.5 minutes for the usage checks, then starts agents in every free slot that a ready ticket fits. It still answers 202 at once.

## Data and interfaces

No schema, setting or HTTP shape changes. `POST /api/refresh` still returns 202 immediately (`void refreshNow()`).

## Tests

In `server/test/pipeline.test.ts` (providers mocked). Add tickets 2..n with `INSERT INTO tickets` like the fixture at line 104, and remove them and their runs afterwards so other tests keep a single ticket.

- **Multi-start per pass.** Give the host 3 standard slots and insert 4 ready tickets with a fresh allowance reading (`recordProbe` under the thresholds). Call `allocate(getSettings(), Date.now())`. Expect 3 runs `starting` and the 4th ticket blocked with "Every agent host is busy or offline" in the returned queue.
- **Pools respected.** With one standard slot already busy (a `launch`ed run) and 2 free, only 2 more start.
- **Wait for the probe.** Make no allowance reading for `ids.model`, so candidates read "Checking allowance". Use a `FakeEnv` whose usage probe answers `[RATE, result({})]`, give the host 2 slots, and add 2 ready tickets. `await refreshNow()`. Expect a probe container started and 2 runs started when it resolves. `tick()` runs checkHosts and sync against the fakes. Confirm that `fake.tickets` and `fake.vcs` handle a sync, and stub any missing method in the test.
- **In-flight probe is shared.** Start `probeAllowance(ids.model, true)` without awaiting it, then call it again. Expect one probe container, and the second call resolves with the same reading.
- The existing `refresh` tests (line 1080) must still pass.

Run `npm run typecheck` and `npm test`.

## Risks and open questions

- **Allowance between launches.** Starting many agents at once on one subscription drops the "readings catch up between launches" spacing. This is what the ticket asks for. Usage past the limits is still caught at each run's turn boundary (threshold pause), and the gate still fails closed without a fresh reading.
- **Cost of `buildQueue` per start.** It reads every open ticket (hundreds) each time, at most once per free slot plus once per pass. That's a few tens of rebuilds at most, all synchronous SQLite work. Acceptable. If it shows up in profiles, cache `priorityGraph()` across iterations.
- **Early pass on pre-sync data.** It now fills every slot from the last-synced labels instead of one. The same staleness already applied to that one start, and the early pass exists so a slow sync can't leave hosts idle.
- **Timers in tests.** `refreshNow`'s `kick()` schedules a tick 500 ms later, as it does today. Tests that assert run counts should do so right after `await refreshNow()`, or clean up the runs that a later kicked tick starts.
