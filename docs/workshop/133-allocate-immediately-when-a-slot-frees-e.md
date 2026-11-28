# Allocate immediately when a slot frees, even while a GitHub sync is running (#133)

## Context

`tick()` in `server/src/scheduler/loop.ts` does everything in one pass behind one flag (`ticking`): host checks, re-attach, an early `allocate`, the whole GitHub sync (`await syncRepos()`), merges, resuming paused runs, a second `allocate`, cleanup and clock topics. `kick()` (called by `onRunSettled`, settings changes, probes, hosts coming back) just schedules another `tick()`. If a pass is already running, that call only sets `again = true`. For a big repository the sync takes minutes, so a freed slot stays empty until the sync ends (observed: two small slots idle for about 2.5 minutes with 807 ready tickets).

Outcome: allocation (which uses only the local DB) runs as soon as it's kicked, whether or not a sync is running. The sync keeps its `pollMinutes` cadence and triggers an allocation pass when it ends.

## Approach

Split the tick into two serialised passes, each with its own mutex:

- **Allocation pass** (`allocatePass`): local work only, no GitHub calls: `reattachRuns`, `settleManual`, `resumePaused`, `allocate`, `probeStale`, and the clock topics. `kick()` runs this pass and nothing else.
- **Sync pass** (`syncPass`): `syncRepos()` (per-repo `pollMinutes` gating, as today), then `mergeApproved(...)`, then `await allocatePass()` so new tickets and changed labels are picked up straight away.
- **`syncSoon()`** (settings saves, POST /sync, repo and connection changes): starts an allocation pass straight away and then the sync, like `refreshNow`. Its callers often free capacity (unpausing, adding slots, changing hours or ticket order), and before this change `tick()` allocated before syncing, so these saves must keep filling slots at once rather than after a full re-sync.
- **Timer `tick()`**: `await checkHosts()`, `await allocatePass()`, start `syncPass()` without awaiting it, then the daily cleanup. Because the sync isn't awaited, a long sync never delays the next tick's allocation.

Both passes use one small helper, so the overlap and re-run rules live in one place:

```ts
/**
 * Runs `pass` one call at a time. A call made while it runs queues exactly one more run (however many
 * calls arrive), and every caller's promise resolves once the queue is drained.
 */
function serial(pass: () => Promise<void> | void): () => Promise<void> {
  let running: Promise<void> | null = null;
  let again = false;
  return () => {
    if (running) {
      again = true;
      return running;
    }
    running = (async () => {
      try {
        do {
          again = false;
          try {
            await pass();
          } catch (err) {
            console.error('[scheduler]', err);
          }
        } while (again);
      } finally {
        running = null;
      }
    })();
    return running;
  };
}
```

Every `await pass()` yields at least once, so `running` is set before the loop checks `again`. Nothing inside a pass calls a pass synchronously (`kick` goes through `setTimeout`), so a nested start can't happen. The re-run happens inside the same promise. That means `await allocatePass()` (used by `refreshNow`, `syncPass` and tests) resolves only after any re-run it caused.

### Interleaving that becomes possible

Before this change, no allocation ran during the sync's `await`s. Now one can. Local writes are synchronous statements, and `editLabels` updates the local mirror in one step, so every label move (reviews, merges, closes) is atomic as allocation sees it. The one real gap is in `syncRepo`. A changed ticket is upserted with its new labels and `blocked_by = '[]'`, and its blockers are read later in `syncBlockers`. An allocation pass in between could launch a ticket that is about to be held. Close it with an in-memory set in `sync.ts`:

- `export const checkingBlockers = new Set<number>()`.
- In the upsert loop of `syncRepo`, right after the upsert and in the same synchronous step: if `t.state === 'open' && t.openBlockers` and the stored row's `blocked_by === '[]'` (the same test `syncBlockers` uses for `fresh`), add the row id.
- In `syncBlockers`, delete the id once that ticket's read finishes (success or failure), and in a `finally` in `syncRepo` delete every id this call added, so a rate-limited or failing sync doesn't leave tickets held for good. That matches today's behaviour after a rate limit.
- In `buildQueue`: `dependencyBlock(blockersOf(t)) ?? (checkingBlockers.has(t.id) ? 'Checking what it depends on' : null) ?? githubBlock…`.

