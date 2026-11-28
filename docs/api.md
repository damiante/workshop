# Workshop API

Anything the web UI does with agents, settings and usage is available over HTTP, so scripts and home-automation tools can drive Workshop. The schema is an OpenAPI 3.1 document at `GET /api/openapi.json`.

## Tokens

Create a token in **Settings → API tokens**. Workshop shows it once; copy it then. Send it on every request:

```sh
export WORKSHOP=https://workshop.example.com
export TOKEN=wks_…
```

- **Full** tokens can use every endpoint described in the schema.
- **Read only** tokens can only make `GET` requests. Other methods get 403.
- Connections and API tokens can't be reached with a token. Managing them needs the web sign-in.
- A token can expire: pick its lifetime when you create it. An expired token gets 401. Revoke one in Settings and it stops working immediately.

### Debugging with Claude

To have Claude Code look into a run, open the run and click **Give Claude access**. Workshop creates a read-only token that lasts 8 hours and shows a brief to paste into Claude Code: the instance URL, the token, how to send it, where the schema is, and the `curl` calls to start with for that run, its ticket and the alerts. Copy it, or select it from the text box when the clipboard isn't available. If Claude should act (resume a run, change settings), create a Full token in Settings instead.

## Examples

```sh
# Read status: mode, within operating hours, allowance and open alert count
curl $WORKSHOP/api/status -H "Authorization: Bearer $TOKEN"

# Pause Workshop (mode: paused, scheduled or always)
curl -X PUT $WORKSHOP/api/settings -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"mode":"paused"}'

# Change the ticket order: updated-asc (default), updated-desc, created-asc or created-desc
curl -X PUT $WORKSHOP/api/settings -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"ticketOrder":"updated-desc"}'

# Read usage: Claude allowance and limits per subscription, and today's API spend against the caps
curl $WORKSHOP/api/usage -H "Authorization: Bearer $TOKEN"

# Change one subscription's usage limits (connection id from GET /api/usage; send either or both)
curl -X PUT $WORKSHOP/api/usage/limits/3 -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"fiveHour":50}'

# Lifetime token use and token-equivalent cost, by billing, model, project and month
curl $WORKSHOP/api/usage/lifetime -H "Authorization: Bearer $TOKEN"

# Usage over time with projections, burn rates, and when open tickets should finish and what they should cost, and the cost of each ticket: range 24h, 7d, 30d (default), 90d or all
curl "$WORKSHOP/api/usage/history?range=7d" -H "Authorization: Bearer $TOKEN"

# The dependency graph of each enabled repository: which tickets wait for which, closed ones included
curl $WORKSHOP/api/dependencies -H "Authorization: Bearer $TOKEN"

# Start an agent on a ticket now (ticket id from GET /api/tickets)
curl -X POST $WORKSHOP/api/tickets/12/launch -H "Authorization: Bearer $TOKEN"

# Push a ticket along while Workshop is paused (scope: stage or lifecycle)
curl -X POST $WORKSHOP/api/tickets/12/push -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"scope":"lifecycle"}'

# Work on a ticket before every other ticket, until it closes (false removes that)
curl -X PUT $WORKSHOP/api/tickets/12/prioritised -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"prioritised":true}'

# Let a ticket's agents run past your subscription usage limits, until it closes (false removes that)
curl -X PUT $WORKSHOP/api/tickets/12/bypass-limits -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"bypassLimits":true}'

# Switch an agent host off for new agents (it stays connected; running agents carry on)
curl -X PUT $WORKSHOP/api/hosts/3 -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"available":false}'

# Pause a run at its next step, freeing its host slot until you resume it
curl -X POST $WORKSHOP/api/runs/<run id>/pause -H "Authorization: Bearer $TOKEN"

# Resume a run you paused (or cancel a pause that hasn't happened yet)
curl -X POST $WORKSHOP/api/runs/<run id>/resume -H "Authorization: Bearer $TOKEN"

# Stop a run
curl -X POST $WORKSHOP/api/runs/<run id>/stop -H "Authorization: Bearer $TOKEN"
```

`/api/overview`'s `queue` holds the first 8 tickets in queue order, and `queueTotal` counts all of them.

Usage limits are set per subscription. `PUT /api/settings` with the old global `fiveHourMax` or `weeklyMax` returns 400, and `/api/overview` and `/api/usage` no longer have a `thresholds` field: each `allowance` entry carries its own `limits`.

