# Per-ticket media store for screenshots (#39)

## Context

Agents can't see images pasted into an issue, and they can't show a UI change: they have no GitHub access, the PR body is built only from `summary`, and anything they save disappears with the run's volume. The outcome: each ticket gets a temporary image store on the Workshop server. Every run on the ticket gets it at `/work/media/`, images from the issue and its allowlisted comments are copied into it, agents add screenshots to it, the PR links to a Workshop page that shows them, and the store is deleted when the ticket finishes.

## Approach

- **Store**: files in `DATA_DIR/media/<ticket id>/<name>`, one row per file in a new `media` table. Names are flat (no subfolders), so a name is enough to address a file in the API and in the volume.
- **Into the volume, with the run step's files.** The `run` container already gets `.workshop/prompt.md` and friends through `putArchive` into `/work` (`docker/index.ts` `start()`). The store goes into the same archive as `media/…`, after `tar()` learns to take `Buffer` contents. **Deviation from the ticket** (which says "before prepare"): the run step is where comments and review feedback are already fetched and the prompt is built (`runner.ts` `runSpec`). Downloading the issue images there means one fetch both decides which comments are allowed and supplies their image URLs, and the prompt's link rewriting uses exactly the files that were just delivered. `prepare` never touches `/work/media`, so the agent sees the same thing either way. Paused runs that resume reuse the volume, which still holds the folder.
- **Out of the volume**: after the `run` step returns a valid result, a new `Environment.readArchive()` creates a throwaway container on the run's volume (never started; `putArchive` already relies on created containers seeing their volume), calls `getArchive('/work/media')`, and removes it. A small `untar()` reads the archive. Each entry is checked; bad ones are skipped with a run-log warning. Failures of the copy-back itself are a warning too, never a failed run.
- **Issue images are downloaded at the start of each run's `run` step**, not during sync: the signed URLs expire in ~5 minutes, sync would download images for tickets that may never run, and agents are the consumers. The media page therefore shows issue images after the first run on a ticket. Dedupe is by a source key, so later runs don't download them again.
- **Source key**: the attachment UUID found in the URL path (`github.com/user-attachments/assets/<uuid>` in markdown and `private-user-images…/<n>-<uuid>.png?jwt=…` in `body_html` share it), else `host + pathname`. This is how markdown links are matched to stored files when rewriting the prompt.
- **Browser for Design** (requirement 5): no Dockerfile change. The repo already builds a `browser` image target with Playwright and Chromium (`agent/Dockerfile`), chosen per run by `imageFor`. When the ticket's `ui` flag is set, `imageFor` also picks the browser image for `design` and `design-review`. So agents never install Chromium themselves; a repository with its own image (`repo.image`) keeps using it, as today.
- **Implementation screenshots**: the instruction goes in the fixed task text (`taskLine`), not `DEFAULT_PROMPTS`, so owners who customised the Implementation prompt still get it. Whether a browser exists is already described by `environmentText`.

## Changes

### Server

**`server/src/providers/docker/tar.ts`**
- `tar(entries: Record<string, string | Buffer>, …)`: use a `Buffer` as is, a string as UTF-8.
- New `untar(archive: Buffer): TarEntry[]`, `TarEntry = { name: string; type: 'file' | 'dir' | 'link' | 'other'; content: Buffer }`. Typeflag `0`/`\0` → file, `5` → dir, `1`/`2` → link, everything else → other. Honour PAX `x` headers (`path`, `size` records) and GNU `L` long names for the next entry; skip `g`. Stop at the first zero block.

**`server/src/providers/types.ts`**
- `ImageRef = { url: string; key: string }` (fetchable URL, source key).
- `TicketComment.images?: ImageRef[]`, `ReviewFeedback.images?: ImageRef[]`.
- `TicketSource.ticketImages(repo, number): Promise<ImageRef[]>`: the images in the issue body.
- `StepSpec.files?: Record<string, string | Buffer>`.
- `Environment.readArchive(p: { image: string; volume: string; path: string; labels: Record<string, string>; maxBytes: number }): Promise<Buffer | null>`: null when the path doesn't exist (404).

