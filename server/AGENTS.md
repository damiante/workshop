# server/AGENTS.md

The Workshop server: TypeScript run directly by Node 24 (`node src/index.ts`), Express 5, SQLite through `node:sqlite`. One process holds the API, sign-in, the scheduler and the run supervisor.

## Map

| Path | What it does |
|---|---|
| `src/index.ts` | Boot: config, crypto key check, DB migrations, seeds agents, starts HTTP and the scheduler, exits cleanly on SIGTERM |
| `src/config.ts` | Environment variables (fails fast on missing or weak ones) |
| `src/db.ts` | `initDb()`, append-only `MIGRATIONS`, `one`/`all`/`run` helpers |
| `src/crypto.ts` | AES-256-GCM `seal`/`unseal` for stored secrets, TOTP, constant-time compare |
| `src/settings.ts` | Operating settings (one JSON row) plus a key/value store |
| `src/api-types.ts` | Types shared with the client. **No runtime imports.** |
| `src/events.ts` | Topic bus plus SSE helper. `publish('runs')` makes browsers refetch run views |
| `src/alerts.ts` | `raiseAlert` (de-duplicated by kind and ref) and `clearAlert` |
| `src/agents.ts` | Agent-class settings, defaults, suggested models |
| `src/tickets.ts` | Ticket and repo rows, views, `editLabels` (remote first, then local mirror) |
| `src/runs.ts` | Run rows and views, run log files (`DATA_DIR/runs/<id>.jsonl`), live activity |
| `src/allowance.ts` | Usage readings and limit blocks per Claude connection |
| `src/workflow/` | Pure logic: `labels.ts` (state machine `nextStep`), `transitions.ts` (`planTransition`), `prompts.ts` (defaults, protocol, task prompt), `schemas.ts` (result schemas and validation) |
| `src/scheduler/gates.ts` | Pure launch gates: hours and time zone, allowance, API cap, host choice, priority |
| `src/scheduler/loop.ts` | The 60-second tick: host checks, re-attach, sync, API merges, resume paused runs, the queue, launch one, usage probe, cleanup |
| `src/scheduler/runner.ts` | Run lifecycle (`launch`, `drive`, `resume`, `fail`, `stopRun`) |
| `src/scheduler/sync.ts` | Pull changed tickets; check pull requests waiting for review |
| `src/scheduler/merge.ts` | API-first merging, closed and merged pull requests |
| `src/providers/` | `types.ts` (interfaces), `index.ts` (connections, encrypted secrets, cached instances), and `github/`, `docker/`, `anthropic/` |
| `src/http/` | `auth.ts` (password + TOTP, sessions, lockout, Origin check), `api.ts`, `connections.ts`, `util.ts` |

## Run lifecycle

`runs.status`: `starting` (prepare container) → `running` (claude) → `publishing` (push and ticket updates) → `succeeded`. It can also end `failed`, `cancelled` or `lost`, or wait in `paused` for a usage limit to reset.

- `status`, `step` and `container_id` are written before each container starts. `drive(runId)` can therefore pick up any active run after a restart or a lost host, and `loop.reattachRuns` does exactly that. Keep every step re-entrant:
  - `prepare` and `publish` may simply run again;
  - a vanished `run` container is a failure;
  - re-attaching skips log lines already stored for that container (`linesFrom`).
- The unique index `runs_one_active_per_ticket` enforces one agent per ticket (paused runs included). `launch()` returns null on conflict.
- Side effects happen only in `publishRun`, from `planTransition`'s plan. Agents never apply labels.
- `fail()` increments `tickets.failures`. At `MAX_ATTEMPTS` (2) it adds `workshop/failed` plus a comment. Sync resets the count when you remove the label.

## Invariants: don't break these

- **No git credentials in the `run` container.** Tokens go only to `prepare` (read) and `publish` (write), through env vars, never onto the volume. `pipeline.test.ts` checks this.
- **Secrets never reach the browser.** `toView()` masks them. Edits with an empty secret field keep the stored value.
- **Exactly one Claude credential per container** (`launchEnv`): with both set, Claude Code would bill the API key.
- **Fail closed on allowance.** No fresh reading means no subscription launch.
- **Validate at the boundary.** HTTP bodies go through `check`/`int`/`num`; connection forms through `splitValues` against the provider's `fields`; agent results through `parseResult`.
- **Untrusted text stays data.** Only allowlisted authors' issues are synced, and only their comments (plus Workshop's bot) reach prompts.

## Claude Code integration

