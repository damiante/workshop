# Lifetime spend (#30)

## Context

The owner wants to see the lifetime token-equivalent spend on their Claude subscription, the way `npx ccusage` shows it, somewhere out of the way in the web UI.

Workshop already sees the usage of every run it starts. Each `result` line of Claude Code's stream-json carries `usage` and `total_cost_usd`. Claude Code fills in `total_cost_usd` from token prices on subscription billing too, so it is the same "token equivalent" that ccusage reports. `readClaudeLine` parses it and `runAgent` stores it in `runs.input_tokens`, `output_tokens` and `cost_usd`. Three gaps keep this from being a lifetime figure:

1. **Runs don't last.** `cleanup()` deletes finished runs after `retentionDays`, and runs cascade away when their ticket, repo or connection is deleted.
2. **Resumes overwrite.** A run paused by a usage limit and then resumed runs `claude` again. The second result overwrites the first one's tokens and cost.
3. **Nothing adds them up** or shows a total, except `apiSpendSince` for API runs today.

## Approach

- **Data source: Workshop's own runs, from stream-json.** Reading `~/.claude` transcripts the way ccusage does would only find files on the run volumes (`CLAUDE_CONFIG_DIR=/work/.claude`). Those volumes live on remote hosts and are removed after each run, and Workshop never sees the owner's personal Claude Code sessions on their own machines. The `result` line already gives the same numbers for every run, with no new dependency. The page says plainly that it counts Workshop's agents only. For personal use, the owner keeps using ccusage.
- **A ledger table, `spend`, with one row per `claude` invocation** (each container of the `run` step). It has no foreign keys, so cleanup and deletes don't touch it. It stores the model and billing, so totals can be split by model, billing and month. When the table is created, the migration backfills it from the runs still in the database. Spend from runs already deleted can't be recovered.
- **Accumulate instead of overwrite.** For each result, insert a ledger row and add its numbers to the run's columns with `COALESCE(col, 0) + ?`. A resumed run's `RunView` then shows its whole cost, and `apiSpendSince` (the daily API cap) counts it all. This is still re-entrant: re-attaching skips stored log lines, so the same `result` line is never read twice.
- **Show it at the bottom of Settings**, in a read-only "Lifetime usage" panel below API tokens. That page is out of the way and already deals with allowance and billing, so nothing new goes in the sidebar.
- **Serve it from `GET /api/usage/lifetime` on `apiRouter`**, since a script might reasonably want it. Totals are computed on request: the ledger has one row per invocation, so a few thousand rows at most.

## Changes

### `server/src/db.ts`
Append one migration:
```sql
CREATE TABLE spend (
  id INTEGER PRIMARY KEY,
  run_id TEXT NOT NULL,          -- no FK: outlives the run
  ts INTEGER NOT NULL,
  model TEXT NOT NULL,
  billing TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL
);
INSERT INTO spend (run_id, ts, model, billing, input_tokens, output_tokens, cost_usd)
  SELECT id, COALESCE(ended_at, started_at), model, billing,
         COALESCE(input_tokens, 0), COALESCE(output_tokens, 0), COALESCE(cost_usd, 0)
  FROM runs WHERE input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cost_usd IS NOT NULL;
```

### `server/src/spend.ts` (new)
- `recordSpend(r: RunRow, res: { inputTokens?: number; outputTokens?: number; costUsd?: number })`:
  - insert a `spend` row with `Date.now()`, `r.model` and `r.billing`, treating missing numbers as 0;
  - then `UPDATE runs SET input_tokens = COALESCE(input_tokens, 0) + ?, output_tokens = COALESCE(output_tokens, 0) + ?, cost_usd = COALESCE(cost_usd, 0) + ? WHERE id = ?`.
- `lifetimeSpend(timeZone: string): LifetimeSpend`: reads every `spend` row (`ORDER BY ts`) and folds them in JS:
  - `total`, plus one `SpendTotals` per billing mode;
  - `byModel`, sorted by cost descending;
  - `byMonth`, `YYYY-MM` in the settings time zone (use `Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' })`), newest first;
  - `runs` counts distinct `run_id`s;
  - `since` is the first row's `ts`, or null when the ledger is empty.

### `server/src/scheduler/runner.ts`
- `runAgent`: replace the `setRun(r.id, { exit_code, input_tokens, output_tokens, cost_usd })` line with `setRun(r.id, { exit_code: state.exitCode })` followed by `if (res) recordSpend(r, res);`. Leave the rest of the flow as it is. The pause path still records, because the limit-hit invocation's result is stored before the `hitUsageLimit` check.

### `server/src/api-types.ts`
Add `SpendTotals` and `LifetimeSpend` (below).

### `server/src/http/api.ts`
- `apiRouter.get('/usage/lifetime', …)` returns `lifetimeSpend(getSettings().timezone)`.