## Changes

**`server/src/scheduler/loop.ts`**
- Remove `ticking` and `again`. Add `serial` (above).
- `async function allocateOnce()`: `reattachRuns(); settleManual();` then `const s = getSettings(), now = Date.now()`, `resumePaused(s, now)`, `const queue = allocate(s, now)`, `probeStale(queue)`, then the existing `clockTopics` and `clock` block. Export `allocatePass = serial(allocateOnce)`.
- `async function syncOnce()`: `await syncRepos(); await mergeApproved(getSettings().mode === 'paused'); await allocatePass();`. Define `syncPass = serial(syncOnce)` (not exported).
- `kick()`: `setTimeout(() => void allocatePass(), 500)`. Keep the delay: it lets a settling run finish its writes, and it is well inside "within seconds".
- `syncSoon()`: `lastSync.clear(); void allocatePass(); return syncPass();`. The allocation pass comes first so it never waits for GitHub; the sync then allocates again when it ends. If a sync is running, `syncPass()` queues its one re-run, which then syncs every repo. Callers keep ignoring the result. Doc comment: "Fills free slots now, then syncs every repository (or right after the sync that's running) and allocates again." 
- `tick()` (timer and tests):
  ```ts
  export async function tick() {
    try {
      await checkHosts();
      await allocatePass();
      void syncPass(); // GitHub runs on its own: a long sync never holds allocation back
      const now = Date.now();
      if (now - lastCleanup > 24 * 3600_000) {
        lastCleanup = now;
        await cleanup(getSettings());
      }
    } catch (err) {
      console.error('[scheduler]', err);
    }
  }
  ```
  Timer ticks can overlap only in `checkHosts` (15 s timeout per host, every 60 s). That was harmless before the old flag existed and stays harmless: pings are idempotent. The passes themselves are serialised.
- `startScheduler()`: unchanged apart from the initial `kick()`, which becomes `void tick()`. A fresh boot should check hosts, sync and clean up, and this keeps the behaviour the old first tick had.
- `refreshNow()`: replace `kick()` with `void syncPass(); void allocatePass();` (keep the comment, reworded). Replace the final `await tick()` with `await allocatePass()`. Update the doc comment: the sync runs in the background and allocates again when it ends; Refresh resolves after the allocation pass that follows the allowance checks.
- Delete the old comments about the early allocation ("What's already known to be ready starts first…", "before the sync too…"). The split replaces them.

**`server/src/scheduler/sync.ts`**: add `checkingBlockers` as described. Update the `syncBlockers` doc sentence "reads are one at a time, and the scheduler waits for them" to say that allocation doesn't wait for them, and that tickets not yet read are held as "Checking what it depends on".

**`server/AGENTS.md`**
- Map row for `src/scheduler/loop.ts`: "Two serialised passes: allocation (re-attach, settle hand pushes, resume paused runs, the queue, fill every free slot, usage probe, clock topics) runs on every `kick()`; sync (GitHub sync, API merges, then allocation) runs on the 60-second tick, which also checks hosts and cleans up."
- In the `onRunSettled` bullet, add that `kick()` runs only the allocation pass, so it never waits for a GitHub sync.

## Data and interfaces

No schema, API or settings changes. New exports: `allocatePass` from `loop.ts` and `checkingBlockers` from `sync.ts`. `syncSoon` now returns a promise. One new queue reason, `Checking what it depends on`, appears in the Queue view as-is.

## Tests

Add these to the `allocation` describe in `server/test/pipeline.test.ts` (import `allocatePass`, `kick`, `syncSoon` from `loop.ts` and `checkingBlockers` from `sync.ts`). Use a deferred promise for the slow GitHub call: `let release!: () => void; const gate = new Promise<void>((r) => (release = r));`.