- The agent image pins Claude Code (`agent/Dockerfile`, `CLAUDE_CODE_VERSION`). Re-check these flags and fields when bumping it:
  - `-p --output-format stream-json --verbose --json-schema … --dangerously-skip-permissions --permission-prompts none --session-id <run id>`;
  - `--resume` for paused runs; `--append-system-prompt-file`; `--max-turns`; `--max-budget-usd` (API billing).
- `CLAUDE_CONFIG_DIR=/work/.claude` keeps the session on the run's volume, so `--resume` works on the same host.
- `readClaudeLine` (in `providers/anthropic/index.ts`) reads:
  - `system/init`;
  - `assistant` (activity text, and `error` such as `authentication_failed`);
  - `system/api_retry`;
  - `rate_limit_event`: `rate_limit_info.unifiedWindows.{five_hour,seven_day}.utilization` (a fraction) and `resetsAt` (epoch seconds), plus `status` and `isUsingOverage`;
  - `result`: `structured_output`, `is_error`, `subtype`, `usage`, `total_cost_usd`.

  `unifiedWindows` is not in the published SDK types. If it disappears, the allowance gate fails closed. The fallback is reading the documented status-line `rate_limits` from an interactive session in `usage-probe`.
- Don't use `--bare`: it skips the repository's CLAUDE.md/AGENTS.md and subscription sign-in.
- Claude Code refuses to bypass permissions as root, so the image runs as user `agent` (uid 1000).

## Docker notes

- Logs are followed **without timestamps**. Docker splits lines over 16 KB and would prefix every fragment, corrupting long stream-json lines. `docker.integration.test.ts` checks a 50 KB line.
- Podman returns 409 when a volume already exists, where Docker reuses it; `createVolume` ignores 409.
- SSH hosts run `docker system dial-stdio` remotely (docker-modem), so they need the `docker` CLI. The host key is pinned on first connect (`config.hostKey`).
- Prompt files reach a created container through `putArchive`, with a small tar writer in `providers/docker/tar.ts`. Names must be under 100 bytes.

## Trying the agent image locally

The git steps need no GitHub: a bare repository on the volume can stand in as the remote.

```sh
podman build -t workshop-agent:dev agent
podman volume create wtest
podman run --rm -v wtest:/work --entrypoint bash workshop-agent:dev -c \
  'git init -q --bare -b main /work/remote.git && git clone -q /work/remote.git /tmp/s && cd /tmp/s &&
   git -c user.name=t -c user.email=t@t commit -q --allow-empty -m init && git push -q origin HEAD:main'
podman run --rm -v wtest:/work -e REPO_URL=/work/remote.git -e CLEAN_URL=https://github.com/me/app.git \
  -e BRANCH=workshop/1-test -e BASE_BRANCH=main -e GIT_NAME=bot -e GIT_EMAIL=bot@example.com workshop-agent:dev prepare
podman run --rm -v wtest:/work -e PUSH_URL=/work/remote.git -e BRANCH=workshop/1-test workshop-agent:dev publish
```

`run` and `usage-probe` need `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) or `ANTHROPIC_API_KEY`. Without one, they show how a credential failure looks in stream-json.

## Adding a provider

1. Implement the interface from `providers/types.ts` in `providers/<name>/index.ts`, with a `ProviderInfo` describing its form fields. Mark secrets `secret: true`.
2. Register it in `providers/index.ts` (`PROVIDERS` and the matching `*Of()` factory).
3. Teach `describe()` in `http/connections.ts` how to check the connection.
4. Add tests with a fake, like `pipeline.test.ts` does for GitHub and Docker.

## Database

Add a schema change as a **new entry** at the end of `MIGRATIONS` in `db.ts`. Never edit an entry that has shipped. Booleans are integers; JSON lives in text columns; times are epoch milliseconds, except `updated_at` and `synced_at`, which mirror GitHub's ISO strings.

## Testing

- `test/workflow.test.ts`, `test/gates.test.ts`: the state machine, transitions, prompts, operating hours (including time zones and DST), allowance.
- `test/pipeline.test.ts`: runner and sync end to end, with `vi.mock` replacing the provider factories (fake Docker host and GitHub).
- `test/api.test.ts`: sign-in, lockout, validation, cross-site refusal (supertest).
- `test/claude-stream.test.ts`: stream-json parsing, using shapes copied from real output.
- `test/docker.integration.test.ts`: real engine, opt-in through `WORKSHOP_TEST_DOCKER_SOCKET`.

`vitest.config.ts` sets the required environment variables, plus a temporary `DATA_DIR`.