## Launching

`POST /api/tickets/:id/launch` starts whatever agent the ticket is due next and answers 202 with the run. It ignores the operation mode and operating hours, so it works while Workshop is paused. Every other check still applies: dependencies, a chosen model, the Claude allowance, the API cap and a free agent host. If one blocks the launch you get 409 with the reason.

## Dependencies

`GET /api/dependencies` returns one graph per enabled repository, including repositories with no links. `edges` lists every "blocked by" link Workshop has seen whose waiting ticket is in that repository, open and closed: `blocker` must finish before `ticket`, both as node refs (`#12`, or `other/repo#5` for another repository). `nodes` has both ends of every edge. A node that is a Workshop ticket, in any enabled repository, carries its `ticket` view and current state; any other blocker has `ticket: null` and the state GitHub gave when Workshop last read the link. Links made before Workshop stored them fill in over a few syncs, and a link removed on GitHub may stay until its ticket is next read.

## Checking now

`POST /api/sync` syncs tickets from GitHub now, or right after the sync that's already running.

`POST /api/refresh` runs the checks Workshop's timer runs, without waiting for the next poll: it syncs tickets from GitHub, re-reads the usage of every Claude subscription that is over your limits or hasn't been checked in the last 10 minutes (even one whose last check failed), and starts agents in every free slot that a ready ticket fits. It waits for its sync, then up to about 2.5 minutes from the request for those usage checks, then starts or resumes what they made ready too. A usage limit Claude reported mid-run still waits for its reset time. A Refresh asked for while one is running joins it.

Both answer 202 at once with the sync progress record. Before #147 they answered `{ "ok": true }`; a script that checks `ok` needs updating. Follow the work with `GET /api/sync`, which returns the same record:

| Field | Meaning |
|---|---|
| `state` | `idle`; `requested` (received, about to start); `waiting` (queued behind the sync pass that's running); `running` |
| `kind` | `sync` (Sync now, or a settings change), `refresh`, or `scheduled` (the timer) |
| `phase` | `sync`, then for a refresh `usage` and `allocate` (starting work); `null` when idle |
| `repo` | The repository being synced |
| `done`, `total` | In `sync`: repositories synced and due. In `usage`: Claude usage checks finished and started |
| `requestedAt`, `lastFinishedAt` | Epoch milliseconds |
| `lastError` | Why repositories failed to sync in the last pass, or `null` |

The record lives in memory, so after a restart `lastFinishedAt` is `null` until the first sync. Every change publishes the `sync` topic on `GET /api/events`. A timer check with no repository due doesn't change it.

## Pausing a run

`POST /api/runs/:id/pause` asks a starting or running agent to stop at its next turn boundary, once every tool call it started has returned (or after 10 minutes, if one stays open). It then waits as `paused` with `pauseReason: "manual"`, and its host slot goes to the next ticket in the queue. Until it stops, the run shows `pauseRequested: true`. A manual pause never resumes by itself. On a run already paused for usage it makes the pause manual, so the run stays paused after the limit resets. It answers with the run; 409 for a run that is publishing or has ended.

`POST /api/runs/:id/resume` continues a run you paused, in the same Claude session and workspace. Like launching, it ignores the operation mode and hours, but it needs a free slot on the run's own host and, for subscription runs, enough Claude allowance; otherwise you get 409 with the reason, and can try again later. On a run that hasn't stopped yet, it cancels the pause. If the run's Claude subscription is paused, it moves to the next subscription that offers its model; with none, you get 409. A run moving off a paused subscription on its own shows `pauseReason: "connection"`. The first step after resuming re-reads the whole conversation (the prompt cache has expired by then), which costs roughly the size of the conversation once. Comments added to the ticket while it was paused aren't seen.

## Pushing a ticket

`POST /api/tickets/:id/push` with `{"scope": "stage"}` or `{"scope": "lifecycle"}` lets one ticket keep moving whatever the operation mode, so you can leave Workshop paused and still push chosen tickets. It answers with the ticket, whose `push` field shows the scope.

- **`stage`** runs the ticket's next step (classify, design, design review, implement, code review, or merge) and stops once the stage label changes.
- **`lifecycle`** keeps going, stage after stage.

Either push also ends where Workshop would wait for you anyway: your pull request review, a question (`workshop/needs-info`), `workshop/skip`, `workshop/failed`, or the ticket closing. A push only lifts the mode gate: dependencies, model settings, the Claude allowance, the API cap, free agent hosts and one agent per ticket still apply, and pushed tickets go to the front of the queue. An approved pull request is merged while Workshop is paused only if its ticket was pushed.

`DELETE /api/tickets/:id/push` cancels a push. It doesn't stop an agent that's already running (use `POST /api/runs/:id/stop` for that).

`PUT /api/tickets/:id/nominated` with `{"nominated": true}` or `false` adds or removes the `workshop/nominated` label on a ticket in a repository that only works on nominated tickets. It answers with the ticket; 409 if the repository works on its whole backlog.

`PUT /api/tickets/:id/dismissed` with `{"dismissed": true}` or `false` hides a ticket from **Needs you** on the dashboard, or brings it back. `/api/overview` lists dismissed tickets under `dismissed`. A dismissed ticket comes back by itself when the reason it needs you changes: a new question, a new failure stop or a new pull request to review (anything that starts a new run). It also comes back if cleanup removes the ticket's latest run after the retention period. Nothing changes on GitHub. It answers with the ticket; 400 if `dismissed` isn't a boolean, 409 when dismissing a ticket that isn't waiting on you.

`PUT /api/tickets/:id/prioritised` with `{"prioritised": true}` or `false` puts a ticket ahead of every ticket you haven't prioritised, for its whole lifecycle, or removes that. Unlike a push, it only changes the order: Workshop's mode and hours and every other gate still apply. It stays set through questions and your reviews, and is cleared when the ticket closes. Between prioritised tickets the usual order decides (repository priority, step, ticket order); pushed tickets still go first. `/api/overview` marks them with `prioritised` in `queue`. Open tickets a prioritised ticket depends on, directly or through others, go first too without being marked: each ticket's `dependsOn` lists what it waits for and `prioritisedFor` the prioritised tickets it goes first for (both `{ ref, ticketId }`, with `ticketId` null for tickets Workshop doesn't track), and queue items carry `prioritisedFor` as refs. It answers with the ticket; 400 if `prioritised` isn't a boolean, 404 for a ticket you couldn't push either, and 409 when prioritising a closed ticket or one that isn't nominated in a nominated-only repository. Removing priority always works.