**`server/src/providers/docker/index.ts`**
- `readArchive`: `createContainer({ Image, Cmd: ['true'], Labels, HostConfig: { Mounts: [volume → /work] } })`, `getArchive({ path })`, read the stream into a buffer, destroying it and throwing `Media folder is larger than N MB` past `maxBytes`; `remove({ force: true })` in `finally`. Labels: the run's labels plus `workshop.step: media`.

**`server/src/providers/github/index.ts`**
- `comments()`: request with `headers: { accept: 'application/vnd.github.full+json' }`; map `images: imageRefs(c.body_html ?? '')`. `body` is unchanged (markdown).
- `ticketImages()`: `GET /repos/{owner}/{repo}/issues/{issue_number}` with the same header → `imageRefs(data.body_html ?? '')`.
- `reviewFeedback()`: same header on the reviews and review-comments requests; `images` from each `body_html`.
- Exported pure `imageRefs(html)`: for each `<img …>` tag, read `src` and `data-canonical-src`; `url` is the first of `src`, `data-canonical-src` that passes `isGitHubImageUrl`; `key = imageKey(data-canonical-src ?? src)`. Tags with no allowed URL are dropped. Deduplicate by key. Decode `&amp;` in attribute values.

**New `server/src/workflow/media.ts`** (pure, no I/O)
- `MEDIA_DIR_IN_RUN = '/work/media'`, `MAX_FILE = 10 MB`, `MAX_TICKET = 100 MB`.
- `isGitHubImageUrl(url)`: `https:` and host `private-user-images.githubusercontent.com` or `user-images.githubusercontent.com`, or host `github.com` with path starting `/user-attachments/`. Decides which URLs taken from the ticket are fetched at all.
- `isGitHubRedirect(url)`: `isGitHubImageUrl`, or `https:` with host `objects.githubusercontent.com` or matching `/^github-production-user-asset-[0-9a-f]+\.s3\.amazonaws\.com$/`. Only checked on a `Location` from a response to an allowed URL: those are where GitHub's attachment links send you (public repos especially), and a commenter can't choose them.
- `imageKey(url)`: first UUID in the pathname (lower-cased), else `host + pathname`.
- `validName(name)`: `/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/` and no `..`.
- `sniffImage(buf): 'png' | 'jpeg' | 'gif' | 'webp' | null` by magic bytes (PNG signature, `FF D8 FF`, `GIF87a`/`GIF89a`, `RIFF….WEBP`).
- `extType(name)`: `png`, `jpg`/`jpeg` → jpeg, `gif`, `webp`, else null. `CONTENT_TYPES` for serving.
- `checkAgentFile(entry, existing, usedBytes): { ok: true } | { ok: false; reason }`: type must be `file` (links: "it's a link"; dirs other than `media/` itself: "subfolders aren't kept"); name valid; `extType` set and equal to `sniffImage(content)`; size ≤ 10 MB; total ≤ 100 MB, where replacing a file counts only the size difference; doesn't replace an `issue`/`comment` file.
- `cleanCaption(text)`: newlines → spaces, `[]` removed, trimmed to 200 characters. Used both when storing a caption and when writing it into the PR.
- `replaceImageLinks(text, byKey: Map<string, string>)`: replace every `https://…` URL in the text (`/https:\/\/[^\s)"'<>\]]+/g`) that passes `isGitHubImageUrl` and whose `imageKey` is in the map with `/work/media/<name>`.
- `screenshotsLine(items, publicUrl, ticketId)`: `''` for no items; without `publicUrl` `**Screenshots:** open this ticket in Workshop`; otherwise `**Screenshots:** [all screenshots](<url>/tickets/<id>/media) · [<caption or name>](<url>/api/tickets/<id>/media/<name>) · …`. Captions go through `cleanCaption`. Trailing `/` on `publicUrl` removed.

