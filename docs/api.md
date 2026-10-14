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

# Stop a run
curl -X POST $WORKSHOP/api/runs/<run id>/stop -H "Authorization: Bearer $TOKEN"
```

## Launching

`POST /api/tickets/:id/launch` starts whatever agent the ticket is due next and answers 202 with the run. It ignores the operation mode and operating hours, so it works while Workshop is paused. Every other check still applies: dependencies, a chosen model, the Claude allowance, the API cap and a free agent host. If one blocks the launch you get 409 with the reason.

## Errors

Errors are JSON, `{ "error": "readable message" }`, with the usual status: 400 for a bad request, 401 for a missing, wrong or revoked token, 403 for a read-only token, 404 for something that doesn't exist, 409 when Workshop can't do it right now.
