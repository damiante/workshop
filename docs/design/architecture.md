# Workshop architecture

Workshop turns GitHub issues into reviewed pull requests while you're away from your desk, using your Claude subscription allowance. It polls the repositories you enable, runs a pipeline of Claude Code agents (`claude -p`) in Docker containers on hosts you enroll, and tracks each ticket's state with `workshop/*` labels on the issue. A web UI shows what's running, what's waiting on you, and lets you manage connections, agents and settings.

The original brief is [requirements.md](requirements.md), with the diagrams [workshop-architecture.drawio.svg](workshop-architecture.drawio.svg) and [ticket-state-transition.drawio.svg](ticket-state-transition.drawio.svg). The ticket lifecycle is described in [workflow.md](workflow.md).

## Components

```
 browser: React SPA ──REST + SSE──► Workshop server (Node 24, one container, SQLite in /data)
                                    API · sign-in · scheduler · run supervisor · providers
                                       │ GitHub REST/GraphQL           │ Docker Engine API (socket | SSH | mTLS)
                                       ▼                               ▼
                                   github.com ◄── git push ── agent host: workshop-agent containers
                                                                prepare → run (claude -p) → publish
                                                                run ──► Anthropic (subscription or API key)
```

- **Server** (`server/`): TypeScript run directly by Node 24 (type stripping, no build step), Express 5, `node:sqlite`. One in-process scheduler loop, one run supervisor, provider adapters.
- **Client** (`client/`): React 19 single-page app built with Vite and served by the server. Live updates arrive over Server-Sent Events.
- **Agent image** (`agent/`): Debian with Node 24, Python 3, a C toolchain, git and Claude Code (pinned). One entrypoint with four commands: `prepare`, `run`, `publish`, `usage-probe`.

Workshop never calls Anthropic with your subscription token. Only the official Claude Code CLI uses it, inside agent containers. The exception is API keys: Workshop lists models with them to validate them.

## Providers

Every external tool sits behind an interface in `server/src/providers/types.ts`:

| Interface | Job | First implementation |
|---|---|---|
| `TicketSource` | List changed tickets, read comments, edit labels, comment, close, create labels | GitHub Issues |
| `VcsHost` | List repos, create branches, mint short-lived git credentials, open/update/merge pull requests, read reviews | GitHub (via a GitHub App) |
| `Environment` | Run containers, stream logs, wait, inspect, kill, manage volumes | Docker Engine API (dockerode) |
| `ModelProvider` | Models, billing modes, credentials for the agent container | Claude (Claude Code) |

Each provider also publishes a `ProviderInfo` (fields, help text, which are secret). The UI's connection forms and the server's validation are both generated from it. Adding GitLab, Jira or another host type means adding a folder that implements the interface, plus its `ProviderInfo`.

## Decisions and why

These are the places where the build deliberately differs from, or adds to, the requirements.

### The agents act as a GitHub App bot, not as you

GitHub doesn't let you approve or request changes on a pull request you authored. If agents used your token, the "approved → merge" and "changes requested → re-classify" transitions couldn't happen, and GitHub wouldn't notify you about questions "you" asked. Workshop creates its own GitHub App through GitHub's App-manifest flow, which takes two clicks. You review its pull requests natively and get notified when it asks something. The App is public-installable because a private App can only be installed on the account that owns it, which rules out your organisations. Workshop only trusts installations that come back through its own Install link, or that you approve on the Connections page.

### Agents don't hold GitHub credentials or apply labels

Each run is three containers sharing one volume:

1. `prepare`: fetches the repository with a read-only token scoped to that one repository and valid for an hour. The token is never written to the volume.
2. `run`: Claude Code, as a non-root user, with permission prompts skipped. It has **no git credentials**.
3. `publish`: commits anything left uncommitted, then pushes with a write token scoped to that one repository.

The agent returns a result validated against a JSON schema (`--json-schema`). Workshop then applies every label, comment, branch, pull request and merge itself, through the provider interfaces. This keeps the state machine deterministic: no LLM can forget a label. It also limits what a prompt injection in issue text can do: the agent can't push anywhere or leak a GitHub token. And it keeps prompts provider-agnostic.

### Run state lives in Docker as well as the database

The requirements asked agents to report back when they finish. Workshop instead follows each container's log stream and waits on it. Containers carry the labels `workshop.run`, `workshop.ticket`, `workshop.agent`, `workshop.step` and `workshop.instance`. A run's status, step and container id are stored. If Workshop restarts or loses contact with a host, the agent keeps working; Workshop re-attaches later and skips the log lines it already has. Hosts never need to reach Workshop.

One agent per ticket is enforced by a unique index over active runs (`runs_one_active_per_ticket`).

### Reading the 5-hour and weekly allowance

Claude Code reports both windows in the first `rate_limit_event` of every headless run, as `rate_limit_info.unifiedWindows.{five_hour,seven_day}.utilization` (a fraction) and `resetsAt` (epoch seconds). This was verified with Claude Code 2.1.289 and 2.1.296 in October 2026.

