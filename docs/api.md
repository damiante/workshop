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

# Read usage: Claude allowance, thresholds and today's API spend against the caps
curl $WORKSHOP/api/usage -H "Authorization: Bearer $TOKEN"

# Start an agent on a ticket now (ticket id from GET /api/tickets)
curl -X POST $WORKSHOP/api/tickets/12/launch -H "Authorization: Bearer $TOKEN"

# Push a ticket along while Workshop is paused (scope: stage or lifecycle)
curl -X POST $WORKSHOP/api/tickets/12/push -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"scope":"lifecycle"}'

# Switch an agent host off for new agents (it stays connected; running agents carry on)
curl -X PUT $WORKSHOP/api/hosts/3 -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"available":false}'

# Stop a run
curl -X POST $WORKSHOP/api/runs/<run id>/stop -H "Authorization: Bearer $TOKEN"
```

## Launching

`POST /api/tickets/:id/launch` starts whatever agent the ticket is due next and answers 202 with the run. It ignores the operation mode and operating hours, so it works while Workshop is paused. Every other check still applies: dependencies, a chosen model, the Claude allowance, the API cap and a free agent host. If one blocks the launch you get 409 with the reason.

## Pushing a ticket

`POST /api/tickets/:id/push` with `{"scope": "stage"}` or `{"scope": "lifecycle"}` lets one ticket keep moving whatever the operation mode, so you can leave Workshop paused and still push chosen tickets. It answers with the ticket, whose `push` field shows the scope.

- **`stage`** runs the ticket's next step (classify, design, design review, implement, or merge) and stops once the stage label changes.
- **`lifecycle`** keeps going, stage after stage.

Either push also ends where Workshop would wait for you anyway: your pull request review, a question (`workshop/needs-info`), `workshop/skip`, `workshop/failed`, or the ticket closing. A push only lifts the mode gate: dependencies, model settings, the Claude allowance, the API cap, free agent hosts and one agent per ticket still apply, and pushed tickets go to the front of the queue. An approved pull request is merged while Workshop is paused only if its ticket was pushed.

`DELETE /api/tickets/:id/push` cancels a push. It doesn't stop an agent that's already running (use `POST /api/runs/:id/stop` for that).

`PUT /api/tickets/:id/nominated` with `{"nominated": true}` or `false` adds or removes the `workshop/nominated` label on a ticket in a repository that only works on nominated tickets. It answers with the ticket; 409 if the repository works on its whole backlog.

A push is refused with 409 and the reason when the ticket is closed, failed, skipped, waiting on a question or waiting for your review, or (for `stage`) already has an agent working on that stage. A ticket that doesn't exist, belongs to a disabled repository or was opened by someone outside the author allowlist is 404, and a missing or invalid scope is 400.

## Errors

Errors are JSON, `{ "error": "readable message" }`, with the usual status: 400 for a bad request, 401 for a missing, wrong or revoked token, 403 for a read-only token, 404 for something that doesn't exist, 409 when Workshop can't do it right now.
