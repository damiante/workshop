# Ticket screenshot gallery (#61)

## Context

Screenshots appear on the Media page (`client/src/pages/Media.tsx`, `tickets/:id/media`) and as thumbnails on the Ticket page (`Thumbs` in `client/src/pages/Ticket.tsx`). Clicking one opens the raw image in a new tab. Captions already work end to end: agents return `media[].caption` (`server/src/workflow/schemas.ts`), `collectAgentMedia` stores it after `cleanCaption` (`server/src/workflow/media.ts`), and the UI shows it. But `cleanCaption` cuts captions to one line of 200 characters, and the prompt asks for "a one-line caption".

Outcome:
- Clicking a thumbnail opens a modal gallery. It shows the large image with its full caption, Previous and Next buttons, and a thumbnail bar for picking another image. Arrow keys move between images and Escape closes the gallery.
- Captions can run to a few short paragraphs (1000 characters). The UI shows them in full in the gallery and clamps them in the grids. Prompts and PR links still get one line.
- The agent prompt and the result schema tell agents they can write longer captions.

## Approach

- **One `Gallery` component** used by both pages. It takes the list it was opened from: all of the Media page's items (after the `?run=` filter), or one `Thumbs` group on the Ticket page. It reuses `Modal` for the backdrop, Escape, the close button and dialog semantics. `Modal` gets an optional `className` so the gallery can be wider than 560px.
- **Track the open image by name, not by index.** `useApi` refetches when new media arrives on the `media` topic, so an index could point at a different image. Look up the index on each render. If the name disappears, close the gallery.
- **Keep the plain link.** Each thumbnail stays an `<a href={m.url} target="_blank">`. Its `onClick` opens the gallery only for a plain left click (`e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey`) and calls `preventDefault()`. Middle-click and Ctrl/Cmd-click still open a new tab, and the link still works with keyboard and screen readers. The gallery also has an "Open full size" link.
- **Stop at the ends.** Previous is disabled on the first image and Next on the last, and the title says "Image 2 of 5". This is clearer than wrapping around. No transitions (motion rule).
- **Captions:** store a cleaned caption that keeps line breaks, and make it one line only where needed. `cleanCaption` stays the single place that cleans stored captions. A new `captionLine` makes a caption one line for Markdown and lists.

## Changes

### `server/src/workflow/media.ts`
- `export const MAX_CAPTION = 1000;`
- `cleanCaption(text)`: change CRLF to LF, collapse spaces and tabs within each line to one space, trim each line, collapse three or more newlines to two, trim, then `.slice(0, MAX_CAPTION)` and trim again. Stop removing brackets here. Update the doc comment: "Up to a few short paragraphs: line breaks kept, other whitespace collapsed, at most 1000 characters."
- New `export function captionLine(text: string, max = Infinity): string`: collapse all whitespace to one space and trim. If longer than `max`, cut to `max - 1` and append `…`.
- `screenshotsLine`: link text becomes `captionLine(i.caption ?? '', 120).replace(/[[\]]/g, '') || i.name`. Brackets are removed here now, since this is where they would break Markdown.

### `server/src/workflow/prompts.ts`
- Media list (line ~171): use `captionLine(m.caption)` (no limit), so a multi-line caption doesn't break the bullet list.
- Instruction text: replace "with a one-line caption" with "with a caption saying what it shows (a sentence is usually enough; up to 1000 characters, line breaks allowed, when the image needs explaining)".

### `server/src/workflow/schemas.ts`
- `media` description: `'Images this run added to /work/media/, each with a caption saying what it shows (up to 1000 characters; line breaks allowed).'`

### `server/src/api-types.ts`
- `MediaItem.caption`: add the doc comment `/** What the image shows; may contain line breaks. */`.

### `client/src/components/ui.tsx`
- `Modal` gets an optional `className?: string`, appended to `"modal"`. Existing callers don't change.

