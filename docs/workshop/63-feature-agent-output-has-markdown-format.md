# Markdown in agent output (#63)

## Context

Agents write their run summary (`RunView.summary`, from the result schema's `summary`) in GitHub Markdown, because it is posted to the ticket or pull request. Workshop shows it as plain text:

- Ticket page (`client/src/pages/Ticket.tsx`, the lifecycle list): `<span>{r.summary}</span>`. Line breaks collapse, so lists and headings become one run-on paragraph full of `**` and `` ` `` (see the issue's screenshot).
- Run view (`client/src/pages/RunView.tsx`): `<p className="notice ok" style={{ whiteSpace: 'pre-wrap' }}>`. Line breaks survive, but the markup still shows.
- The run view's transcript prose (`say` items) is also Markdown written by the agent, shown with `white-space: pre-wrap`.

Outcome: these three places render the common GitHub Markdown that agents write (headings, paragraphs, lists, code, emphasis, links, quotes, rules and tables), safely and in the existing visual style.

## Approach

- **A small parser of our own, no new package.** AGENTS.md says to keep dependencies few. Agent summaries use a predictable subset of Markdown. A pure parser of about 250 lines with a React renderer covers that subset. There is no HTML string and no `dangerouslySetInnerHTML`, so nothing in a summary can inject markup.
- **Split it in two:** `client/src/markdown.ts` parses text into a small tree (pure, no React, tested like `transcript.ts`), and `client/src/components/Markdown.tsx` turns the tree into React elements.
- **GitHub comment semantics where they differ from CommonMark.** A single newline inside a paragraph is a line break (`<br>`), as in GitHub issue and PR comments. This also keeps today's `pre-wrap` behaviour for text that isn't Markdown.
- **Unsupported syntax stays literal.** Raw HTML, reference-style links and footnotes show as typed text, escaped by React. Images (`![alt](url)`) become a link to the URL with the alt text, so the UI never loads remote images.
- **Only safe links.** A link becomes `<a href target="_blank" rel="noreferrer">` only when its URL starts with `http://`, `https://` or `mailto:`. Otherwise only the link text shows. Bare `http(s)://` URLs are linked too.

## Changes

### `client/src/markdown.ts` (new)

Types:

```ts
export type Inline =
  | string
  | { t: 'code'; text: string }
  | { t: 'strong' | 'em' | 'del'; children: Inline[] }
  | { t: 'link'; href: string; children: Inline[] }
  | { t: 'br' };

export type Block =
  | { t: 'p'; children: Inline[] }
  | { t: 'h'; level: number; children: Inline[] }          // 1–6
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'quote'; children: Block[] }
  | { t: 'hr' }
  | { t: 'table'; align: ('left' | 'center' | 'right' | null)[]; head: Inline[][]; rows: Inline[][][] };

export function parseMarkdown(text: string): Block[];
export function parseInline(text: string): Inline[];
```

Blocks (`parseMarkdown`): normalise CRLF to LF, split into lines and walk them. Each block kind starts on a line that matches:
- Blank line: ends the current paragraph.
- Fenced code: `` ``` `` or `~~~` (3+ chars, up to 3 spaces of indent), optional info string (first word is `lang`). It runs to a closing fence of the same character and at least the same length, or to the end of the text. Strip the opening fence's indent from content lines. The content is not parsed.
- ATX heading: `^ {0,3}(#{1,6})\s+(.*?)(\s+#+)?\s*$`.
- Rule: `^ {0,3}([-*_])(\s*\1){2,}\s*$`. It is checked before lists, so `---` and `* * *` are rules.
- Blockquote: lines starting with `>`. Collect consecutive `>` lines, strip `> ?`, and parse them recursively.
- List item: `^( *)([-*+]|\d{1,9}[.)])\s+(.*)$`. The item's content indent is the marker width plus the following spaces. Following lines belong to the item if they are indented at least that much (then de-indent and parse recursively, which gives nested lists and code inside items), or if they are lazy paragraph continuations (non-blank, not starting another block). A blank line followed by an indented line stays in the item. A new marker of the same type (bullet vs ordered) at the list's indent starts the next item. Anything else ends the list. `start` is the first item's number. A list may interrupt a paragraph only if it is a bullet or starts at 1, to avoid `2024. was a year` style false positives.
- Table: a line containing `|` followed by a delimiter row matching `^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$` with the same cell count. Rows continue until a blank line or a line without `|`. Split cells on unescaped `|` and trim the outer pipes. Pad or cut body rows to the header's cell count.
- Otherwise it is a paragraph line. Consecutive paragraph lines join with `\n`. A heading, fence, rule, quote or list line (see above) interrupts a paragraph.

Inline (`parseInline`): a left-to-right scan that collects plain text into strings:
- `\` followed by ASCII punctuation: the literal character.
- A backtick run: find the next run of the same length, giving `code` (strip one leading and trailing space when both are present). If there is none, the backticks are literal.
- `[text](url)` or `[text](url "title")`, with brackets and parentheses balanced, gives `link`. The URL is checked against `/^(https?:|mailto:)/i`. If it fails, emit the parsed children without a link. `![alt](url)` gives a link to the URL with the alt text (same check).
- `**`/`__`, then `~~`, then `*`/`_`: a closing delimiter of the same kind must exist later. The opening delimiter must not be followed by whitespace, and the closing one must not be preceded by whitespace. `_` and `__` must also have no letter or digit just outside them, so `snake_case_name` stays literal. Parse the content recursively.
- A bare URL `https?:\/\/[^\s<]+` gives a link. Strip trailing `.,;:!?'"`, and a trailing `)` when the URL has more `)` than `(`.
- `\n` gives `{ t: 'br' }`. A hard break written as two trailing spaces or `\` also gives `br`. Trailing spaces are trimmed.

### `client/src/components/Markdown.tsx` (new)

```tsx
export function Markdown({ text, className }: { text: string; className?: string })
```
`useMemo(() => parseMarkdown(text), [text])` and render `<div className={'markdown' + (className ? ` ${className}` : '')}>`:
- `p`, `blockquote`, `hr`, `pre > code` (with `data-lang` when present), `strong`, `em`, `del`, `code`, `br`.
- Headings: `h${Math.min(level + 2, 6)}`, so a summary's `#` doesn't outrank the page's `h1` and the panels' `h2`.
- Lists: `ul`, or `ol start={start}` (omit `start` when 1). Each item renders its blocks. If an item is a single paragraph, render its inlines directly in the `li`, without a `<p>`, to keep lists tight.
- Tables: `<div className="table-wrap"><table>` with `thead`/`tbody`, and `style={{ textAlign }}` from `align`.
- Links: `<a href target="_blank" rel="noreferrer">`.
- Keys are array indexes, since the tree is rebuilt from the text.

### `client/src/pages/Ticket.tsx`
- Replace `{r.summary && <span style={{ overflowWrap: 'anywhere' }}>{r.summary}</span>}` with `{r.summary && <Markdown text={r.summary} />}`.

### `client/src/pages/RunView.tsx`
- Summary: `{run.summary && <Markdown className="notice ok" text={run.summary} />}`, without the inline `whiteSpace`.
- `case 'say': return <Markdown className="say" text={item.text} />;`
- `log`, `tool`, `result`, `run.error` and `r.error` stay plain. They are tool output and error messages, not Markdown.

### `client/src/theme.css`
Add a "Markdown" section near the transcript styles. Use existing tokens only, so the contrast stays AA in both themes.
- `.markdown { overflow-wrap: anywhere; }` and `.markdown > :first-child { margin-top: 0 } .markdown > :last-child { margin-bottom: 0 }`. Give `p, ul, ol, pre, blockquote, table, h3–h6` in `.markdown` a vertical margin of `0.5em 0`, and remove the default margins on nested lists' first and last children the same way.
- Headings `h3`–`h6` in `.markdown`: `font-size: 15px` (h3) / `14px` (others), `font-weight: 600`.
- `ul, ol`: `padding-left: 1.5em`.
- Inline `code` (`.markdown :not(pre) > code`): `background: var(--raised)`, `padding: 0 4px`, `border-radius: 3px`.
- `pre`: `background: var(--raised)`, `border: 1px solid var(--line)`, `border-radius: var(--radius)`, `padding: 8px 10px`, `white-space: pre-wrap`, `word-break: break-word`. Content wraps and the page never scrolls sideways (client AGENTS.md).
- `blockquote`: `margin-left: 0; padding-left: 10px; border-left: 3px solid var(--line); color: var(--muted)`.
- `hr`: `border: 0; border-top: 1px solid var(--line)`.
- Tables reuse the existing table styles via `.table-wrap`. Check that they apply inside `.markdown` and add only what's missing (cell padding, borders).
- `.transcript .say`: drop `white-space: pre-wrap` and keep `max-width: 80ch`.

### `client/AGENTS.md`
- Structure table: add `src/markdown.ts` ("Pure parser: the Markdown subset agents write → block and inline tree. Tested in `test/`") and mention `Markdown` in the components row.
- Testing: say that `test/` covers `markdown.ts` too.

## Data and interfaces

None. There are no API, schema or server changes, and no new dependencies.

## Tests

- `client/test/markdown.test.ts` (new), testing `parseMarkdown`/`parseInline` trees:
  - The issue's example: `**The setting**\n- Each user gets **Target selection** and \`code\`.\n- It is saved` gives a paragraph with `strong`, then a list of two items with `strong` and `code` inlines.
  - Headings at levels 1–6, with the closing `#`s stripped. `#nospace` is a paragraph.
  - Nested bullet lists (two-space and four-space indent), an ordered list with `start: 3`, a `1)` marker, and a loose list (blank line between items) staying one list. A paragraph line `2024. Was busy` is not a list.
  - A fenced code block with `lang` whose content keeps `**`, `<b>` and blank lines verbatim. An unclosed fence runs to the end. A fence inside a list item.
  - A blockquote containing a list. `---` and `* * *` give `hr`.
  - A table with alignment and an escaped `\|` in a cell. A line with `|` but no delimiter row is a paragraph.
  - Inline: `snake_case_name` stays one string. `2 * 3 * 4` stays literal. Unclosed `**` stays literal. `\*x\*` gives `*x*`. A double-backtick code span contains a backtick. `~~gone~~` gives `del`. A single newline gives `br`.
  - Links: `[a](https://x)` gives `link`. `[a](javascript:alert(1))` gives the text `a` with no link. `https://github.com/o/r/pull/1).` gives a link without the `).`. `![shot](https://x/a.png)` gives a link.
- `client/test/markdown-render.test.tsx` (new, small): `renderToStaticMarkup(<Markdown text=… />)` from `react-dom/server` (already a dependency). Check that `<script>alert(1)</script>` comes out escaped, that a heading `# T` renders as `<h3>`, and that links have `target="_blank"` and `rel="noreferrer"`. Vitest picks up `.tsx`, and `client/tsconfig.json` already includes `test` with `jsx: react-jsx`.
- Run `npm run typecheck` and `npm test`.
- Browser (Playwright): run the app (`npm run build && npm run dev:server`, or both dev servers), and use real runs or seed a run whose `summary` is a realistic agent summary (headings, nested list, code, fenced block, table, link). Screenshot the Ticket page and the run view at 1280px and 390px, in dark and light themes. Check that nothing scrolls sideways and that inline code and code blocks are readable. Save the screenshots to `/work/media/`.

## Risks and open questions

- **Parser edge cases.** A hand-written parser won't match GitHub exactly. The fallback for anything odd is literal text, which is no worse than today. The tests cover the forms agents actually write.
- **Long summaries on the Ticket page.** These are now taller (real line breaks and lists) than the collapsed text. The issue asks for readability, so they are not clamped. If they turn out too long, a later change can collapse them behind "Show more".
- **Performance.** Parsing runs on every render of `say` items in a streaming transcript. `useMemo` on `text` keeps it to once per item. Items are short, so this is fine.
