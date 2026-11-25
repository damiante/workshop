# 96 — More sensible access to instances for agents

## Context

When a run or ticket goes wrong, the owner asks Claude Code (on their own machine) to investigate the Workshop instance. Today they sign in from an incognito window and paste the session cookie. That cookie is a full session: it reaches connections and tokens, and it lasts 30 days.

Workshop already has API tokens (`server/src/http/tokens.ts`, Settings → API tokens). A read-only token reaches everything that's useful for debugging (`/api/runs/:id`, `/api/runs/:id/export`, `/api/tickets/:id`, `/api/alerts`, `/api/openapi.json`), and never connections or tokens. But tokens never expire, and making one, copying it and explaining the API to Claude takes several steps.

Outcome:

- **Tokens can expire.** You can pick a lifetime when you create a token. Once it has passed, the token stops working and Workshop says so.
- **One click on a run gives Claude access.** A **Give Claude access** button on the run view creates a read-only token that lasts 8 hours. It shows a short brief to paste into Claude Code: the instance URL, the token, how to send it, where the schema is, and which endpoints to start with for this run.

## Approach

- **Expiry is a nullable `api_tokens.expires_at` column.** Null means it never expires, so existing tokens keep working. `checkToken` rejects a token once `expires_at <= Date.now()`. It gets its own 401 message, so Claude can tell the owner what happened rather than guessing that the token was wrong.
- **Expired rows stay listed for a while, then go.** The list shows them as "Expired" so the owner can see what lapsed. `loop.cleanup` deletes tokens that expired more than 7 days ago. Revoke still deletes at once.
- **The client sends the lifetime in minutes (`expiresInMinutes`), not a timestamp.** Absent or `null` means it never expires. Sending minutes avoids clock skew between the browser and the server and keeps validation to one `int()` call.
- **The brief is assembled in the client.** Only the browser knows the origin the owner reaches Workshop at (`location.origin`), and the token is returned only once, in the create response. A pure function builds the text, so it can be tested. No new server route: the button calls the existing `POST /api/tokens`.
- **The run-view button is read-only and lasts 8 hours.** That covers an investigation session. Fixes happen in the repository, not through the API. If Claude needs to act (resume, push, change state), the owner creates a Full token in Settings with the lifetime they want. Keeping the button to one fixed choice keeps it to one click.

Rejected alternative: a separate "debug session" kind (a cookie, or a new table). That would duplicate tokens, scope checks and `sessionOnly`. Expiring tokens give the same thing.

## Changes

### Server

- `server/src/db.ts`: append to `MIGRATIONS`:
  `ALTER TABLE api_tokens ADD COLUMN expires_at INTEGER; -- null: never expires`
- `server/src/http/auth.ts`, `checkToken`:
  - also select `expires_at`;
  - return `'expired'` when `expires_at !== null && expires_at <= Date.now()`, without updating `last_used_at`;
  - in `requireAuth`, answer `'expired'` with 401 `{ error: 'That API token has expired. Create a new one in Settings.' }`. Change the return type to `{ id; scope } | 'expired' | null`.
- `server/src/http/tokens.ts`:
  - add `expires_at` to `TokenRow`, to the `SELECT` in `GET /tokens`, and to `view` (`expiresAt`);
  - `POST /tokens`: read `expiresInMinutes`. If it's `undefined` or `null`, store null. Otherwise `int(expiresInMinutes, 'Lifetime in minutes', 5, 525_600)` (5 minutes to 365 days), and `expires_at = created + minutes * 60_000`. Use one `Date.now()` for both `created_at` and `expires_at`.
- `server/src/scheduler/loop.ts`, `cleanup`: `run('DELETE FROM api_tokens WHERE expires_at < ?', Date.now() - 7 * 86400_000)`, then `publish('tokens')` if `changes > 0`.
- `server/src/api-types.ts`: the `ApiTokenView` field below.
- `server/src/http/openapi.ts`: the token routes aren't in the schema (session only), so nothing changes there. In the `info.description` sentence about tokens, add "Tokens may expire; an expired token gets 401."

### Client

- `client/src/access.ts` (new, pure, no React):
  - `TOKEN_LIFETIMES`: `[{ label: '1 hour', minutes: 60 }, { label: '8 hours', minutes: 480 }, { label: '1 day', minutes: 1440 }, { label: '7 days', minutes: 10080 }, { label: '30 days', minutes: 43200 }, { label: 'Never', minutes: null }]`.
  - `claudeBrief({ origin, token, expiresAt, run })`: returns the text below. `run` is a `Pick<RunView, 'id' | 'ticketId' | 'ticket' | 'agent' | 'status'>`.

    ```
    Help me find out what went wrong in my Workshop instance at <origin>.
    Look at run <id> (<agent> on <ticket>, status <status>).

    Use this read-only API token. It expires <ISO time>:
    export WORKSHOP=<origin>
    export TOKEN=<token>
    Send it on every request: -H "Authorization: Bearer $TOKEN"

    The API is described at $WORKSHOP/api/openapi.json. Start with:
    curl -H "Authorization: Bearer $TOKEN" $WORKSHOP/api/runs/<id>
    curl -H "Authorization: Bearer $TOKEN" $WORKSHOP/api/runs/<id>/export
    curl -H "Authorization: Bearer $TOKEN" $WORKSHOP/api/tickets/<ticketId>
    curl -H "Authorization: Bearer $TOKEN" $WORKSHOP/api/alerts
    ```

    Use `new Date(expiresAt).toISOString()` so the time can't be misread across time zones.
