# 134 — Let smaller jobs use idle larger slots (work-conserving placement)

## Context

A candidate only starts in its own pool: `poolFor(host, size)` / `pickHost` in `server/src/scheduler/gates.ts`. So when the small pool is full, hundreds of ready Classifier runs wait while standard slots sit idle (seen: 5 of 7 slots busy with a classification backlog).

Outcome: a smaller agent may take a free slot in a **larger** pool (small → standard → large) when its own pool has none. It never goes the other way. A larger pool's slot is kept for a ready candidate of that pool's size. The run records the pool it holds, so host loads, the overview and resume count it there.

## Approach

**Pools an agent may use on a host.** The own pool key is `size` when the host keeps that pool, otherwise `'standard'` (today's `poolFor` rule). After it come the larger pools the host keeps, in `AGENT_SIZES` order. Examples: small with a small pool gives `[small, standard, large?]`, and small without one gives `[standard, large?]`. Standard gives `[standard, large?]`. Large with a large pool gives `[large]`, and large without one gives `[standard]` (unchanged: a host with no large pool runs large agents as standard). A size with its own pool never lands in a smaller pool.

**Placement (`place`).** Placement works in rounds:
- Round 0 tries every healthy, available host's own pool for the size, as `pickHost` does today (most free, then lowest id).
- Rounds 1 and 2 try the next pool in each host's list.
- The first round that finds a free slot wins.

So a small agent goes to a small slot on any host before it borrows on any host.

**Headroom.** In a borrowing round, pool `P` on host `h` is skipped when some *ready* candidate would use `P` as its own pool on `h`. Ready means its `blockedBy` is null before the host check. `buildQueue` computes the sizes of the ready candidates (`waiting`) first, then places everyone. This "any ready claimant" rule is enough because `allocate` rebuilds the queue after every start. The claimant can always start: `P` has a free slot and is its own pool. On the next rebuild it no longer claims `P`, so a borrower can take any slot that's left. No slot is left idle while borrowers wait, and the larger candidate always wins a contested slot.

**Resume.** A paused run holds no slot. Resuming (`resumePaused`, `resumeNow`) takes the first pool with a free slot on the run's own host, in the order above, with no headroom check. Work already under way goes first, as `stepPriority` does. It writes that pool to `runs.slot`.

**Container limits** still follow `runs.size` (`limitsFor`). A borrowed small run keeps its small CPU and memory limits, which fit inside the larger slot.

**Not doing:** the optional per-host cap on borrowed slots. The headroom rule already gives contested slots to larger work. Classifier runs, the motivating case, are short. A cap would need a new connection field, a form field and its validation. Leave it for a follow-up if long borrowers turn out to starve large work.

## Changes

- `server/src/db.ts`: append to `MIGRATIONS`:
  `ALTER TABLE runs ADD COLUMN slot TEXT; -- small, standard or large: the host pool the run holds (it may borrow a larger one); null on older rows means its size's own pool`
- `server/src/runs.ts`: add `slot: AgentSize | null` to `RunRow`, with a doc comment.
- `server/src/scheduler/gates.ts`:
  - `Pool` gains `borrowed: number`: runs of a smaller size holding slots here. `hostLoads` fills it.
  - Add `slotsFor(h, size): AgentSize[]`: the pool keys described above, own first.
  - Add `freeSlot(h, size): AgentSize | null`: the first key in `slotsFor` with `slots - busy > 0`. Resume uses it.
  - Replace `pickHost` with `place(hosts: HostLoad[], size: AgentSize = 'standard', waiting: AgentSize[] = []): { hostId: number; slot: AgentSize } | null`, which does the rounds and the headroom skip. Add a doc comment that states the rule.
  - Remove `freeSlots` if nothing uses it any more. Keep `poolFor`.
- `server/src/scheduler/loop.ts`:
  - `hostLoads()`: select `environment_id, size, slot, COUNT(*)` grouped by all three. Count each group in `poolFor(host, slot ?? size ?? 'standard')`. This falls back to standard if the host no longer keeps that pool. Add to that pool's `borrowed` when it isn't `poolFor(host, size ?? 'standard')`. Initialise `borrowed: 0`.
  - `hostViews()`: pass `borrowed` through in `pools`.
  - `Candidate` gains `slot: AgentSize | null` ("The host pool it starts in; a larger one than its size's when it borrows").
  - `buildQueue`:
    - Drop the up-front `hostFor` map.
    - In the loop, compute everything except the host, and leave the host block out of `blockedBy` for now.
    - After the loop, set `waiting = out.filter((c) => !c.blockedBy).map((c) => c.size)` and `hostFor = new Map(AGENT_SIZES.map((size) => [size, place(hosts, size, waiting)]))`.
    - For each candidate, set `hostId` and `slot` from `hostFor`. When `blockedBy` is null and there's no placement, set the same "Every agent host is busy or offline" / "No agent hosts connected" message as now.
  - `startCandidate`: pass `slot: c.slot!`.
  - `resumePaused`: replace the `freeSlots` check with `const slot = host?.healthy ? freeSlot(host, size) : null`. When it's null, `continue`. Otherwise do `host.pools[slot]!.busy++` and call `resume(r.id, slot)`.
  - `resumeNow`: same, with the existing 409 message when `freeSlot` is null.
- `server/src/scheduler/runner.ts`:
  - `launch()` takes `slot?: AgentSize` and inserts it. It defaults to the own pool, so callers that pass no slot (tests) behave as today.
  - `resume(runId, slot?)` adds `slot` to its `setRun` when given.
- `server/src/api-types.ts`: `HostView.pools` items gain `borrowed: number` ("Slots here held by smaller agents that borrowed them").
- `server/src/http/openapi.ts`: add `borrowed: int` to the `HostView` pool object.
- `client/src/pages/Dashboard.tsx` (line ~220): show each pool as `${p.busy} of ${p.slots} ${p.size}`, plus ` (${p.borrowed} by smaller agents)` when `borrowed > 0`.
- `README.md` (line 104): replace "A size with slots of its own never borrows a standard slot…" with this: when an agent's own slots are full, it may use a free slot of a larger size (small, then standard, then large), unless an agent of that size is ready to start. Larger agents never use smaller slots.
- `docs/design/architecture.md` ("Host capacity is slots"): add one sentence on borrowing upward and the headroom rule.

## Data and interfaces

- New column `runs.slot` (nullable text). Null means the pool `poolFor(host, size)` picks, so existing rows count as they do now.
- `HostView.pools[].borrowed: number` (API and OpenAPI schema).
- No settings and no connection config changes.

## Tests

Run `npm run typecheck` and `npm test`.

- `server/test/gates.test.ts` ("scheduling helpers"):
  - Rewrite the `pickHost` cases as `place(...)?.hostId`. Add `borrowed: 0` to the `Pool` literals.
  - Change the "never borrows" comment and assertions to:
    - small with its pool full borrows standard (`{ hostId, slot: 'standard' }`), then large once standard is full;
    - a ready `standard` in `waiting` stops small borrowing standard, but not large if large is free and no large is waiting;
    - standard borrows large; large returns null when its pool is full and standard is free;
    - on a single-pool host, every size gets `slot: 'standard'`;
    - an own-pool slot on another host is chosen before borrowing on this one.
  - `slotsFor` and `freeSlot` cover the examples in Approach.
- `server/test/pipeline.test.ts` ("agent sizes", `configure({ smallSlots: 1 })`, with the small slot occupied):
  - **AC1:** only a Classifier ticket is ready. Its candidate is `{ size: 'small', slot: 'standard', blockedBy: null }`. `allocate` starts it, and `runs.slot` is `'standard'`. `hostLoads()` standard is `{ slots: 1, busy: 1, borrowed: 1 }`, and `hostViews()` pools show `borrowed: 1`.
  - **AC2:** a ready standard ticket and a ready small ticket, one free standard slot. The small candidate is blocked and the standard one isn't. `allocate` starts only the standard one.
  - **AC3:** with `largeSlots: 1`, large busy, standard free: an XL implement candidate is still blocked. Its slot is never standard.
  - **Resume:** a manually paused small run, with small full and standard free. `resumeNow` resumes it and sets `runs.slot = 'standard'`. With standard full too, it returns the 409.
  - Check the existing "sizes a queued ticket…" and repository-priority allocation tests still pass. A ready standard candidate keeps holding its slot there, and `toEqual` on `pools` needs `borrowed: 0`.
- `server/test/api.test.ts`: if a hosts-view assertion matches `pools` exactly, add `borrowed`.

## Risks and open questions

- A long borrower, such as a standard Design run in a large slot, can hold that slot after a large candidate becomes ready. The headroom rule only applies at launch. The optional per-host cap is the follow-up if this shows up.
- Resume skips the headroom check on purpose: in-flight work first. A resumed small run may take a standard slot a waiting standard candidate wanted.
- If you remove a pool from a host's config, runs that borrowed it are counted in standard (the `poolFor` fallback), which is what happens today for sized runs.