**New `server/src/media.ts`** (store, DB, downloads)
- `mediaDir(ticketId)` = `config.dataDir/media/<id>`; `listMedia(ticketId)`; `mediaView(row)`; `mediaCount(ticketId)`.
- `fetchTicketImages(runId, ticket, refs: { source: 'issue' | 'comment'; ref: ImageRef }[])`: for each ref whose key isn't already stored, 4 at a time and at most 50 new images per run (the rest get one warning and are fetched next run): `fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) })`, following at most 3 redirects and checking `isGitHubRedirect` on each `Location`; no auth headers ever. Reject a `content-length` over 10 MB and stop reading past 10 MB; `sniffImage` must succeed; ticket total must stay ≤ 100 MB. Save as `<source>-<n>.<ext>` (next free `n` per source) and insert the row with `source_key`. Any failure → `warn(runId, …)`, keep going.
- `collectAgentMedia(runId, ticketId, agent, entries, captions)`: for entries under `media/`, `checkAgentFile`; skip if bytes equal the stored file; else write the file and upsert the row (`source = agent`, `run_id`, `cleanCaption` of the result's caption, size, `created_at`). Rejections → `warn`. Files missing from the volume are left in the store: agents add and replace, they don't delete. Writes nothing when the ticket is already closed (re-read from the DB first), so a copy-back can't recreate a store that cleanup just deleted.
- `mediaFiles(ticketId): Record<string, Buffer>`: `{ 'media/': '' , 'media/<name>': bytes … }`. Always includes `media/`, so agents can write there even when the store is empty (owned by uid 1000 through `tar()`).
- `deleteMedia(ticketId)`: `rm -rf` the folder and `DELETE FROM media WHERE ticket_id = ?`; `publish('media')`.
- `sweepMedia(cutoffMs)`: for every ticket id that has a folder or rows: delete when the ticket is gone, closed, or `Date.parse(updated_at) < cutoff` with no `activeRunId`.
- `warn(runId, text)`: `appendLog(runId, { step: 'workshop', stream: 'stderr', text: `Workshop skipped ${what}: ${reason}` })`.

**`server/src/scheduler/runner.ts`**
- `context()`: pass `ui: Boolean(ticket.ui)` to `imageFor`.
- `runSpec` (inside `r.resumes === 0`): call `ticketImages()` and `fetchTicketImages()` for the issue's refs straight away, then the same for `included` comments' refs right after `comments()` returns, then for `review` items' refs right after `reviewFeedback()` (never the omitted comments'). Downloading each batch as soon as its fetch returns keeps every signed URL well inside its ~5-minute life. Then build `byKey` from the store, run `replaceImageLinks` over the ticket body, each included comment body and each review body, pass `media: listMedia(t.id)` and `ui` into `taskPrompt`, and add `mediaFiles(t.id)` to `files`. A failing `ticketImages()` call is a warning, not a failure.
- `runAgent`: after `parseResult` succeeds and before the status becomes `publishing`, `await copyBackMedia(ctx, parsed)`: `readArchive({ path: '/work/media', maxBytes: 200 MB, … })` → `untar` → `collectAgentMedia`, captions from `parsed.media` (keyed by basename of `path`, so `/work/media/a.png` and `a.png` both work). Any thrown error → `warn`. Skipped when `r.volume` is null.
- `openOrUpdatePr`: `const shots = screenshotsLine(listMedia(t.id).filter((m) => m.run_id === ctx.run.id), config.publicUrl, t.id)`; append `\n\n${shots}` after `tests` in both the new PR body and the update comment.
- `publishRun`: `if (plan.ui !== undefined) run('UPDATE tickets SET ui = ? WHERE id = ?', Number(plan.ui), t.id)`; `if (plan.deleteMedia) deleteMedia(t.id)`.

