# Change a ticket's status from the UI (#7)

## Context

A ticket's state is its `workshop/*` labels (see [workflow.md](../design/workflow.md)). To override it today, you edit the labels on GitHub and wait for the next sync. You want to do the same from the Tickets page: pick the stage, size and flags, and have Workshop write the labels to GitHub straight away.

Outcome: each ticket card on the Tickets page has a **Change status** control. Saving it changes the labels on GitHub through the existing `editLabels` path, mirrors them locally, and the board updates.

## Approach

- **One endpoint that sets the parts of the state, not raw labels.** `PUT /api/tickets/:id/state` takes `{ stage?, size?, needsInfo?, skip?, failed? }`; only the fields sent change. The server turns that into label edits with the existing pure helpers `moveTo` and `setSize`, so a ticket can never end up with two stage or two size labels, and `workshop/running` can't be set by hand. Raw label editing was rejected because it would let you break the "one stage label" invariant.
- **Refuse while an agent is active** (`activeRunId`, so paused runs count) with a 409: `An agent is working on this ticket. Stop it in the run view first.` Changing labels under a running agent races `publishRun`, which plans from the labels it reads at the end (size decides design vs design review, the stage decides the transition). Stop already exists and labels the ticket `failed`, which you can then clear here. Stopping automatically was rejected: it's destructive and hidden behind a label edit.
- **Clearing `failed` resets the attempt count.** Sync resets `tickets.failures` only when it sees `workshop/failed` disappear *compared with the local mirror*. `editLabels` updates the mirror first, so sync would never notice; the endpoint must run `UPDATE tickets SET failures = 0` itself when it removes `failed`.
- **After saving:** `kick()` so the scheduler re-evaluates (a push settles through the existing `pushEnded` rule: changing the stage ends a stage push; adding `needs-info`/`skip`/`failed` ends any push). No other side effects: no comments on GitHub, no branch creation, no PR changes.
- **Same access as pushing.** Ticket lookup uses `pushableTicket` (404 when missing, repo disabled, or author not allowed); read-only API tokens are already refused for non-GET methods.

## Changes

### `server/src/workflow/labels.ts`
Add a pure helper next to `moveTo`/`setSize`:
```ts
export interface StatePatch { stage?: Stage | null; size?: Size | null; needsInfo?: boolean; skip?: boolean; failed?: boolean }

/** Label edits that apply `patch`, keeping one stage and one size label at most. Fields left out stay as they are. */
export function stateEdits(labels: string[], patch: StatePatch): { add: string[]; remove: string[] }
```
- `stage` present: merge in `moveTo(labels, patch.stage)`.
- `size` present: `setSize(labels, size)`; `null` removes every size label.
- Each flag present: add or remove `label.needsInfo` / `label.skip` / `label.failed`.
- Return only real edits (labels to add that are missing, labels to remove that are present). `editLabels` filters too, but tests read cleaner on the exact result.

Put `StatePatch` in `server/src/api-types.ts` instead (as `TicketStatePatch`) so the client can type its request body; `labels.ts` already imports types from there.

