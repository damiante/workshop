# API for scripts and other tools (#2)

## Context

You can only reach Workshop's HTTP API from the browser today. `requireAuth` accepts nothing but the session cookie, and a session needs the password plus a TOTP code, so a script or a home-automation tool can't sign in. The ticket asks to launch agents, switch Workshop on and off, and read usage over HTTP, with a documented schema.

Most of the endpoints already exist in `server/src/http/api.ts`:

| Need | Existing endpoint |
|---|---|
| Switch Workshop on and off | `PUT /api/settings` with `{ "mode": "paused" \| "scheduled" \| "always" }` (partial patch) |
| Status, queue, hosts | `GET /api/overview` |
| Stop a run | `POST /api/runs/:id/stop` |
| Tickets, runs, logs, alerts, sync, agents | `GET /api/tickets`, `/runs`, `/runs/:id/log`, `/alerts`, `POST /api/sync`, `PUT /api/agents/:name` and others |

Three things are missing:

1. A way for a non-browser client to authenticate.
2. An endpoint that starts an agent on a ticket now.
3. A single usage reading that includes API spend.

There is also no schema.

Outcome: you create an API token in Settings, then call the existing endpoints and three new ones with `Authorization: Bearer <token>`. An OpenAPI 3.1 document at `GET /api/openapi.json` describes all of them.

## Approach

- **API tokens instead of a second login flow.**
  - Tokens are random (`wks_` + `randomToken()`), shown once, and stored as `sha256` hashes, like sessions.
  - Each token has a scope: `read` allows only GET and HEAD; `write` allows everything a token can reach.
  - `requireAuth` checks the `Authorization: Bearer` header first, then the cookie.
  - A Bearer request can't come from another site: CORS isn't enabled, so browsers won't send the header cross-origin. `sameOrigin` can stay as it is.
- **Tokens stay inside the operating API.** Token requests can use `apiRouter`, but not `connectionsRouter` or the token endpoints themselves.
  - Connections hold the GitHub App key and root-equivalent Docker hosts. A leaked token mustn't be able to repoint them or create more tokens.
  - Managing tokens and connections needs a signed-in session. A `sessionOnly` middleware enforces this.
- **Launch is the scheduler's own decision, made on request.** `POST /api/tickets/:id/launch` builds the queue with the mode and operating-hours gate turned off, takes that ticket's candidate, and launches it the same way `tick()` does. Every other gate still applies: dependencies, model configuration, allowance (still fail closed), the API cap and host capacity. A blocked ticket gets 409 with the queue's reason. This respects the invariants and doesn't add a second launch path.
  - Mode and hours are skipped because an explicit request is the permission. Without that, launching anything while Workshop is paused would be impossible, and pausing is how you stop *automatic* starts.
- **Usage is one endpoint.** `GET /api/usage` returns the per-connection allowance views, the thresholds, and today's API spend against the caps. `/overview` already includes allowance but not spend.
- **Hand-written OpenAPI document as a TypeScript constant.** It's served by the API, and a test checks that it covers every route. This adds no dependencies (no generator, no validator). The test also compares top-level response keys against the schema, which catches most drift from `api-types.ts`.
- **Mode stays on `PUT /api/settings`.** A dedicated `/mode` endpoint would duplicate it. The docs show the one-line call.

## Changes

### `server/src/db.ts`
Append this migration:
```sql
CREATE TABLE api_tokens (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL,          -- 'read' | 'write'
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
```

### `server/src/http/auth.ts`
- `readBearer(req)`: returns the token from `Authorization: Bearer <token>`, or null.
- `checkToken(token)`: looks up the row by `sha256(token)` and returns `{ id, scope }` or null. It updates `last_used_at` when the stored value is more than 60 s old.
- `requireAuth`:
  - With a Bearer header:
    - an unknown token gets 401 `{ error: 'That API token is wrong or was revoked.' }`, with no redirect;
    - a `read` token on a method other than GET or HEAD gets 403 `{ error: 'This API token is read-only.' }`;
    - otherwise set `res.locals.token = { id, scope }` and call `next()`.
  - Without one: the session path stays as it is.
- `export function sessionOnly(req, res, next)`: when `res.locals.token` is set, reply 403 `{ error: "API tokens can't manage connections or tokens. Sign in to Workshop to do that." }`.