Tests in the `while a GitHub sync is running` describe keep the sync they start in a describe-level `let sync: Promise<unknown>` (reset to `Promise.resolve()` in `beforeEach`), and `afterEach` does `release(); await sync;` instead of `await syncSoon()`, because `syncSoon()` now allocates and would start runs during teardown.

1. **Freed slot reused before a slow sync completes** (acceptance 1 and 3). `configure(1)`. Set `fake.tickets.listChanged = async () => { await gate; return []; }`. Register `onRunSettled(kick)` and restore `onRunSettled(() => {})` in a `finally`. Run `await tick()`: one run starts, and the sync is now stuck in `listChanged`. Then `await settle(<that run>)`, wait about 700 ms, and expect a second run to have started while `release` hasn't been called. Then `release()`, `await syncSoon()` and clean up. Before the fix, this test fails because no second run starts until the sync ends.
2. **Passes don't overlap, and kicks coalesce into one re-run** (acceptance 2). `configure(3)`. Delete tickets 21 and 22 so only ticket 20 is ready. `const a = allocatePass()` starts ticket 20 synchronously. Insert ticket 21 (ready), then `const b = allocatePass(); const c = allocatePass();`. Expect `b` and `c` to be the same promise as `a`. After `await a`, expect exactly two runs (ticket 21 was picked up by the single re-run), and expect a following `allocatePass()` to return a new promise.
3. **A newly blocked ticket isn't launched mid-sync.** `listChanged` returns ticket 20 with `openBlockers: 1` and its current labels, and `fake.tickets.blockers` waits on `gate` before returning one open blocker. Start the sync with `sync = syncRepo(getRepo(1)!)`, not `syncSoon()`: ticket 20 is already ready in the DB, so `syncSoon()`'s up-front allocation would start it before the sync sees it, which is correct behaviour but defeats the test. Then yield and yield (`await new Promise((r) => setImmediate(r))`) until `checkingBlockers` holds ticket 20's id. Then expect `buildQueue()` to give ticket 20 `blockedBy: 'Checking what it depends on'`, and expect `allocate(...)` not to start it. `release()`, await the sync, and expect the reason to be `Depends on …` and `checkingBlockers` to be empty.
4. **`syncSoon()` fills a free slot before the sync completes** (the review finding). `configure(1)`, gated `listChanged` as in test 1. `sync = syncSoon()`; right after the call (the allocation pass has no `await` before `allocate`, so it runs synchronously) expect one run started, and `listChanged` called or pending but `release` not yet called. Then `release(); await sync;`. Fails against `syncSoon() { lastSync.clear(); return syncPass(); }`, which starts nothing until the sync ends.
5. Existing tests ("fills every free slot on a regular tick", the Refresh tests) must keep passing unchanged. Because `tick()` no longer awaits the sync, give any test that asserts sync effects after `await tick()` an `await syncSoon()` or a call to `syncRepo` directly. Today only these allocation tests call `tick()`.

Run: `npm run typecheck && npm test`.

## Risks and open questions

- **Background syncs in tests.** `tick()` now leaves a sync running. Tests that stub `listChanged` with a gate must release it and await it (`await syncSoon()`) before `afterEach` changes fakes. The existing 700 ms wait in `afterEach` covers short syncs.
- **Merges wait for a long sync.** `mergeApproved` now runs after `syncRepos` inside the sync pass, so during a 3-minute sync, approved merges wait for it, as they effectively did before. Acceptable: merges are GitHub work, not slot allocation.
- **Re-run after a long sync.** A timer tick during a sync queues one sync re-run. It only syncs repos that are due again, plus merges, so it costs little.
- **`syncSoon()` allocates twice.** Once up front and once after the sync; the second is a no-op when nothing changed. Cheap, local only.
- **Host status freshness.** Kicked passes don't ping hosts and use the status from the last timer tick (at most 60 s old). A host that goes down is still caught by `drive` failing and by the next tick, as before.
