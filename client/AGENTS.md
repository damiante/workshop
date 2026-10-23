# client/AGENTS.md

The Workshop UI: React 19, React Router 8, Vite. Plain CSS with custom properties, no UI kit. Built to `client/dist`, which the server serves.

## Structure

| Path | What it does |
|---|---|
| `src/main.tsx` | Fonts, theme, the sign-in gate, routes |
| `src/api.ts` | `api()` fetch wrapper (throws `ApiError` carrying the server's message), `useApi(path, topics)`, `useNow()`, the shared live stream |
| `src/live.ts` | `LiveStream`: an EventSource that reconnects itself (backoff, 40 s silence watchdog, `wake()`), testable without a browser |
| `src/format.ts` | Labels for agents and run statuses, durations, times, money |
| `src/transcript.ts` | Pure reducer: run log lines → steps, prose, tool calls with results attached, to-do list, outcome. Tested in `test/` |
| `src/components/` | `Layout` (sidebar, mode switch, allowance meters), `ui.tsx` (`Status`, `Meter`, `Modal`, `Panel`, `ErrorNote`), `ThemeToggle` |
| `src/pages/` | Login, Dashboard, Tickets, Runs, RunView, Connections, Agents, Settings, Alerts, Ticket (a ticket's lifecycle, `tickets/:id`), Media (a ticket's screenshots, `tickets/:id/media`) |
| `src/theme.css` | Every colour, size and component style |

## Data flow

- Types come from `../../server/src/api-types.ts`, **type-only**. Never import other server modules: they pull in Node built-ins.
- `useApi('/overview', ['runs', 'tickets'])` fetches on mount and refetches when the server publishes one of those topics on `/api/events`. Bursts are coalesced (at most 250 ms from the first event), failed refetches retry with backoff until they succeed; after a reconnect everything refetches once. The stream reconnects itself, closes while the tab is hidden and refetches when it's shown, and `useApi` drops out-of-order responses. To make a new view live, publish the topic on the server where the data changes.
- The run view streams `/api/runs/:id/log` with its own `LiveStream`. A reconnect resumes with `?after=<last index>`, and the server's `end` event (the run finished) stops it.
- Two models share `LiveStream`: the run log pushes data and resumes by index; views get topic notices and refetch, because the server derives their data from several tables.
- A 401 from any call fires `workshop:signed-out`, which shows the sign-in screen.

## Visual rules

The brief: subtle, workshop-like, **browns and greys only**. No textures, illustrations or themed props, and no themed names (Dashboard, not "Workbench").

- **Colours** are tokens in `theme.css`: `--bg`, `--surface`, `--raised`, `--line`, `--text`, `--muted`, `--accent` (brown), `--on-accent`.
  - Dark by default; light follows the system, unless the toggle sets `data-theme` on `<html>`.
  - **Every text pair must meet WCAG AA in both themes.** Check the contrast when adding a token.
- **Status colours** (`--ok`, `--attention`, `--error`) are muted and used for dots and fills, always with words next to them (`<Status tone>`). For text use `--error-text`: plain `--error` is too dim for text on dark surfaces.
- **Type:** IBM Plex Sans everywhere, IBM Plex Mono only for logs, code, commands and IDs. Sentence case, no all-caps labels.
- **Layout:** bordered panels and compact lists or tables, not grids of identical cards. Radius 4px on controls and 6px on panels; shadows only on modals.
- **Motion:** only the running indicator's slow pulse. `prefers-reduced-motion` turns it off.
- **Phones:** the sidebar becomes a bottom bar under 760px. Content must wrap, never scroll sideways (tables sit in `.table-wrap`).

## Copy

Plain verbs in sentence case. Buttons say what happens ("Save and check", "Create the GitHub App"). Errors come from the server's `{ error }` and are shown as-is, so write server messages for people. Empty states say what to do next.

## Testing

`npm test --workspace client` (Vitest) covers `transcript.ts`; add a test there when changing how logs are read. `npm run typecheck` covers the rest. To look at real screens, run the server (`npm run build && npm start`, or both dev servers) and use a browser at phone and desktop widths in both themes.