**`server/src/workflow/schemas.ts`**
- `ClassifierResult.ui?: boolean`; schema `ui: { type: 'boolean', description: 'Accept only: true when the ticket changes what a user sees, or is a bug best looked into by running the app (layout, rendering).' }`. `parseResult`: `ui` must be a boolean when present.
- `WorkResult.media?: { path: string; caption: string }[]`; schema items `{ path, caption }` both strings, required, `additionalProperties: false`, description "Images this run added to /work/media/, with a one-line caption each." `parseResult`: list of objects with string `path` and `caption`, else `'media must be a list of { path, caption }.'`.

**`server/src/workflow/transitions.ts`**
- `Plan.ui?: boolean` (classifier accept: `r.ui === true`), `Plan.deleteMedia?: boolean` (classifier reject).

**`server/src/workflow/labels.ts`**
- `imageFor(agent, state, images, ui = false)`: browser image for `implement` with `needs:browser` (as now) and for `design`/`design-review` when `ui`.

**`server/src/workflow/prompts.ts`**
- `TaskContext` gains `ui: boolean` and `media: { name: string; source: string; runId: string | null; caption: string | null }[]`.
- `taskPrompt` adds, before "Your task", a `## Media` section: one line per item, `- /work/media/<name>: from the issue | from a comment | added by <agent label> (run <first 8 of id>)` plus `: <caption>`; "(Empty.)" when none. Then the fixed text: open an image with the Read tool; add images by writing them straight into `/work/media/` (no subfolders; PNG, JPEG, GIF or WebP; 10 MB each); list each file you add in the result's `media` field with a caption; files elsewhere are not kept, and deleting a file here doesn't remove it from the store.
- `taskLine`:
  - `design`, `design-review`, only when `c.ui`: "This ticket involves something a user sees. You may run the app in a browser (Playwright with Chromium) to reproduce or examine it, and save what you capture to `/work/media/`."
  - `implement`, always: "If the change affects what a user sees, run the app, screenshot the changed screens or states and save them to `/work/media/`. Before and after shots are best when the old state is easy to reach. If the app can't run here, say so in your summary instead."
- `environmentText` (browser branch): say to save screenshots to `/work/media/` (kept and shown to the owner) instead of `/tmp`.
- Classifier default prompt step 7: one sentence on `ui`.

**`server/src/scheduler/merge.ts`**: call `deleteMedia(t.id)` at the end of `finishMerged` and `stopAfterClosedPr`.

**`server/src/scheduler/sync.ts`**: in `syncRepo`, on `existing?.state === 'open' && t.state === 'closed'`, `deleteMedia(existing.id)` before the `try { cleanUpClosedIssue }`, so it happens even if the tidy-up throws.

**`server/src/scheduler/loop.ts`** `cleanup()`: `sweepMedia(Date.now() - 30 * 86400_000)`.

**`server/src/config.ts`**: `publicUrl: process.env.WORKSHOP_PUBLIC_URL?.replace(/\/+$/, '') || null`.

**`server/src/db.ts`**: one new migration (below).

**`server/src/tickets.ts`**: `TicketRow.ui: number`; `ticketView` adds `mediaCount`.

**`server/src/runs.ts`**: `VIEW_SQL` adds `(SELECT COUNT(*) FROM media m WHERE m.run_id = runs.id) AS media_count`; `RunView.mediaCount`.

