# 155: Tell me when a customised agent prompt has fallen behind Workshop's default

## Context

`agent_classes.prompt` is `NULL` (use `DEFAULT_PROMPTS[name]`) or the full custom text (`server/src/agents.ts`). Nothing records which default a customisation started from, so when a later release changes the default (as #90 did for Implementation), a customised agent silently keeps the old instructions.

Outcome: Workshop stores the default each customisation was based on. When the current default differs, the Agents page flags that agent, shows the old and new default as a line diff, and offers **Dismiss** and **Reset to default**. One alert is raised per default change. Nothing is merged automatically. Rows customised before this change have no stored base: they get a one-off "can't tell" note and are never flagged.

## Approach

- Store the **full default text** (`prompt_base`), not a hash: the diff needs the old text, and prompts are small.
- The base is written by the server, never sent by the client:
  - prompt becomes `NULL` (empty, or equal to the default): `prompt_base = NULL`;
  - the saved prompt text differs from the stored `prompt`: `prompt_base = DEFAULT_PROMPTS[name]` (current default);
  - otherwise (e.g. only the model changed; the form always sends `prompt`) the base stays as it is. Without this rule, saving a model change would silently clear the flag. Editing the prompt counts as "saving again" and clears it, as the ticket asks.
- **Dismiss**: a new route sets `prompt_base` to the current default without touching `prompt`. This also clears the legacy "can't tell" note, after which the row is tracked from today's default.
- **Alert**: `checkPromptDefaults()` runs at boot after `seedAgents()`. Defaults only change when Workshop is upgraded, so boot is enough. For each customised row whose base differs from the current default, it raises a warning once per default text. A `prompt_alerted` column holds `sha256` of the default it last alerted about, so acknowledged alerts don't come back on every restart, even after the alert sweep deletes them. Saving with a new base, dismissing or resetting calls `clearAlert('prompt-default', name)`.

## Changes

### `server/src/db.ts`
Append one migration:
```sql
-- The default instructions a customised prompt was based on; null: not customised, or customised before Workshop recorded it (#155).
ALTER TABLE agent_classes ADD COLUMN prompt_base TEXT;
ALTER TABLE agent_classes ADD COLUMN prompt_alerted TEXT; -- sha256 of the default last raised as an alert
```

### `server/src/agents.ts`
- `AgentRow` gains `prompt_base: string | null`, `prompt_alerted: string | null`.
- `agentViews()` adds the two view fields (below): `defaultBefore = row.prompt !== null && row.prompt_base !== null && row.prompt_base !== DEFAULT_PROMPTS[name] ? row.prompt_base : null`; `defaultUnknown = row.prompt !== null && row.prompt_base === null`.
- `updateAgent()` computes `prompt` as today, then `base` using the rules in Approach (compare the new `prompt` with `row.prompt`). It writes `prompt_base` in the same `UPDATE`. When the base changed or became null, it calls `clearAlert('prompt-default', name)`.
- New `acceptDefault(name)`: `UPDATE agent_classes SET prompt_base = ? WHERE name = ? AND prompt IS NOT NULL` with the current default, then `clearAlert('prompt-default', name)` and `publish('agents')`.
- New `checkPromptDefaults()`: for each row with `prompt` and `prompt_base` both set, `prompt_base !== DEFAULT_PROMPTS[name]` and `prompt_alerted !== sha256(DEFAULT_PROMPTS[name])`, call `raiseAlert('warning', 'prompt-default', \`Workshop's default instructions for ${AGENT_INFO[name].label} have changed since you customised them. Compare them on the Agents page.\`, name)` and store the hash in `prompt_alerted`. Use `sha256` from `crypto.ts`.

### `server/src/index.ts`
Call `checkPromptDefaults()` right after `seedAgents()`.

### `server/src/http/api.ts`
`POST /api/agents/:name/accept-default`: `check(AGENT_NAMES.includes(name), 'Unknown agent.', 404)`, then `acceptDefault(name)`, then respond with the agent's view (as the PUT does). No `kick()` is needed.

### `server/src/http/openapi.ts`
- `AgentClassView`: add `defaultBefore: nullable(str)` and `defaultUnknown: bool`.
- Add the route: `post: { summary: "Marks a customised agent's instructions as checked against the current default, which clears the out-of-date flag.", params: ['name'], ok: ref('AgentClassView'), errors: [403, 404] }`.

### `docs/api.md`
Add one sentence on `defaultBefore` / `defaultUnknown` and the accept-default route.

### `client/src/diff.ts` (new, pure)
`lineDiff(before: string, after: string): { kind: 'same' | 'added' | 'removed'; text: string }[]`, using an LCS over lines. Prompts are tens of lines, so O(n·m) is fine. No dependency.

### `client/src/components/DefaultChange.tsx` (new)
The notice, kept out of `Agents.tsx` because `api.ts` touches `document` on import and couldn't be rendered in tests. Props: `{ agent: AgentClassView; onDismiss: () => void; onReset: () => void }`. Renders nothing unless `agent.defaultBefore !== null || agent.defaultUnknown`.
- Changed: `<div className="notice">` with "Workshop's default instructions for this agent have changed since you customised them. Carry over what you want, then save." It has a `<details open>`, "What changed in the default", that holds a `<pre className="mono small diff">` with one line per entry, prefixed `+ ` or `- ` or two spaces. The buttons are **Dismiss** (`onDismiss`) and **Reset to default** (`onReset`), as `button.link small`.
- Unknown: a `notice` reading "You customised these instructions before Workshop kept track of its defaults, so it can't tell whether the default has changed since." It has one button, **Dismiss**, which uses the same route.

### `client/src/pages/Agents.tsx`
Render `<DefaultChange>` just above the Instructions field. `onDismiss` calls `api(\`/agents/${name}/accept-default\`, { method: 'POST' })`, and errors go to the form's `ErrorNote`. `onReset` does what the existing reset link does, `set({ prompt: agent.defaultPrompt })`, so the owner still clicks Save, consistent with today. While the draft equals the default, hide the notice: the draft is no longer customised. The `agents` topic refreshes the view after a save or dismiss.

### `client/src/theme.css`
`.diff .added` and `.diff .removed`: use the background `color-mix(in srgb, var(--ok) 18%, transparent)` or `var(--error)` respectively, with text in `var(--text)`. The `+`/`-` prefix carries the meaning, not the colour. Check AA contrast in both themes.

## Data and interfaces

- DB: `agent_classes.prompt_base TEXT`, `agent_classes.prompt_alerted TEXT` (one new migration).
- `AgentClassView` (`server/src/api-types.ts`), with doc comments:
  - `defaultBefore: string | null`: the default the customisation was based on, when it differs from today's `defaultPrompt`;
  - `defaultUnknown: boolean`: customised before Workshop recorded the base.
- New route `POST /api/agents/:name/accept-default` → `AgentClassView`. The existing `PUT /api/agents/:name` is unchanged; it ignores any client-sent base.
- Alert kind `prompt-default`, ref = agent name.

## Tests

`server/test/api.test.ts`, next to "treats a prompt equal to the default as not customised":
1. PUT `{ prompt: 'Be brief.' }` stores `prompt_base` equal to `DEFAULT_PROMPTS.classifier` (read the row with `db.prepare`). The view has `defaultBefore: null`, `defaultUnknown: false`.
2. Simulate a default change with `UPDATE agent_classes SET prompt_base = 'Old default.'`. `/api/agents` then reports `defaultBefore: 'Old default.'`.
3. A PUT that changes only `model` but sends the same `prompt` keeps the flag. A PUT with an edited prompt clears it.
4. Re-flag, then POST `accept-default` clears it and leaves `prompt` unchanged. Re-flag, then PUT the default text: `customised: false`, `defaultBefore: null`.
5. Legacy row (`prompt` set, `prompt_base` NULL): `defaultUnknown: true`, `defaultBefore: null`. After accept-default, `defaultUnknown: false`.
6. `checkPromptDefaults()`: a flagged row raises one `prompt-default` alert. Acknowledge it, call again, and no new alert appears. Accept-default acknowledges an open one.
7. Unknown agent on accept-default: 404 `Unknown agent.`. The existing openapi route and `/agents` schema-field tests cover the new fields and route.

Client:
- `client/test/diff.test.ts`: added, removed and unchanged lines, with an empty before or after.
- `client/test/default-change.test.tsx`: `renderToStaticMarkup(<DefaultChange …>)` with `defaultBefore` set shows the copy, a `- ` old line and a `+ ` new line, and both buttons. With `defaultUnknown` it shows the "can't tell" note. With neither it renders an empty string.

Browser check: build and run the server, customise the Implementation prompt, then set `prompt_base` in the DB to the pre-#90 default. Screenshot the Agents page in both themes at desktop and phone widths and save them to `/work/media/`.

Run: `npm run typecheck && npm test`.

## Risks and open questions

- Interpretation: "Saving the prompt again records the current default" is applied only when the prompt text changes (or on Dismiss), so a model-only save doesn't hide the flag. An unchanged re-save doesn't clear it; Dismiss does that.
- Reset keeps today's behaviour: it fills the default into the draft, and Save applies it. It is not an immediate server write.
- Each customised agent stores an extra copy of a default (a few KB): negligible.
