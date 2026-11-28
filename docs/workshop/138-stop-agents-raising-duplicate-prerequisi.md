# Design for #138: stop agents raising duplicate prerequisites

## Context

Agents that return `raise_blockers` (#123) open near-duplicates of tickets that already exist:

- The Classifier sees only the 30 most recently updated open tickets (`MAX_OPEN_TICKETS`, `workflow/prompts.ts`).
- Design and Implementation (`BLOCKING_AGENTS`) see none.
- `raiseBlockers` (`scheduler/runner.ts`) only reuses a ticket with an identical title (`sameTitle`).

We want three things:

1. Every agent that may raise prerequisites can search all open tickets.
2. The server links a strongly similar open ticket instead of opening a new one.
3. A runaway rate of raised tickets shows up as an alert.

The exact-title reuse, the `blocked_by` handling, `MAX_NOTICED` and the rule that raised tickets can't raise all stay as they are.

## Approach

1. **Index file.** `runSpec` writes `/work/.workshop/open-tickets.jsonl` (the files land under `/work`, outside the repo, so the file is never committed). It has one line per open ticket from an allowed author in the repo, excluding this ticket, most recently updated first: `{"number","title","labels","body"}`, with `body` cut to its first 500 characters. It is written for the Classifier always, since it already gets the open-ticket list, and for Design and Implementation when `mayRaiseBlockers` is true. It uses the same query as the Classifier's `openTickets`, so the inline 30-item list stays as it is. Like the prompt, it is written only when `r.resumes === 0`; a resumed run still has it on its volume.
2. **Prompt rule.** The Classifier's task line (when `raiseBlockers` is set) and the `protocolText` blockers rule both gain the same sentence, kept in one constant:
   > Before raising anything, search `/work/.workshop/open-tickets.jsonl` (one JSON object per line: number, title, labels, body) for an open ticket that covers the same mechanism. Search by keyword and by meaning (`grep -i`, `jq`), not only by title. If one exists, put its number in `blocked_by` instead. Name a raised ticket after the mechanism it builds, not the feature that needs it, so the next agent can find it.

   The Classifier's text goes in the task line rather than `DEFAULT_PROMPTS.classifier`, because owners can override the default prompts. The Classifier's inline list also ends with "All N open tickets are in `/work/.workshop/open-tickets.jsonl`."

   Design and Implementation have no `blocked_by` today: `schemaFor` adds only `outcome: blocked` and `raise_blockers` for `BLOCKING_AGENTS`, `parseResult` requires `raise_blockers` with `blocked`, and `planTransition` (transitions.ts:148) passes `[]` to `planWait`. Give them the Classifier's choice:
   - `schemaFor` adds `blocked_by` (integer list, "open tickets that must be finished first; blocked only") next to `raise_blockers`;
   - `parseResult` for blocking agents accepts `blocked` with a non-empty `blocked_by` or `raise_blockers` (an integer list check like the Classifier's). The message becomes "blocked requires blocked_by (open ticket numbers) or raise_blockers (new prerequisite tickets).";
   - transitions.ts:148 passes `r.blocked_by ?? []` to `planWait`, and `WorkResult` gains `blocked_by?: number[]`. The existing `blockers` step already links `plan.addBlockers`, rejects closed or non-issue numbers and drops cycles.
3. **Similarity check.** Add a new pure module, `server/src/workflow/similar.ts`:
   - `keywords(text): Set<string>`: lowercase, split on anything that isn't `[a-z0-9]`, drop tokens shorter than 3 characters and a short English stop-word list (the, and, for, with, from, that, this, into, when, its, are, can, …, plus `ticket`, `support`, `add`), then strip one suffix in this order: `ing`, `ed`, `es`, `s`, leaving at least 3 characters.
   - `jaccard(a, b)`.
   - `similarity(a: {title, body}, b: {title, body}) → { title: number; text: number; shared: number }`. `title` is the Jaccard of the title keywords, `shared` is the number of title keywords they have in common, and `text` is the Jaccard of the keywords of the title plus the first 500 characters of the body.
   - `isDuplicate(s)`: `(s.title >= 0.4 && s.shared >= 2) || s.text >= 0.4`. The thresholds are exported constants, so they can be tuned in one place.

   Worked example, the observed #3063 / #3059 pair:
   - "data-declared add-die roll offers paid from a feature pool" vs "overlay-declared roll offers that spend a resource die and add it to a roll".
   - Shared keywords: declared, add, die, roll, offer (5 of a union of 12), so title = 0.42.
   - That's a duplicate.

   "Save outcome modifiers" vs "Login page crashes on an empty password" scores 0. The thresholds are deliberately conservative: the agent-side search is the main defence, and the server check catches the obvious misses.
4. **In `raiseBlockers`**, keep the existing order: an earlier `raised` record with the same title, then an open ticket with the same title. Only after both, and before `createTicket`, score the proposal against these candidates:
   - every open ticket in the repo (from an allowed author, not this ticket, not a ticket whose `blocked_by` already holds this ticket, since linking that would be a cycle);
   - every entry in this ticket's `raised` list (title only, empty body), so two similar proposals in one run collapse.

   Take the best match that `isDuplicate` accepts, choosing by `max(title, text)`. If there is one, push `{ number, title, existing: true, instead: proposedTitle }` and don't create a ticket. Write the match to the run log with `appendLog(r.id, { step: 'workshop', stream: 'stdout', text })`: `Linked existing #N "<title>" instead of opening "<proposed>" (title 0.42 with 5 shared keywords, text 0.31).` `blockersLine` renders such an entry as `- #N <title> (linked existing #N instead of opening a new ticket for "<proposed>")`.

   We compare against all open tickets rather than only `workshop/raised` ones, because the second observed duplicate (#3064) was against an engine ticket a person had opened. Workshop has no "foundation" marker, so we don't invent one. `raiseNoticed` is left unchanged, since the ticket is about prerequisites.
5. **Rate alert.**
   - `Raised` gains `at?: number` (epoch ms), set in both `raiseNoticed` and `raiseBlockers`. Older records have no `at` and don't count.
   - `checkRaiseRate(repo)` (exported from `runner.ts`) counts the `raised` entries with `at >= now − 1 h` across the repo's tickets (`SELECT raised FROM tickets WHERE repo_id = ? AND raised IS NOT NULL`). The count includes noticed tickets as well as prerequisites: both are tickets agents open, and both can run away.
   - When the count is above `getSettings().raiseAlertPerHour`, it calls `raiseAlert('warning', 'raise-rate', "Agents opened N tickets in <repo> in the last hour, more than the limit of M. Check that they aren't duplicates, or turn off Agents open tickets for this repository.", 'repo:<id>')`. Otherwise it calls `clearAlert('raise-rate', 'repo:<id>')`.
   - It runs after each `createTicket` in both functions, and on every scheduler `tick()` for each enabled repo with `raise_tickets`, so the alert clears once the hour passes.
   - The alert only reports; it doesn't stop agents raising tickets.

## Changes

- `server/src/workflow/similar.ts` (new): `keywords`, `jaccard`, `similarity`, `isDuplicate` and the thresholds.
- `server/src/workflow/prompts.ts`:
  - an exported `INDEX_PATH = '/work/.workshop/open-tickets.jsonl'`, an `INDEX_BODY = 500` and the `SEARCH_INDEX` sentence;
  - the sentence goes into the `protocolText` blockers rule and the Classifier's `raiseBlockers` task lines;
  - the inline list's footer names the index. Add `indexed?: number` (the number of lines in the index) to `TaskContext` for the footer.
- `server/src/workflow/schemas.ts` (`schemaFor`, `parseResult`, `WorkResult`) and `transitions.ts` (line 148): `blocked_by` for `BLOCKING_AGENTS`, as in Approach 2.
- `server/src/scheduler/runner.ts`:
  - build the open-ticket rows once and use them for both `openTickets` and the index. Include `labels` in the select;
  - write the file under `.workshop/open-tickets.jsonl`;
  - the similarity step in `raiseBlockers`;
  - `instead?: string` on `Prerequisite`, and the new `blockersLine` text;
  - `at` on new `Raised` records;
  - `checkRaiseRate`.
- `server/src/tickets.ts`: `at?: number` on `Raised`.
- `server/src/scheduler/loop.ts`: in `tick()`, call `checkRaiseRate` for each `enabled = 1 AND raise_tickets = 1` repo.
- Settings field `raiseAlertPerHour`, default 10:
  - `api-types.ts` (`Settings`);
  - `settings.ts` (`DEFAULT_SETTINGS`);
  - `http/api.ts`: `int(b.raiseAlertPerHour, 'Alert limit for opened tickets', 1, 1000)`;
  - `http/openapi.ts` (the settings schema);
  - `client/src/pages/Settings.tsx`: a `NumberField` labelled "Alert when agents open more tickets per hour than", next to "Keep run history for (days)".
- `docs/design/workflow.md`: the Blockers paragraph (line ~132) and the Classifier row (line ~60). Describe the index, the similarity link and the rate alert.

## Data and interfaces

- No migration. `tickets.raised` is JSON, so its entries simply gain `at`.
- `Settings.raiseAlertPerHour: number`, in the API and `openapi.ts`.
- New container file `/work/.workshop/open-tickets.jsonl`.
- Design and Implementation results may carry `blocked_by` (with `outcome: blocked`) when raising is on.
- New alert kind `raise-rate`, ref `repo:<id>`.

## Tests

- `server/test/workflow.test.ts`:
  - `parseResult('design', …)` accepts `blocked` with only `blocked_by`, and rejects `blocked` with neither; `schemaFor('implement', { blockers: true })` has `blocked_by`.
  - `keywords`: stemming and stop words.
  - The #3063/#3059 title pair is a duplicate. "Save outcome modifiers" vs "Login page crashes on an empty password" isn't. Two titles that share one keyword aren't.
  - `protocolText({ blockers: true })` and the Classifier's `raiseBlockers` task line contain `INDEX_PATH`; `protocolText` without `blockers` doesn't.
- `server/test/pipeline.test.ts`, following the raise-blockers block around line 2870:
  - With 35 open tickets, the Classifier's run spec has `.workshop/open-tickets.jsonl` with 35 lines, including the oldest ticket (one not among the 30 in the prompt), with labels and a body cut to 500 characters. So does Design's when raising is on. The Code reviewer's spec has no index, and neither does Design's when raising is off.
  - A raised blocker titled differently from, but overlapping strongly with, an open `workshop/raised` ticket: `createTicket` isn't called, `addBlocker` links the existing ticket, the comment contains "linked existing #N instead of opening a new ticket", and the run log has the match line.
  - A clearly different mechanism still calls `createTicket`.
  - A similar open ticket that already waits for this one isn't matched.
  - The existing exact-title and `blocked_by` tests stay green. Update the `toEqual` on `raised` (line ~2977) to `at: expect.any(Number)`.
  - Rate alert: seed `raised` entries with recent `at` above the limit. `checkRaiseRate` opens one `raise-rate` alert. After moving the `at` values back past an hour, it clears (`ack_at` set).
  - Design returning `blocked` with only `blocked_by: [N]` links #N without calling `createTicket`.
- `server/test/api.test.ts`: `raiseAlertPerHour` saves, and rejects 0 and non-integers.
- Run `npm run typecheck` and `npm test`.

## Risks and open questions

- **False positives** link the wrong ticket and hold this one behind it. The thresholds are conservative, every match is in the run log and the comment, and the owner can remove the link on GitHub. Tune with the exported constants.
- **False negatives.** Partial overlaps such as #3064 ("convert between spell slots and a feature resource" vs "regain uses by spending a spell slot", title 0.25) aren't caught on the server. The agent's search of the index is what covers those.
- **Index size.** About 2,400 tickets at roughly 700 bytes is about 1.7 MB per run, sent through `putArchive`. That's acceptable; no cap is added.
- **Scanning.** Scoring compares one proposal against about 2,400 tickets, at most 3 times per publish: cheap.
- **Untrusted text.** The index holds only tickets from allowed authors, the same set the prompt's list uses.