### `server/src/http/tokens.ts` (new)
`tokensRouter`:
- `GET /tokens` returns `ApiTokenView[]`, newest first.
- `POST /tokens` takes `{ name, scope }`.
  - `name`: trimmed, 1 to 60 characters. Otherwise 400 `Give the token a name of up to 60 characters.`
  - `scope`: `read` or `write`. Otherwise 400 `Scope must be read or write.`
  - Responds 201 with `{ token, view }` (`NewApiToken`). The token is only ever returned here.
- `DELETE /tokens/:id` deletes the token, or returns 404 `Token not found.`

Each route calls `publish('tokens')`.

### `server/src/app.ts`
`app.use('/api', requireAuth, apiRouter, sessionOnly, tokensRouter, connectionsRouter);`
Express falls through `apiRouter` for paths it doesn't match, so `sessionOnly` only affects the later routers. Side effect: a token request to an unknown path gets 403 rather than 404. That's acceptable.

### `server/src/scheduler/loop.ts`
- `buildQueue(s, now, opts: { ignoreMode?: boolean } = {})`: with `ignoreMode`, `modeReason` is null.
- Extract `startCandidate(c: Candidate): string | null` from `tick()`. It contains the existing `launch({...})` call, with `attempt: c.ticket.failures + 1`. `tick()` uses it.
- Export `startOfDay`.
- Add `export function launchNow(ticketId: number): string`. It throws `HttpError`s, importing `HttpError` and `check` from `http/util.ts`, which has no imports.
  1. `getTicket` → 404 `Ticket not found.`
  2. If `activeRunId(ticketId)` is set → 409 `An agent is already working on this ticket.`
  3. `c = buildQueue(getSettings(), Date.now(), { ignoreMode: true }).find(c => c.ticket.id === ticketId)`. When there's none → 409 `There's nothing for an agent to do on this ticket right now.` This covers tickets with no next step, waiting for your review, failed, from an author who isn't allowlisted, or closed.
  4. If `c.blockedBy` is set → 409 `Can't start an agent yet: ${c.blockedBy}.`
  5. `startCandidate(c)`. If it returns null (a race on the unique index), reply with the same 409 as step 2.
  6. Return the run id.

### `server/src/http/api.ts`
- `POST /tickets/:id/launch` → `const id = launchNow(int(req.params.id, 'Ticket id', 1, Number.MAX_SAFE_INTEGER))`, then `res.status(202).json(runView(id))`.
- `GET /usage` returns `Usage`:
  - `allowance: allowanceViews()`;
  - `thresholds` (same as overview);
  - `apiSpendTodayUsd: apiSpendSince(startOfDay(now, s.timezone))`;
  - `apiRunCapUsd`, `apiDailyCapUsd` from settings.
- `GET /openapi.json` → `res.json(OPENAPI)`.

### `server/src/http/openapi.ts` (new)
- `export const OPENAPI = { openapi: '3.1.0', info: { title: 'Workshop', version: config.version }, servers: [{ url: '/api' }], security: [{ bearer: [] }, { session: [] }], components: { securitySchemes, schemas }, paths }`.
- It documents every `apiRouter` route: method, path parameters (`{id}` form), request body, success response, and the error response `{ error: string }` for 400, 401, 403, 404 and 409 where they apply.
  - Mark SSE routes (`/runs/{id}/log`, `/events`) `text/event-stream`, with a short description of the payload.
  - Mark every non-GET route `x-workshop-scope: write`.
- `components.schemas` mirrors `api-types.ts`: `Settings`, `Overview`, `TicketView`, `RunView`, `AgentClassView`, `ModelOption`, `AllowanceView`, `UsageWindow`, `HostView`, `QueueItem`, `AlertView`, `LogEntry`, `Usage` and `Error`. Use `$ref` and `required` lists. Enumerate `Mode`, `RunStatus` and the others as enums.
- Token and connection routes are session-only, so they're left out. The document says so in `info.description`.

### `server/src/api-types.ts`
- `Topic`: add `'tokens'`.
- Add:
  ```ts
  export type TokenScope = 'read' | 'write';
  export interface ApiTokenView { id: number; name: string; scope: TokenScope; createdAt: number; lastUsedAt: number | null }
  export interface NewApiToken { token: string; view: ApiTokenView }
  export interface Usage { allowance: AllowanceView[]; thresholds: { fiveHour: number; weekly: number }; apiSpendTodayUsd: number; apiRunCapUsd: number; apiDailyCapUsd: number }
  ```