**`server/src/http/api.ts`**
- `GET /tickets/:id/media` → `TicketMedia` (404 `Ticket not found.`).
- `GET /tickets/:id/media/:name` → `check(validName(name), "That isn't a media file name.")`; row lookup, else 404 `Image not found.`; `res.type(CONTENT_TYPES[ext])`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline; filename="<name>"`, `Content-Security-Policy: default-src 'none'; sandbox` and `Cache-Control: private, max-age=300`, send the file bytes. `:id` must be a positive integer (400 otherwise).
- Both sit on `apiRouter`, so `requireAuth` (session or API token) already applies.

**`server/src/http/openapi.ts`**: both routes, `MediaItem` and `TicketMedia` schemas, `mediaCount` on `TicketView` and `RunView`. **`docs/api.md`**: a short "Media" section.

### Client

- **`client/src/pages/Media.tsx`** (new), route `tickets/:id/media` in `main.tsx`: `useApi<TicketMedia>(`/tickets/${id}/media`, ['media'])`. Heading `Screenshots for <repo>#<n>`, ticket title link, then one `Panel` holding a wrapping `.media-grid` of `<figure>`s: the image (`<a href={item.url} target="_blank">` around `<img loading="lazy">`, max 320 px wide), caption, and a muted line with source ("From the issue", "From a comment", or the agent label) and, for agent items, a `Link` to `/runs/<runId>`. Reads an optional `?run=<id>` and then shows only that run's items, with a "Show all" link. Empty state: "No images yet. Agents add screenshots here, and images in the issue are copied in when an agent next runs."
- **`Tickets.tsx`** `Card`: when `t.mediaCount > 0`, `<Link className="small" to={`/tickets/${t.id}/media`}>Screenshots ({t.mediaCount})</Link>` under the PR link.
- **`RunView.tsx`**: when `run.mediaCount > 0`, a `Link` button `View screenshots ({n})` to `/tickets/<ticketId>/media?run=<runId>` in the header row next to Export log.
- **`theme.css`**: `.media-grid` (flex wrap, gap) and figure/img styles using existing tokens; images get `border: 1px solid var(--line)` and 4px radius.
- `client/AGENTS.md`: add Media to the pages list. `server/AGENTS.md`: map rows for `media.ts` and `workflow/media.ts`.

### Docs

`README.md` configuration table and `.env.example`: `WORKSHOP_PUBLIC_URL` ("Workshop's address as you open it, e.g. https://workshop.example.com. Used for screenshot links in pull requests").

## Data and interfaces

Migration (append to `MIGRATIONS`):

```sql
CREATE TABLE media (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  source TEXT NOT NULL,      -- 'issue', 'comment', or an agent name
  source_key TEXT,           -- issue/comment images: imageKey of the URL, for re-sync dedupe
  run_id TEXT,               -- no FK: outlives the run
  caption TEXT,
  size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (ticket_id, name)
);
CREATE INDEX media_run ON media (run_id);
ALTER TABLE tickets ADD COLUMN ui INTEGER NOT NULL DEFAULT 0;
```

`api-types.ts`:

```ts
export type Topic = … | 'media';
export interface MediaItem { name: string; source: string; runId: string | null; caption: string | null; size: number; createdAt: number; url: string /* /api/tickets/:id/media/:name */ }
export interface TicketMedia { ticketId: number; ticket: string; title: string; items: MediaItem[] }
// TicketView.mediaCount: number; RunView.mediaCount: number
```

`publish('media')` (and `'tickets'`, `'runs'` for the counts) whenever rows change. Result schemas gain `ui` (classifier) and `media` (work), both optional. New env var `WORKSHOP_PUBLIC_URL`.

## Tests

Run `npm run typecheck` and `npm test`.

- **`server/test/tar.test.ts`**: `tar()` with `Buffer` contents (all 256 byte values, sizes 0, 511, 512, 513) extracts byte-for-byte with system `tar`, and `untar(tar(x))` round-trips. `untar` of an archive made by system `tar` containing a symlink reports `link`, and a name over 100 bytes (PAX or GNU long name) comes back whole.
- **`server/test/workflow.test.ts`**:
  - `parseResult`: accepts `ui: true/false` and `media: [{ path, caption }]`; rejects `ui: 'yes'`, `media: 'x'`, `media: [{ path: 1 }]`.
  - `taskPrompt`: the Media section lists path, source and caption, and says "(Empty.)" with no items; `replaceImageLinks` turns `![](https://github.com/user-attachments/assets/<uuid>)` and `<img src="…">` into `/work/media/issue-1.png`, and leaves unknown or non-GitHub URLs alone.
  - Design and Design adversary task text mentions the browser only when `ui` is set; Implementation always gets the screenshot sentence.
  - `imageFor`: `design`/`design-review` get the browser image only with `ui`; a repository image still wins.
  - `planTransition`: classifier accept carries `ui`, reject sets `deleteMedia`.
  - `checkAgentFile`, `sniffImage`, `validName`, `isGitHubImageUrl`, `imageKey`, `screenshotsLine` (with and without a public URL).