### `server/src/http/api.ts`
New route after the push routes:
```ts
apiRouter.put('/tickets/:id/state', async (req, res) => {
  const { t, repo } = pushableTicket(req.params.id);
  const b = req.body ?? {};
  const patch: TicketStatePatch = {};
  // stage: null or one of STAGES -> 'Choose a stage.'
  // size: null or one of SIZES -> 'Choose a size: XS, S, M, L or XL.'
  // needsInfo/skip/failed: boolean -> 'needsInfo, skip and failed must be true or false.'
  check(Object.keys(patch).length, 'Send at least one of stage, size, needsInfo, skip or failed.');
  check(!activeRunId(t.id), 'An agent is working on this ticket. Stop it in the run view first.', 409);
  const { add, remove } = stateEdits(labelsOf(t), patch);
  try {
    await editLabels(t, add, remove);
  } catch (err) {
    throw new HttpError(502, `Couldn't update the labels on GitHub: ${(err as Error).message}`);
  }
  if (remove.includes(label.failed)) run('UPDATE tickets SET failures = 0 WHERE id = ?', t.id);
  kick();
  res.json(ticketView(t, repo));
});
```
- Only copy fields that are present (`'stage' in b`), as `PUT /agents/:name` does.
- Closed tickets: allowed (harmless; `nextStep` ignores them). No special case.
- A GitHub failure becomes a readable 502 (`HttpError` from `util.ts`; the `app.ts` handler would otherwise send a 500). Nothing is mirrored locally then, because `editLabels` writes remote first.

### `server/src/http/openapi.ts`
- Add `'/tickets/{id}/state': { put: { summary: 'Sets the ticket\'s stage, size or flags by changing its workshop labels on GitHub. Send only the fields to change; stage and size may be null to clear them. Refused while an agent works on the ticket.', params: ['id'], body: <object schema of the five fields>, ok: ref('TicketView'), errors: [400, 403, 404, 409] } }`.
- Add `Stage` and `Size` enum schemas if they aren't there yet, and use them in the body.

### `client/src/pages/Tickets.tsx`
- New `StatusEditor({ t, onClose })` rendered in the shared `Modal` (title `Change status of #<number>`):
  - **Stage** `<select>`: `To classify` (null), `Design`, `Design review`, `Implementation`, `Your review`, `Merge`, `Re-classify changes` (reuse the `COLUMNS` titles' wording where they exist).
  - **Size** `<select>`: `Not sized` (null), `XS` … `XL`.
  - Checkboxes: `Waiting for your answer (needs-info)`, `Skipped`, `Stopped after failures`.
  - Initial values from `t.stage`, `t.size`, `t.needsInfo`, `t.skipped`, `t.failed`. Send only fields that changed.
  - Button **Save labels on GitHub**, disabled while sending or when nothing changed; on success close; on error `ErrorNote` with the server's message.
  - A one-line muted note: `Workshop changes the issue's workshop labels. The next stage starts when Workshop's mode allows it.`
- In `Card`, a small **Change status** button (beside `PushControls`). Hide it when `t.activeRunId` is set; the card already links to the running agent.
- The board refetches on the `tickets` topic, which `editLabels` publishes.

### Docs
- `docs/design/workflow.md`, "Labels are the state": add one sentence that you can also change them from a ticket's **Change status** on the Tickets page, which writes the labels to GitHub straight away, isn't available while an agent works on the ticket, and resets the attempt count when it clears `failed`.

## Data and interfaces

- No schema change.
- API: `PUT /api/tickets/:id/state`, body `TicketStatePatch` (`stage?: Stage | null`, `size?: Size | null`, `needsInfo?`, `skip?`, `failed?: boolean`). Returns `TicketView`. Errors: 400 bad body, 403 read-only token, 404 ticket, 409 agent active, 502 GitHub failure.
- Types: `TicketStatePatch` in `api-types.ts`.

## Tests

Run `npm run typecheck` and `npm test`.

**`server/test/workflow.test.ts`** — `stateEdits`:
- moving from `stage:design` to `implement` removes the old stage label and adds the new one; `stage: null` removes it;
- size change replaces the size label; `size: null` removes it;
- flags add and remove; omitted fields leave labels alone (`workshop/running`, unrelated labels untouched);
- a patch matching the current labels gives no edits.

**`server/test/api.test.ts`** — new `describe('changing a ticket\'s status')`, seeded like the push test, plus a mocked ticket source so `setLabels` records calls (`vi.mock` of `providers/index.ts`'s `ticketsOf`, or a `ticket_connection_id` pointing at a fake, whichever the file can do without disturbing other tests; `pipeline.test.ts` shows the mock pattern):
- 400 for an unknown stage, a bad size, a non-boolean flag, and an empty body; 404 for an unknown ticket;
- 200: `{ stage: 'merge', size: 'l' }` calls `setLabels` with the right add/remove, and the response and DB labels match;
- clearing `failed` on a ticket with `failures = 2` returns it to 0;
- 409 with the "Stop it in the run view first" message when a run row with status `running` exists for the ticket;
- a read-only API token gets 403.

The OpenAPI test already checks that the new route is documented.

## Risks and open questions

- **Moving a ticket ahead without the artefacts.** Setting `implement` without a design, or `merge` without a pull request, is your override; Workshop does what the labels say. `merge` without a PR is already handled (`advanceMerge` clears the stage and raises an alert). `pr-review` without a PR just waits. No extra guard.
- **Sync overwrite.** If you also edit labels on GitHub at the same time, the next sync takes GitHub's labels, which is the existing rule.
- **No comment on the issue** about the manual change. GitHub's own label timeline already records it under the app's name.