- `client/src/pages/Settings.tsx`, `ApiTokens`:
  - add a lifetime `<select aria-label="Token lifetime">` from `TOKEN_LIFETIMES`, between the name input and "Read only". It defaults to `1 day`. Send `expiresInMinutes` in the POST body.
  - add an **Expires** column: `Never`, `Expired` (muted) when `expiresAt <= now`, otherwise `clock(expiresAt)`. Use `useNow()` so the column flips to Expired on its own.
  - change the intro copy to: "Scripts and agents can use Workshop's API with a token. See docs/api.md."
- `client/src/pages/RunView.tsx`: a **Give Claude access** button in the header row, after **Export log**. On click:
  - `api<NewApiToken>('/tokens', { method: 'POST', body: { name: `Claude: run ${run.id.slice(0, 8)}`, scope: 'read', expiresInMinutes: 480 } })`;
  - show a small panel under the header. It holds a read-only `<textarea>` with `claudeBrief(...)` (`rows={14}`, selected on focus), a **Copy** button (`navigator.clipboard?.writeText`, as in Settings), a **Close** button, and the line "Read-only, expires in 8 hours. Revoke it in Settings → API tokens. Workshop won't show this token again.";
  - put errors in the existing `actionError`, and disable the button while the request is in flight (`busy`).

  The textarea is the fallback where `navigator.clipboard` doesn't exist (plain-HTTP origins).

### Docs

- `docs/api.md`, **Tokens**: replace "Tokens don't expire…" with "A token can expire: pick its lifetime when you create it. An expired token gets 401. Revoke one in Settings and it stops working immediately." Add a short **Debugging with Claude** subsection: the run view's **Give Claude access** button, what the brief holds, that the token is read-only and lasts 8 hours, and that a Full token from Settings is needed if Claude should act.
- `server/AGENTS.md`: in the `src/http/tokens.ts` row, add "(optional expiry; expired rows are swept after 7 days)".

## Data and interfaces

- `api_tokens.expires_at INTEGER` (epoch ms, nullable).
- `ApiTokenView` gains `/** When the token stops working; null if it never expires. */ expiresAt: number | null;`.
- `POST /api/tokens` body: `{ name, scope, expiresInMinutes?: number | null }`. Out of range → 400 "Lifetime in minutes must be a whole number from 5 to 525600."
- A Bearer request with an expired token → 401 `{ error: 'That API token has expired. Create a new one in Settings.' }`.

## Tests

`server/test/api.test.ts`, in `describe('API tokens')`:

- A token created with `expiresInMinutes: 60` lists `expiresAt ≈ createdAt + 3_600_000`. Without the field it lists `expiresAt: null` and works.
- An expired token is refused: create one, then set `expires_at = Date.now() - 1` with `run(...)`. `GET /api/overview` → 401 with the expired message, and `last_used_at` stays null.
- `expiresInMinutes: 1` and `'abc'` → 400 with the message above.

`server/test/pipeline.test.ts`, or wherever `cleanup` is already exercised (find with `grep -n cleanup server/test`):

- A token that expired 8 days ago is deleted. One that expired 1 day ago, and one with no expiry, remain.

`client/test/access.test.ts` (new):

- `claudeBrief` contains the origin, the token, the run id in the `runs/<id>` and `export` lines, `tickets/<ticketId>`, and the ISO expiry.

Browser check (Playwright, as the ticket asks). Sign in on the dev server, open a run, click **Give Claude access**, and confirm the brief appears. Run the `curl` lines from it against the dev server, and confirm `GET /api/runs/<id>` answers 200 and `PUT /api/settings` answers 403. Then open Settings and check that the token is listed with its expiry. Save screenshots of both to `/work/media/`.

Run `npm run typecheck` and `npm test`.

## Risks and open questions

- **The brief puts a live token into Claude's context and the user's terminal history.** That's the point. It's read-only, and it lapses in 8 hours, which is much less than the 30-day full session that gets pasted today.
- **Server-side logs (stdout) aren't reachable through the API.** Some failures only show there. That's out of scope here; the run log, the run's `error` and the alerts cover most cases. A later ticket could expose recent server errors as an alert or an endpoint.
- **The default lifetime in Settings changes from never to 1 day.** Someone creating a token for home automation has to pick "Never". The select makes that visible, so it's an acceptable nudge toward short-lived tokens.
