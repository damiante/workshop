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
- Tokens don't expire. Revoke one in Settings and it stops working immediately.

## Examples

```sh
# Pause Workshop (mode: paused, scheduled or always)
curl -X PUT $WORKSHOP/api/settings -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"mode":"paused"}'

# Change the ticket order: updated-asc (default), updated-desc, created-asc or created-desc
curl -X PUT $WORKSHOP/api/settings -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"ticketOrder":"updated-desc"}'

# Read usage: Claude allowance, thresholds and today's API spend against the caps
curl $WORKSHOP/api/usage -H "Authorization: Bearer $TOKEN"

# Lifetime token use and token-equivalent cost, by billing, model, project and month
curl $WORKSHOP/api/usage/lifetime -H "Authorization: Bearer $TOKEN"

# Start an agent on a ticket now (ticket id from GET /api/tickets)
curl -X POST $WORKSHOP/api/tickets/12/launch -H "Authorization: Bearer $TOKEN"

# Push a ticket along while Workshop is paused (scope: stage or lifecycle)
curl -X POST $WORKSHOP/api/tickets/12/push -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"scope":"lifecycle"}'

# Work on a ticket before every other ticket, until it closes (false removes that)
curl -X PUT $WORKSHOP/api/tickets/12/prioritised -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"prioritised":true}'

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

## Launching

`POST /api/tickets/:id/launch` starts whatever agent the ticket is due next and answers 202 with the run. It ignores the operation mode and operating hours, so it works while Workshop is paused. Every other check still applies: dependencies, a chosen model, the Claude allowance, the API cap and a free agent host. If one blocks the launch you get 409 with the reason.

## Checking now

`POST /api/refresh` runs the checks Workshop's timer runs, without waiting for the next poll: it syncs tickets from GitHub, re-reads the usage of every Claude subscription that is over your limits or hasn't been checked in the last 10 minutes (even one whose last check failed), then starts or resumes whatever is now ready. A usage limit Claude reported mid-run still waits for its reset time. It answers 202 at once; the checks finish in the background, and the dashboard updates when they do.

## Pausing a run

`POST /api/runs/:id/pause` asks a starting or running agent to stop at its next turn boundary, once every tool call it started has returned (or after 10 minutes, if one stays open). It then waits as `paused` with `pauseReason: "manual"`, and its host slot goes to the next ticket in the queue. Until it stops, the run shows `pauseRequested: true`. A manual pause never resumes by itself. On a run already paused for usage it makes the pause manual, so the run stays paused after the limit resets. It answers with the run; 409 for a run that is publishing or has ended.

`POST /api/runs/:id/resume` continues a run you paused, in the same Claude session and workspace. Like launching, it ignores the operation mode and hours, but it needs a free slot on the run's own host and, for subscription runs, enough Claude allowance; otherwise you get 409 with the reason, and can try again later. On a run that hasn't stopped yet, it cancels the pause. If the run's Claude subscription is paused, it moves to the next subscription that offers its model; with none, you get 409. A run moving off a paused subscription on its own shows `pauseReason: "connection"`. The first step after resuming re-reads the whole conversation (the prompt cache has expired by then), which costs roughly the size of the conversation once. Comments added to the ticket while it was paused aren't seen.

## Pushing a ticket

`POST /api/tickets/:id/push` with `{"scope": "stage"}` or `{"scope": "lifecycle"}` lets one ticket keep moving whatever the operation mode, so you can leave Workshop paused and still push chosen tickets. It answers with the ticket, whose `push` field shows the scope.

- **`stage`** runs the ticket's next step (classify, design, design review, implement, or merge) and stops once the stage label changes.
- **`lifecycle`** keeps going, stage after stage.

Either push also ends where Workshop would wait for you anyway: your pull request review, a question (`workshop/needs-info`), `workshop/skip`, `workshop/failed`, or the ticket closing. A push only lifts the mode gate: dependencies, model settings, the Claude allowance, the API cap, free agent hosts and one agent per ticket still apply, and pushed tickets go to the front of the queue. An approved pull request is merged while Workshop is paused only if its ticket was pushed.

`DELETE /api/tickets/:id/push` cancels a push. It doesn't stop an agent that's already running (use `POST /api/runs/:id/stop` for that).

`PUT /api/tickets/:id/nominated` with `{"nominated": true}` or `false` adds or removes the `workshop/nominated` label on a ticket in a repository that only works on nominated tickets. It answers with the ticket; 409 if the repository works on its whole backlog.

`PUT /api/tickets/:id/dismissed` with `{"dismissed": true}` or `false` hides a ticket from **Needs you** on the dashboard, or brings it back. `/api/overview` lists dismissed tickets under `dismissed`. A dismissed ticket comes back by itself when the reason it needs you changes: a new question, a new failure stop or a new pull request to review (anything that starts a new run). It also comes back if cleanup removes the ticket's latest run after the retention period. Nothing changes on GitHub. It answers with the ticket; 400 if `dismissed` isn't a boolean, 409 when dismissing a ticket that isn't waiting on you.

`PUT /api/tickets/:id/prioritised` with `{"prioritised": true}` or `false` puts a ticket ahead of every ticket you haven't prioritised, for its whole lifecycle, or removes that. Unlike a push, it only changes the order: Workshop's mode and hours and every other gate still apply. It stays set through questions and your reviews, and is cleared when the ticket closes. Between prioritised tickets the usual order decides (repository priority, step, ticket order); pushed tickets still go first. `/api/overview` marks them with `prioritised` in `queue`. It answers with the ticket; 400 if `prioritised` isn't a boolean, 404 for a ticket you couldn't push either, and 409 when prioritising a closed ticket or one that isn't nominated in a nominated-only repository. Removing priority always works.

A push is refused with 409 and the reason when the ticket is closed, failed, skipped, waiting on a question or waiting for your review, or (for `stage`) already has an agent working on that stage. A ticket that doesn't exist, belongs to a disabled repository or was opened by someone outside the author allowlist is 404, and a missing or invalid scope is 400.

## Media

`GET /api/tickets/{id}` returns a ticket (open or closed), every agent run on it oldest first, and its media, which is what the ticket lifecycle page shows. Finished runs are removed after the retention period in Settings.

Each ticket has a temporary store of images: screenshots agents added, and images copied from the issue. `GET /api/tickets/{id}/media` lists them; `GET /api/tickets/{id}/media/{name}` returns one file with its own `Content-Type`. Both need a token or session. The store is deleted when the ticket finishes (merged, pull request closed, issue closed or declined) and after 30 days without changes.

## Errors

Errors are JSON, `{ "error": "readable message" }`, with the usual status: 400 for a bad request, 401 for a missing, wrong or revoked token, 403 for a read-only token, 404 for something that doesn't exist, 409 when Workshop can't do it right now.