- **`server/test/docker.integration.test.ts`** (opt-in real engine, run against Docker and Podman): `start` with `Buffer` files under `media/`, then `readArchive` on the same volume returns them byte-for-byte through `untar`; a missing path returns null; a path over `maxBytes` throws. This is the only check that a created-but-never-started container can serve `getArchive` from its volume on both engines.
- **`server/test/github.test.ts`**: `imageRefs` on `body_html` shapes: private-user-images `src` with `data-canonical-src`, camo `src` with an allowed canonical URL, a disallowed host (dropped), `&amp;` in the query.
- **`server/test/pipeline.test.ts`** (stub `globalThis.fetch` with `vi.stubGlobal`; FakeEnv gains `readArchive` returning a scripted `tar()`, and `fake.tickets.ticketImages`):
  - issue images are saved and delivered in the run spec's `files` as `media/issue-1.png`; a second run doesn't fetch them again;
  - a disallowed host, a redirect to a disallowed host, a non-image body, and an image in the stranger's comment are never fetched or stored; a redirect from `github.com/user-attachments/…` to `objects.githubusercontent.com` is followed;
  - with 51 new issue images, 50 are stored and one warning is logged;
  - media added by one run is in the next run's `files`;
  - copy-back stores a valid PNG with its caption and `run_id`, replaces an earlier agent file without double-counting its size, and skips a `.png` holding text, an over-10 MB file and a subfolder entry, each with a `workshop` log warning, while the run still succeeds;
  - the PR body has the Screenshots line with links when `config.publicUrl` is set, and the fallback text when it isn't;
  - the store (folder and rows) is gone after merge (`mergeApproved` or `syncReviews` with a merged PR), after the PR is closed, after the issue is closed, and after a classifier reject;
  - `ui` from the classifier is stored on the ticket.
- **`server/test/api.test.ts`**: both media routes return 401 without sign-in; the file route returns `image/png`, `nosniff`, `inline` and the `sandbox` CSP; `a..png` and `..%2Fx.png` get 400; an unknown name 404; the OpenAPI coverage test passes with the new routes.
- No browser in the design stage; Implementation runs with one (`workshop/needs:browser`) and should screenshot the media page, Tickets card link and RunView button at desktop and phone widths in both themes.

## Risks and open questions

- **Redirects from `github.com/user-attachments/`.** Redirects may go to GitHub's own asset hosts (`isGitHubRedirect`), never anywhere else; an image redirected elsewhere is skipped with a warning. If GitHub moves its storage, the warning names the host so the list can be updated.
- **The 30-day sweep uses the issue's `updated_at`.** A PR left in review for 30 days with no issue activity loses its screenshots (activity only on the PR doesn't bump the issue). That matches the ticket's wording; using the latest run's `ended_at` as well would be the fix if it bites.
- **Memory**: the run archive and the copy-back are held in memory (up to 100 MB in, 200 MB cap out). Acceptable for one process on a small host; streaming would be the fix if it isn't.
- **Store vs a copy-back race**: `collectAgentMedia` skips closed tickets, which covers the common case. A close landing in the middle of one copy-back can still leave a file behind; the sweep (closed tickets are deleted on sight) cleans it up.
- **Media page links in a merged PR stop working** once the store is deleted. That's the ticket's intent (temporary store).
- **Issue images appear on the media page only after a run.** Acceptable since agents are the readers; downloading during sync could be added later.
- Deviation to confirm in review: the store is delivered with the `run` step's archive rather than before `prepare` (see Approach).

## Review