### `client/src/components/Gallery.tsx` (new)
```ts
export function Gallery({ items, name, onSelect, onClose }: { items: MediaItem[]; name: string; onSelect: (name: string) => void; onClose: () => void })
```
- `i = items.findIndex((m) => m.name === name)`. If `i < 0`, call `onClose` in an effect and render null.
- Render `<Modal title={`Image ${i + 1} of ${items.length}`} className="gallery" onClose={onClose}>`:
  - `.gallery-stage`: a `<button className="gallery-nav" aria-label="Previous image" disabled={i === 0}>‹</button>`, then `<img src={m.url} alt={m.caption ?? m.name}>`, then the matching Next button (`›`, `aria-label="Next image"`).
  - Caption `<p className="gallery-caption">{m.caption ?? m.name}</p>` (`white-space: pre-wrap`), then a `small muted` line: the source text, `· View run` link when `m.runId`, and `· <a href={m.url} target="_blank" rel="noreferrer">Open full size</a>`.
  - `.gallery-strip`: one `<button aria-label={…caption or name} aria-current={j === i || undefined}>` per item, each with `<img loading="lazy">`, calling `onSelect`. Show the strip only when there is more than one item.
- Effect on `window` `keydown`: ArrowLeft and ArrowRight select the neighbouring image, ignored at the ends. Escape is handled by `Modal`.
- Effect on `i`: `stripRef.current?.querySelector('[aria-current]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })`.
- Move `sourceText` from `Media.tsx` into this file, export it, and import it in `Media.tsx`.
- Export a helper for the thumbnail links: `export const plainClick = (e: React.MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;`

### `client/src/pages/Media.tsx`
- `const [open, setOpen] = useState<string | null>(null)`. Each image's `<a>` gets `onClick={(e) => { if (plainClick(e)) { e.preventDefault(); setOpen(m.name); } }}`.
- The grid caption `<span>` gets `className="clamp"`.
- After the panel: `{open && <Gallery items={items} name={open} onSelect={setOpen} onClose={() => setOpen(null)} />}`. Wrap `onClose` in `useCallback`, because `Modal`'s effect depends on it.

### `client/src/pages/Ticket.tsx`
- `Thumbs` gets the same `open` state, `onClick` and `<Gallery items={items} …>`, so the gallery browses that group. The figcaption also gets `clamp`.

### `client/src/theme.css` (next to the media styles)
- `.modal.gallery { width: min(1100px, 100%); }`
- `.gallery-stage`: grid `auto 1fr auto`, centred, gap 8px. The image uses `max-width: 100%; max-height: 60vh; object-fit: contain; justify-self: center; border: 1px solid var(--line); border-radius: 4px`. Below 760px, use `max-height: 50vh`.
- `.gallery-nav`: a normal bordered button, with enough size for touch (min 40×40px) and a larger font.
- `.gallery-caption { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }`
- `.gallery-strip`: flex, gap 6px, `overflow-x: auto` (scrolls inside the modal; the page doesn't scroll sideways). Buttons have padding 0 and a 2px transparent border with 4px radius. `[aria-current]` gets `border-color: var(--accent)`. Thumbnails are 64px high and auto width, at most 120px wide, with `object-fit: cover`.
- `.clamp { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }`. Use 2 lines inside `.media-grid.thumbs`.

## Data and interfaces

No schema or API changes. Captions can now hold up to 1000 characters and newlines. The `media.caption` column is `TEXT`, and older captions are already valid. The result schema's `media` description and the prompt text change as described above.

## Tests

- `server/test/media.test.ts`: rewrite "cleans captions to one short line" as "cleans captions, keeping line breaks". Check that `'a\r\n\r\n\r\n  b   c \n[d]'` becomes `'a\n\nb c\n[d]'` and that a 1200-character caption becomes 1000. Add a `captionLine` test: newlines become spaces, and 200 characters with `max` 120 gives 120 characters ending in `…`. In the existing `screenshotsLine` test, keep `Dark [mode]` → `Dark mode` and add a multi-line caption that becomes one line.
- If a prompts test checks the Media section, update it for the new wording. Add a case where a multi-line caption is listed on one line.
- Run `npm run typecheck` and `npm test`.
- Browser (Playwright): run the server and seed a ticket with three or more media rows (with long, multi-line and missing captions), or use real agent media. On the Media page and the Ticket page, check that a click opens the gallery, Previous/Next and the arrow keys move between images, the buttons are disabled at the ends, the strip changes the image and marks the current one, and Escape, Close and a backdrop click all close it. Check that Ctrl-click still opens a new tab. Test at 1280px and 390px, in dark and light themes. Save screenshots to `/work/media/`.

## Risks and open questions

- Changing `cleanCaption` only affects new captions. Stored captions stay as they are, which is fine.
- No swipe gestures on phones; the buttons and strip work by touch. Add swipe later if it's wanted.
- The 1000-character limit and the 120-character PR link text are judgement calls (see the sizing comment). List them in the PR.