`PUT /api/tickets/:id/bypass-limits` with `{"bypassLimits": true}` or `false` lets a ticket's agents start, run and resume past your 5-hour and weekly subscription limits for its whole lifecycle, or removes that. Limits Claude reports still apply, as do the need for a fresh usage reading, the API daily cap, Workshop's mode and hours and the queue order. It's cleared when the ticket closes. `/api/overview` marks these tickets with `bypassLimits` in `queue`. It answers with the ticket; 400 if `bypassLimits` isn't a boolean, 404 for a ticket you couldn't push either, and 409 when setting it on a closed ticket or one that isn't nominated in a nominated-only repository. Removing it always works.

A push is refused with 409 and the reason when the ticket is closed, failed, skipped, waiting on a question or waiting for your review, or (for `stage`) already has an agent working on that stage. A ticket that doesn't exist, belongs to a disabled repository or was opened by someone outside the author allowlist is 404, and a missing or invalid scope is 400.

## Run progress

`GET /api/runs/{id}` includes the limits the agent's session started with: `maxTurns` and `timeoutMin` (minutes), plus `stepStartedAt`, when the current step's container started. The time limit counts from `stepStartedAt`, and both limits start again when a paused run resumes. They're null for runs from before Workshop recorded them.

## Media

`GET /api/tickets/{id}` returns a ticket (open or closed), every agent run on it oldest first, and its media, which is what the ticket lifecycle page shows. Finished runs are removed after the retention period in Settings.

Each ticket has a temporary store of images: screenshots agents added, and images copied from the issue. `GET /api/tickets/{id}/media` lists them; `GET /api/tickets/{id}/media/{name}` returns one file with its own `Content-Type`. Both need a token or session. The store is deleted when the ticket finishes (merged, pull request closed, issue closed or declined) and after 30 days without changes.

## Errors

Errors are JSON, `{ "error": "readable message" }`, with the usual status: 400 for a bad request, 401 for a missing, wrong or revoked token, 403 for a read-only token, 404 for something that doesn't exist, 409 when Workshop can't do it right now.