Design adversary review against the code on `main` (`runner.ts`, `docker/index.ts`, `tar.ts`, `github/index.ts`, `labels.ts`, `merge.ts`, `sync.ts`, `loop.ts`, `agent/entrypoint.sh`). Claims checked and found correct: `putArchive` before `start()` is how `.workshop/` already reaches `/work`; the agent user is uid 1000 (`node` renamed), matching `tar()`'s default owner; `prepare` only touches `/work/repo`, so delivering the store with the `run` step's archive instead of "before prepare" changes nothing for the agent (I agree with that deviation); `publish` runs `git add -A` inside `/work/repo` only, so `/work/media` never gets committed; the session cookie is `SameSite=Lax`, so the media links in a PR work on a top-level click from github.com; resumed runs skip `runSpec`'s fetches but keep the volume, so the folder is still there.

| # | Criticism | Fix | Adopted |
|---|-----------|-----|---------|
| 1 | Redirects were only allowed to the initial-URL allowlist. `github.com/user-attachments/assets/<uuid>` (what public-repo `body_html` often carries) redirects to GitHub's storage (`objects.githubusercontent.com` / the `github-production-user-asset-*` S3 bucket), so every image on such repos could be skipped. | Separate `isGitHubRedirect` allowlist applied to `Location` headers only; the URL taken from the ticket must still pass `isGitHubImageUrl`, so a commenter still can't choose the host. Test for a followed redirect. | Yes |
| 2 | All fetches (issue, comments, review) ran first and downloads after, one at a time with a 30 s timeout each. A ticket with many images could outlive the ~5-minute signed URLs from the earliest fetch, and there was no bound on how long run start takes. | Download each batch right after its fetch, 4 at a time, at most 50 new images per run with one warning for the rest. | Yes |
| 3 | The 100 MB ticket total counted a replaced agent file twice, so an agent refreshing its screenshots could be rejected near the limit. | Count only the size difference when replacing. Test. | Yes |
| 4 | Captions are free text from an agent, written into later prompts and into the PR body; unbounded length. | `cleanCaption`: one line, no `[]`, 200 characters, applied on store and in the PR line. | Yes |
| 5 | The file route served agent-written bytes from Workshop's own origin with only `nosniff`. A sniffed-valid image is safe as `image/*`, but defence in depth is cheap. | Add `Content-Security-Policy: default-src 'none'; sandbox` and `Cache-Control: private`; reject a non-integer `:id`. | Yes |
| 6 | A copy-back that finishes after the ticket closed would recreate a deleted store (only the sweep would catch it). | `collectAgentMedia` re-reads the ticket and writes nothing when it's closed. | Yes |
| 7 | `readArchive` relies on `getArchive` from a created-but-never-started container seeing its volume, on Docker and Podman. Mocked pipeline tests can't show that. | Add a `readArchive` round trip to the opt-in `docker.integration.test.ts`. | Yes |
| 8 | The ticket asks RunView to link "for media that run added", but the button went to the whole ticket's page. | `?run=<id>` filter on the media page, used by RunView. | Yes |
| 9 | Unclear what happens when an agent deletes a file in `/work/media`. | Stated: deletions aren't propagated; the prompt says so. | Yes |
| 10 | Simpler alternative to the throwaway container: `getArchive` on the exited `run` container before `runContainer` removes it. | Not adopted: it puts a media hook into the generic step runner, runs before the result is validated (no captions yet), and doesn't help after a restart where the container is already gone. The throwaway container is a few lines and only costs a create/remove. | No |
| 11 | Media from runs that fail (timeout, invalid result) is never copied back. | Not adopted: the ticket asks for copy-back after the run step, and the retry repeats the work; keeping a failed attempt's screenshots would mostly mislead the PR's Screenshots line. | No |
| 12 | The 30-day sweep keys on the issue's `updated_at`, which PR-only activity doesn't bump, so a long review can lose screenshots. | Recorded under Risks; the ticket's "haven't changed in 30 days" is followed as written. | No (noted) |
| 13 | `ui` can only be set by the Classifier, isn't visible on GitHub, and tickets classified before this change have `ui = 0`; the owner can't override it the way `needs:browser` can be. | Not adopted: the ticket specifies a stored classifier flag. A `workshop/needs:ui`-style label would be the follow-up if owners want control. | No |