### `client/src/pages/Settings.tsx`
Add an **API tokens** panel, outside the settings form, so it doesn't use the form's submit:
- A table of name, access ("Read only" or "Full"), created, and last used ("Never"). Each row has a **Revoke** button with a `confirm()`.
- A form with a name field, a "Read only" checkbox and a **Create token** button.
- After it's created, show the token once in a read-only input, with a **Copy** button and the note "Copy this token now. Workshop won't show it again."
- Use `useApi<ApiTokenView[]>('/tokens', ['tokens'])` and `api()`. Follow the existing `Panel` and `ErrorNote` patterns and client/AGENTS.md.
- A short line links to the API docs: "Scripts can use Workshop's API with a token. See docs/api.md."

### Docs
- `docs/api.md` (new, short):
  - creating a token, and what scopes allow;
  - that connections and tokens need the web sign-in;
  - curl examples: switch mode, read usage, launch a ticket, stop a run;
  - error format and status codes;
  - pointer to `/api/openapi.json`.
- `README.md`: one line under the existing settings or usage section, linking `docs/api.md`.
- `server/AGENTS.md`:
  - map rows for `http/tokens.ts` and `http/openapi.ts`;
  - an invariant: "Add every new `apiRouter` route to `openapi.ts` (a test enforces it). Tokens never reach connections or tokens."

## Data and interfaces

- **DB:** new table `api_tokens`.
- **New endpoints:**
  - `POST /api/tickets/:id/launch` (202 `RunView`, or 404/409);
  - `GET /api/usage` (`Usage`);
  - `GET /api/openapi.json`;
  - `GET`/`POST /api/tokens`, `DELETE /api/tokens/:id` (session only).
- **Auth:** `Authorization: Bearer wks_…` is accepted on all `apiRouter` routes. `read` tokens are limited to GET and HEAD.
- **Types:** `TokenScope`, `ApiTokenView`, `NewApiToken`, `Usage`, and the `'tokens'` topic.

## Tests

Run `npm run typecheck` and `npm test`.

**`server/test/api.test.ts`** (using the existing session cookie):
- Tokens:
  - creating one returns `wks_…` once, and `GET /tokens` never includes it;
  - a bad name or scope gets 400.
- Bearer:
  - a `write` token can `GET /overview` and `PUT /settings {mode:'always'}`;
  - an unknown or revoked token gets 401 JSON (no redirect, even with `Accept: text/html`);
  - a `read` token gets 403 on `PUT /settings` and 200 on `GET /usage`;
  - `last_used_at` is set.
- `sessionOnly`: a token gets 403 on `GET /connections`, `POST /tokens` and `DELETE /tokens/:id`, while the cookie works.
- `GET /usage` returns `apiSpendTodayUsd: 0` and the caps from settings.
- Launch:
  - 404 for an unknown ticket;
  - 409 "nothing to do" for a seeded ticket with no next step;
  - 409 `Can't start an agent yet: No agent hosts connected.` (or the model reason) for a ticket at a stage, with Workshop paused. This proves the mode is ignored and the remaining gates aren't.
- OpenAPI:
  - walk `apiRouter.stack` (`layer.route.path` and methods, converting `:id` to `{id}`) and assert that the set equals the document's paths and methods;
  - for `/overview`, `/settings`, `/usage` and `/agents`, assert that the response's top-level keys equal the schema's `properties` keys.

**`server/test/pipeline.test.ts`** (providers mocked):
- With `mode: 'paused'`, a fake host and a configured model, `launchNow(ticketId)` creates a run that drives to `succeeded` like a scheduled one.
- A second `launchNow` while that run is active gets 409.
- A ticket held by `blocked_by` gets 409 `Depends on #2`.

## Risks and open questions

- **Launching while paused** is deliberate (see Approach). If the owner wants launch to respect the mode, drop `ignoreMode`. It's a one-line change.
- **Token blast radius:** a `write` token can change settings and agent prompts, and so steer agents. It can't touch connections or credentials. Tokens don't expire. You revoke them in Settings.
- **Spec drift:** the route-coverage and key tests catch missing routes and renamed fields, but not nested type changes. That's accepted, to avoid a validator dependency.
- **Overlap with #3** (environment toggle): if #3 lands first, any route it adds to `apiRouter` must be added to `openapi.ts`. The coverage test will flag it.
