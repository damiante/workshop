# Workshop

Workshop works through your GitHub issues while you're away, using the Claude allowance you'd otherwise leave unused. It picks up issues from the repositories you choose and runs Claude Code agents in Docker containers on machines you control. The agents classify, design, adversarially review, implement and merge, and the result is pull requests for you to review. A web UI shows what's running and what's waiting on you, and stays inside the allowance limits and operating hours you set.

- **[How it works](#how-it-works)**: the pipeline and its labels
- **[Install](#install)**: Docker Compose, first sign-in
- **[Set up](#set-up)**: GitHub, agent hosts, Claude, repositories
- **[Day to day](#day-to-day)**: questions, reviews, failures
- **[Configuration](#configuration)**, **[Security](#security)**, **[Development](#development)**

Design notes: [docs/design/architecture.md](docs/design/architecture.md) and [docs/design/workflow.md](docs/design/workflow.md). The original brief is in [docs/design/requirements.md](docs/design/requirements.md).

## How it works

```
 your browser ──► Workshop (one container) ──► GitHub (issues, pull requests)
                       │
                       └──► agent hosts (Docker) ──► agent containers running `claude -p`
```

Every few minutes Workshop reads open issues opened by you (or anyone else you list as a ticket author) in the repositories you've turned on. Each issue moves through these stages:

1. **Classify.** The Classifier sizes the issue XS to XL, or declines it with a reason. Workshop creates a branch linked to the issue. A ticket waits while GitHub shows it as blocked by an open issue, and the Classifier can add that link itself when a ticket needs another one first.
2. **Design** (M, L and XL only). The Design agent writes a design doc on the branch.
3. **Design review** (L and XL only). The Design adversary attacks the design and revises it.
4. **Implement.** The Implementation agent writes the change and tests, and Workshop opens a pull request and asks for your review. On L and XL tickets the agent also runs an adversarial self-review before finishing.
5. **Your review.**
   - Approve, and Workshop merges the pull request (through GitHub, no tokens needed) and closes the issue. Only real merge conflicts need the Merge agent.
   - Request changes, and the Classifier sizes just those changes and the pipeline runs again on the same branch.

Any agent can stop and ask you a question as a comment on the issue. You answer, remove the `workshop/needs-info` label, and the same stage picks up where it left off.

State lives in `workshop/` labels on the issue, so you can steer a ticket on GitHub. For example, remove `workshop/skip` to have a declined ticket classified again. The full table is in [docs/design/workflow.md](docs/design/workflow.md).

Agents work as Workshop's own GitHub App bot, so you review their pull requests normally and GitHub notifies you about questions and review requests.

Before starting an agent, Workshop checks:
- the operation mode and operating hours;
- your Claude allowance (by default, nothing new starts above 70% of the 5-hour window or 80% of the weekly one);
- that an agent host is reachable and has a free slot;
- that no other agent is working on the same ticket.

## Install

You need:

- A machine to run Workshop: anything with Docker, or Podman.
- One or more **agent hosts**: machines with Docker where agents run. This can be the same machine.
- A **GitHub** account, plus any organisations whose repositories you want to include.
- A **Claude subscription** (Pro or Max), an **Anthropic API key**, or both.

Copy [docker-compose.yml](docker-compose.yml) (or paste it into a Portainer stack), set `WORKSHOP_PASSWORD` and `WORKSHOP_SECRET_KEY`, and start it:

```sh
docker compose up -d
```

Open `http://<host>:8080`. On first sign-in, enter the password, then scan the QR code with an authenticator app (1Password, Google Authenticator, Aegis…) and enter the code it shows. From then on, signing in takes both. Sign in straight after the first start: until an authenticator is enrolled, the password alone can enrol one.

Workshop starts **paused**. Nothing runs until you switch the top bar to Scheduled or Always on.

**Before exposing it to the internet**, put it behind a TLS reverse proxy (Caddy, Traefik, nginx). The proxy must pass the original `Host` header (or set `X-Forwarded-Host`): Workshop refuses changes whose origin doesn't match the address you're using. With nginx that means `proxy_set_header Host $host;`. A VPN such as Tailscale, or Cloudflare Access, in front of it adds a second layer. Workshop holds credentials for your code and your agent hosts. See [Security](#security).

## Set up

The dashboard shows a checklist until these are done. Everything happens on the **Connections** page.

### 1. GitHub

Click **Create the GitHub App**. GitHub opens a pre-filled page; click **Create GitHub App** and you're sent back to Workshop. Then click **Install on an account or organisation**, choose an account (your own, or an organisation you own), and pick repositories. Repeat for each organisation.

- **Permissions requested:** contents, issues, pull requests and workflows (read and write); checks, statuses and metadata (read). Workflows lets agents push changes to `.github/workflows`, which means they can change your CI and anything it can reach, such as Actions secrets. Apps created before this was added need Workflows granted in the App's settings, and the installation's owner has to accept it. Until then, agents push without it, and GitHub rejects any push that touches workflow files.
- **"Public" App:** GitHub only lets a private App be installed on the account that owns it, so the App is public-installable. Anyone who found its link could install it on *their* repositories, which would only give *your* Workshop access to them. Workshop ignores installations that didn't come back through its own Install button (you can approve others by hand).
- **Redirects:** GitHub sends your browser back to the address you used to open Workshop, so it doesn't need to be reachable from GitHub itself. If GitHub refuses an `http://` LAN address during setup, do the one-time setup through an HTTPS address. Alternatively, create an App by hand and use **Use an existing App instead** (App ID plus a private key).

Creating the App also enrols **GitHub Issues** as the ticket source and adds the App's owner to your ticket authors.

### 2. Agent hosts

Add each machine that should run agents under **Agent hosts**. Workshop pulls the agent image the first time it's needed.

- **SSH (other machines):** create a key just for Workshop with `ssh-keygen -t ed25519 -N "" -f workshop` and add `workshop.pub` to `~/.ssh/authorized_keys` of a user in the `docker` group. Paste the private key into Workshop. The host needs the `docker` CLI. Workshop pins the host's SSH key on first connection and refuses it if it changes.
- **Local socket (this machine):** uncomment the socket lines in `docker-compose.yml`. With rootless Podman, mount `/run/user/<uid>/podman/podman.sock` instead and use that path. This gives Workshop root-equivalent access to the machine.
- **TCP with mutual TLS:** paste the CA, client certificate and key. Never expose plain TCP port 2375.

**Agents at once** (default 1) and the **per-agent CPU and memory** limits control capacity. The connection check shows the machine's CPUs and memory and how many agents would fit.

Repositories that need other toolchains (Android SDK, Ruby, Go…) can use their own image. Build it `FROM ghcr.io/damiante/workshop-agent` and set it on the repository (see step 4).

### 3. Claude

Under **AI models**, add Claude with either or both of:

- **Subscription token:** on any computer with a browser, run `claude setup-token`, sign in, and paste the `sk-ant-oat01-…` token. It lasts about a year; Workshop raises an alert if Claude starts rejecting it.
- **API key:** from platform.claude.com. Runs billed this way are capped per run and per day (Settings).

The connection check runs a tiny Claude Code session on an agent host (about 700 input tokens on Haiku) and shows your current 5-hour and weekly usage. Agents are pre-assigned: Haiku for the Classifier, Opus for Design and the Design adversary, Sonnet for Implementation and Merge. Change this on the **Agents** page, along with each agent's billing (subscription or API key), effort, instructions, turn limit and time limit.

### 4. Repositories

Once the App is installed, the **Repositories** list shows every repository it can see. Tick the ones Workshop should work on. Turning a repository on creates its `workshop/` labels. A repository can work on all its open tickets or only those you nominate by adding the `workshop/nominated` label (or pressing **Nominate** on the Tickets page). Give a repository a priority to have its tickets go first: a lower-priority repository waits until every open ticket in the higher ones has been classified.

### 5. Settings

- **Ticket authors:** Workshop only works on issues opened by these GitHub users, and leaves other people's comments out of what agents read. Keep this to yourself on public repositories.
- **Operating hours and time zone**, used when the top bar is set to Scheduled. An end time before the start time runs overnight.
- **Allowance limits** (5-hour and weekly percentages) and **API caps**. Claude warns at 90% of a window, and Workshop also holds new agents then, so limits above 90% have no effect.

Then switch the top bar from **Paused** to **Scheduled** or **Always on**. To move one ticket along while Workshop is paused, use **Run next stage** or **Run until it needs you** on its card on the Tickets page.

Scripts can do the same, launch agents and read usage over HTTP with an API token from Settings: see [docs/api.md](docs/api.md).

## Day to day

- **Needs you** on the dashboard lists questions to answer, pull requests to review, and tickets that stopped after failures.
- **Answer a question:** reply on the issue, then remove `workshop/needs-info`.
- **Review:** approve the pull request on GitHub to merge it, or request changes. Plain comments don't count. You can also merge it yourself on GitHub; Workshop notices at its next check and tidies up the labels. Closing the issue stops work on it.
- **A ticket that failed twice** gets `workshop/failed` and a comment with the error. Fix what's needed and remove the label to retry.
- **Watch an agent:** click a running agent to see its live transcript (its messages, every command and file it touched, and its to-do list). **Stop** kills it and labels the ticket `workshop/failed` so it won't restart until you remove the label.
- **Usage limits:** if an agent hits your limit mid-run, it's paused rather than failed, and resumes in the same session after the window resets.
- **Alerts** report hosts going offline, killed or out-of-memory containers, rejected Claude credentials, failed syncs and merges, and failed allowance checks.

## Configuration

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `WORKSHOP_PASSWORD` | yes | | Sign-in password, at least 12 characters |
| `WORKSHOP_SECRET_KEY` | yes | | Encrypts stored credentials. Keep a copy: if it changes, Workshop refuses to start rather than lose them |
| `TZ` | | `UTC` | Default time zone for operating hours |
| `PORT` | | `3000` | Port inside the container |
| `DATA_DIR` | | `/data` | Database and run logs |
| `WORKSHOP_AGENT_IMAGE` | | set at build | Agent image; each release pins the one built from the same commit |
| `TRUST_PROXY` | | `loopback, linklocal, uniquelocal` | Which proxies' `X-Forwarded-*` headers to trust ([Express syntax](https://expressjs.com/en/guide/behind-proxies.html)) |
| `WORKSHOP_RESET_TOTP` | | | Set to `1` to remove the authenticator (lost phone). Remove it again after signing in |
| `WORKSHOP_INSTANCE` | | `workshop` | Label value that tells this Workshop's containers apart on a shared host |

Back up the data volume to keep history and configuration. Ticket state lives in the issue labels, so a lost database doesn't lose it.

## Security

- **Sign-in:** password plus TOTP; server-side sessions in HttpOnly cookies (Secure over HTTPS); 15-minute lockout after 5 failed attempts; cross-site writes refused; Content-Security-Policy.
- **Secrets:** GitHub App key, Claude token, API key, SSH and TLS keys are encrypted at rest (AES-256-GCM) and never sent back to the browser.
- **Agents never hold GitHub credentials.** A read token (one repository, one hour) is used to fetch and a write token to push, each in its own short container. The container running Claude has neither. Workshop itself applies labels, comments and pull requests from the agent's validated result.
- **Untrusted text:** only issues from your ticket authors are processed, and other people's comments are dropped. Agents are told that ticket text can't change their rules.
- **Isolation:** agents run as a non-root user in throwaway containers with CPU and memory limits. They have open network access (for package installs) and skip permission prompts, which is what that mode is designed for.
- **Docker access is root-equivalent** on each agent host, whether by socket, SSH or TLS. Use machines you're comfortable giving that to.
- **Paid overage:** if extra usage is enabled on your Claude plan, a long run can continue into paid usage. Workshop stops starting new agents when Claude reports overage, but doesn't stop a running one.

## Development

Node 24 or newer. The server runs its TypeScript directly; there's no build step except for the client.

```sh
npm install
cp .env.example .env            # then set WORKSHOP_PASSWORD and WORKSHOP_SECRET_KEY
npm run dev:server              # API on :3000 (restarts on change)
npm run dev:client              # UI on :5173, proxying /api
npm test                        # unit and API tests, server and client
npm run typecheck
npm run build && npm start      # production build, everything on :3000
```

- **Agent image:** `podman build -t workshop-agent:dev agent` (or `docker build`); point `WORKSHOP_AGENT_IMAGE` at it. The `prepare` and `publish` steps can be tried against a local bare repository; the agent image section of [server/AGENTS.md](server/AGENTS.md) explains how.
- **Docker integration test** (real engine): `WORKSHOP_TEST_DOCKER_SOCKET=/var/run/docker.sock npm test --workspace server`.
- **CI:** [.github/workflows/build.yml](.github/workflows/build.yml) type-checks, tests and builds every push and pull request. Pushes to `main` publish `ghcr.io/<owner>/workshop` and `ghcr.io/<owner>/workshop-agent`. Make the **workshop-agent** package public in GitHub's package settings, because agent hosts pull it without credentials.

Contributor and agent notes: [AGENTS.md](AGENTS.md), [server/AGENTS.md](server/AGENTS.md), [client/AGENTS.md](client/AGENTS.md).