### `server/src/http/openapi.ts`
- Schemas `SpendTotals` and `LifetimeSpend`.
- Path `'/usage/lifetime'`: `Lifetime token use and token-equivalent cost of Workshop's agent runs, by billing, model and month.`

### `client/src/pages/Settings.tsx`
- A new `LifetimeUsage` component, rendered after `<ApiTokens />`. It calls `useApi<LifetimeSpend>('/usage/lifetime', ['runs'])`; `publish('runs')` already fires when runs end.
- It is a `Panel` titled "Lifetime usage" containing:
  - help text: `Tokens and token-equivalent cost of every agent run Workshop has recorded since {date}. On a subscription this is what the same use would cost on the API, not what you paid. Claude Code you use outside Workshop isn't counted.`;
  - a headline line: `{money(total.costUsd)} · {tokens(in)} in · {tokens(out)} out · {runs} runs`;
  - three compact tables in `.table-wrap`: By billing (Subscription / API), By model, By month. Each has the columns Runs, Input, Output and Cost;
  - an empty state when `since` is null: `No agent runs recorded yet.`
- Use the existing `money` and `tokens` from `format.ts` and `ErrorNote` for errors. No new styles beyond existing table classes.

### Docs
- `docs/api.md`: one curl example, `# Lifetime token use and token-equivalent cost`, `curl $WORKSHOP/api/usage/lifetime …`.
- `server/AGENTS.md`: add `src/spend.ts` to the map ("Lifetime spend ledger: one row per claude invocation, kept past run cleanup").

## Data and interfaces

```ts
export interface SpendTotals {
  runs: number;
  /** Includes cache reads and writes, as runs report it. */
  inputTokens: number;
  outputTokens: number;
  /** Claude Code's token-equivalent cost; for subscription runs it isn't billed. */
  costUsd: number;
}

export interface LifetimeSpend {
  /** Earliest recorded usage; null when nothing is recorded. */
  since: number | null;
  total: SpendTotals;
  subscription: SpendTotals;
  api: SpendTotals;
  byModel: (SpendTotals & { model: string })[];
  /** 'YYYY-MM' in the settings time zone, newest first. */
  byMonth: (SpendTotals & { month: string })[];
}
```

- DB: new `spend` table (migration appended to `MIGRATIONS`, backfilled from `runs`).
- API: `GET /api/usage/lifetime` (read scope is enough, like `/usage`).
- Behaviour change: `runs.input_tokens`, `output_tokens` and `cost_usd` now sum across resumes.

## Tests

Run `npm run typecheck` and `npm test`.

**`server/test/pipeline.test.ts`**
- A successful run (the existing `result` helper, plus `total_cost_usd: 0.25`) leaves one `spend` row with the run's model, billing, 10 input and 5 output tokens, and cost 0.25.
- Pause then resume: the first `run` container emits a usage-limit `result` with usage and cost, and the resumed one emits a success `result`. The run ends with the summed tokens and cost, and `spend` has two rows.
- The ledger survives cleanup. Delete the run (`DELETE FROM runs`, or cleanup with an old `ended_at`) and check that the `spend` rows remain.

**`server/test/api.test.ts`**
- `GET /api/usage/lifetime` on an empty ledger returns `since: null` and zero totals.
- Insert `spend` rows directly: two models, both billings, two months (with one row near a month boundary, whose month depends on `timezone`), and two rows sharing a `run_id`. Check `total`, the per-billing split, the `byModel` order, the `byMonth` keys and order, and the distinct `runs` count.
- It works with a read-scope API token.
- Add `['/usage/lifetime', 'LifetimeSpend']` to the existing `it.each` list that checks responses match their OpenAPI schema fields.

The migration backfill is covered by a test only if `api.test.ts` or `pipeline.test.ts` can easily open a DB at the previous version. Otherwise, check it by hand against a copy of a real database.

## Risks and open questions

- **Scope (owner's call, decided here):** this counts Workshop's runs only, not the owner's own Claude Code use elsewhere. That covers it from Workshop's side. Seeding a starting total from ccusage, or uploading its JSON, could come later if wanted.
- **History before this ships** is limited to runs still retained (`retentionDays`). Older spend is gone.
- **Resumed sessions and `total_cost_usd`:** this design assumes that each `claude -p --resume` invocation reports only its own usage and cost. If a stored run log of a resumed run shows the second `result` repeating the first one's totals, change `recordSpend` to record the difference from the run's stored values. Check this once against a real paused run.
- **Not counted:** runs that end without a `result` line (killed, timed out, lost) and the `usage-probe` sessions. Both are small, and the result line is the only reliable figure.
- **Cost of subscription runs** depends on Claude Code continuing to report `total_cost_usd` under OAuth. If it stops, tokens are still recorded and the cost shows $0.00.