- Every agent run refreshes the reading for free.
- When no reading is newer than 10 minutes and a launch is waiting, Workshop runs `usage-probe`. That's a one-turn `claude -p` with a replaced system prompt and no tools: about 700 input tokens on Haiku.
- If Claude reports `allowed_warning`, `rejected`, or paid overage during a run, launches on that connection stop until the reset time.
- If no reading is available, Workshop fails closed: nothing starts on the subscription and an alert explains why.

The plan originally used the status-line JSON from an interactive session driven in a pseudo-terminal, because headless output didn't report usage until recently. Setup tokens from `claude setup-token` can't read the `/api/oauth/usage` endpoint (it needs `user:profile`) and that endpoint is undocumented, so it isn't used. `unifiedWindows` isn't in the Agent SDK's published types yet. If it disappears, the status-line approach is the fallback, and it fits in `usage-probe` without changing the server.

### Merges usually need no LLM

An approved, cleanly mergeable pull request is squash-merged through the API, and the ticket is closed. If GitHub reports the branch behind the base, Workshop uses GitHub's "update branch" (also no LLM). Only real conflicts launch the Merge agent. If new commits dismiss your approval, the ticket goes back to waiting for your review.

### Host capacity is slots, not LLM-chosen sizes

Resource use comes from a project's build and tests, not from the ticket's size, and Docker can't reliably report free capacity while other workloads share a host. Each host has a slot count (default 1) and per-agent CPU and memory limits. Enrollment reads the host's CPUs and memory and suggests how many agents fit. The scheduler picks the healthy host with the most free slots.

### Failures are bounded

Each stage gets two attempts. After that, the ticket gets `workshop/failed`, a comment with the last error, and an alert; removing the label retries. A run that hits the usage limit is paused, not failed. Its volume, and with it the Claude session (`CLAUDE_CONFIG_DIR` is on the volume), are kept. It resumes with `claude --resume` on the same host once the window resets.

### Operating hours use one explicit time zone

"Host environment time" is ambiguous with several hosts, so hours are evaluated in one IANA time zone (default: the server's `TZ`). The top bar has three modes. **Scheduled** follows the hours. **Always on** ignores them (the requirements' override). **Paused** is a kill switch for new launches; Workshop starts paused. Agents that are already running always finish.

### API billing has dollar caps

The allowance thresholds only apply to subscription billing. Runs on an API key get `--max-budget-usd` (default $5), and Workshop stops starting API runs once the day's runs reach a daily cap (default $20).

### Sign-in is password plus TOTP

A shared password in an environment variable isn't enough for a service that holds a GitHub App key and root-equivalent access to Docker hosts, and is exposed to the internet. Workshop uses:
- the password (`WORKSHOP_PASSWORD`) plus a TOTP code, enrolled on first sign-in;
- server-side sessions with HttpOnly, SameSite=Lax cookies (Secure over HTTPS);
- a 15-minute lockout after 5 failures per IP;
- an Origin check on writes, and a Content-Security-Policy.

Lax rather than Strict is needed so the session survives GitHub redirecting back during App setup. Stored credentials are encrypted with AES-256-GCM under `WORKSHOP_SECRET_KEY` and never sent back to the browser.

### Only your tickets

Anyone can open issues on a public repository. Workshop only acts on issues opened by the ticket authors you list (default: the GitHub App's owner). It leaves comments from anyone else out of what agents read.

## Data

SQLite at `DATA_DIR/workshop.db` (WAL mode). Migrations are an append-only list in `server/src/db.ts`. Tables:

| Table | Holds |
|---|---|
| `settings` | Operating settings (one JSON row), TOTP state, setup state |
| `sessions` | Hashed session tokens |
| `connections` | Every enrolled tool: kind, provider, config JSON, encrypted secrets, status |
| `agent_classes` | Model, billing, effort, prompt override, limits per agent |
| `repos` | Repositories from the code host; which are enabled; per-repo image |
| `tickets` | Cached ticket state (labels are the source of truth on GitHub), branch, PR, failure count |
| `runs` | One row per agent run: status, step, container, volume, result, usage |
| `alerts` | Alerts and when they were acknowledged |
| `allowance_samples` | Usage readings and limit blocks |

Run logs are files: `DATA_DIR/runs/<run id>.jsonl`, one JSON object per line. Lines from the `run` step's stdout are Claude Code stream-json. Runs and logs are deleted after the retention period (30 days by default).

Labels on GitHub are the source of truth for ticket state. Losing the database loses history and configuration, but no ticket state.

## Risks

- `rate_limit_event.unifiedWindows` isn't documented. The agent image pins Claude Code so this only changes deliberately, and Workshop fails closed if the readings stop.
- Anthropic says `--bare` "will become the default for `-p`". Bare mode skips the repository's CLAUDE.md/AGENTS.md and subscription sign-in. The pin protects against this; check the flags when updating Claude Code.
- If "extra usage" is enabled on your Claude plan, a long run can continue into paid usage. Workshop stops new launches when Claude reports overage, but doesn't kill a running agent.
- Agent containers have unrestricted network access, so that package installs work.
- A Docker socket (local, SSH or TLS) is root-equivalent on its host.
