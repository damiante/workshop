// A small parser for the Markdown subset agents write in run summaries (GitHub comment flavour: a single newline
// is a line break). Pure, no React. Anything it doesn't understand stays literal text.

export type Inline =
  | string
  | { t: 'code'; text: string }
  | { t: 'strong' | 'em' | 'del'; children: Inline[] }
  | { t: 'link'; href: string; children: Inline[] }
  | { t: 'br' };

export type Align = 'left' | 'center' | 'right' | null;

export type Block =
  | { t: 'p'; children: Inline[] }
  | { t: 'h'; level: number; children: Inline[] }
  | { t: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { t: 'code'; lang: string; text: string }
  | { t: 'quote'; children: Block[] }
  | { t: 'hr' }
  | { t: 'table'; align: Align[]; head: Inline[][]; rows: Inline[][][] };

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^( *)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;
const DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const SAFE_URL = /^(?:https?:|mailto:)/i;

const blank = (line: string) => line.trim() === '';
const indentOf = (line: string) => line.length - line.trimStart().length;

type Item = { indent: number; ordered: boolean; num: number; width: number; rest: string };

function listItem(line: string): Item | null {
  if (RULE.test(line)) return null;
  const m = ITEM.exec(line);
  if (!m) return null;
  const rest = m[3] ?? '';
  const gap = rest ? line.length - m[1].length - m[2].length - rest.length : 1;
  return {
    indent: m[1].length,
    ordered: /\d/.test(m[2]),
    num: parseInt(m[2], 10),
    width: m[1].length + m[2].length + Math.min(gap, 4),
    rest,
  };
}

// Whether this line ends a paragraph.
function interrupts(line: string): boolean {
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || /^ {0,3}>/.test(line)) return true;
  const item = listItem(line);
  return !!item && !!item.rest && (!item.ordered || item.num === 1);
}

function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && line[i + 1] === '|') {
      cell += '\\|';
      i++;
    } else if (line[i] === '|') {
      cells.push(cell);
      cell = '';
    } else cell += line[i];
  }
  cells.push(cell);
  if (cells[0].trim() === '') cells.shift();
  if (cells.length && cell.trim() === '') cells.pop();
  return cells.map((c) => c.trim());
}

export function parseMarkdown(text: string): Block[] {
  return parseBlocks(text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n'));
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(line)) {
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const indent = indentOf(line);
      const mark = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const close = lines[i].trim();
        if (close.length >= mark.length && close[0] === mark[0] && close === mark[0].repeat(close.length)) break;
        body.push(lines[i].slice(Math.min(indent, indentOf(lines[i]))));
        i++;
      }
      i++;
      blocks.push({ t: 'code', lang: fence[2], text: body.join('\n') });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ t: 'h', level: heading[1].length, children: parseInline(heading[2]) });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ t: 'hr' });
      i++;
      continue;
    }

    if (/^ {0,3}>/.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) inner.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      blocks.push({ t: 'quote', children: parseBlocks(inner) });
      continue;
    }

    const first = listItem(line);
    if (first) {
      const items: Block[][] = [];
      let cur: Item | null = first;
      let end = i;
      while (cur) {
        const body = [cur.rest];
        let j = end + 1;
        let next: Item | null = null;
        while (j < lines.length) {
          const l = lines[j];
          if (blank(l)) {
            let k = j;
            while (k < lines.length && blank(lines[k])) k++;
            if (k >= lines.length) break;
            if (indentOf(lines[k]) >= cur.width) {
              for (; j < k; j++) body.push('');
              continue;
            }
            const sib = listItem(lines[k]);
            if (sib && sib.ordered === first.ordered && sib.indent < cur.width) {
              next = sib;
              j = k;
            }
            break;
          }
          if (indentOf(l) >= cur.width) {
            body.push(l.slice(cur.width));
            j++;
            continue;
          }
          const sib = listItem(l);
          if (sib) {
            if (sib.ordered === first.ordered) next = sib;
            break;
          }
          if (blank(lines[j - 1]) || interrupts(l)) break;
          body.push(l.trimStart());
          j++;
        }
        items.push(parseBlocks(body));
        end = j;
        cur = next;
      }
      blocks.push({ t: 'list', ordered: first.ordered, start: first.ordered ? first.num : 1, items });
      i = end;
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && lines[i + 1].includes('-') && DELIMITER.test(lines[i + 1])) {
      const head = splitRow(line);
      const delim = splitRow(lines[i + 1]);
      if (head.length === delim.length) {
        const align = delim.map((c): Align =>
          c.startsWith(':') ? (c.endsWith(':') ? 'center' : 'left') : c.endsWith(':') ? 'right' : null,
        );
        const rows: Inline[][][] = [];
        i += 2;
        while (i < lines.length && !blank(lines[i]) && lines[i].includes('|')) {
          const cells = splitRow(lines[i++]);
          while (cells.length < head.length) cells.push('');
          rows.push(cells.slice(0, head.length).map((c) => parseInline(c)));
        }
        blocks.push({ t: 'table', align, head: head.map((c) => parseInline(c)), rows });
        continue;
      }
    }

    const para = [line];
    i++;
    while (i < lines.length && !blank(lines[i]) && !interrupts(lines[i])) para.push(lines[i++]);
    blocks.push({ t: 'p', children: parseInline(para.map((l) => l.trim()).join('\n')) });
  }
  return blocks;
}

const PUNCT = /[!-/:-@[-`{-~]/;
const ALNUM = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

// Index of the `]` or `)` closing the bracket at `open`, allowing nesting and escapes.
function closer(text: string, open: number): number {
  const o = text[open];
  const c = o === '[' ? ']' : ')';
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === o) depth++;
    else if (text[i] === c && --depth === 0) return i;
  }
  return -1;
}

// Index of the delimiter closing an emphasis run opened at `from`, or -1.
function findClose(text: string, from: number, d: string): number {
  for (let j = from; j < text.length; j++) {
    if (text[j] === '\\') j++;
    else if (text.startsWith(d, j) && j > from && !SPACE.test(text[j - 1])) {
      if (d.length === 1 && text[j + 1] === d) {
        j++;
        continue;
      }
      if (d[0] === '_' && j + d.length < text.length && ALNUM.test(text[j + d.length])) continue;
      return j;
    }
  }
  return -1;
}

export function parseInline(text: string, inLink = false): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push(buf);
    buf = '';
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (ch === '\n' || (ch === '\\' && text[i + 1] === '\n')) {
      buf = ch === '\n' ? buf.replace(/ +$/, '') : buf;
      flush();
      out.push({ t: 'br' });
      i += ch === '\n' ? 1 : 2;
      continue;
    }
    if (ch === '\\' && i + 1 < text.length && PUNCT.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      let n = 0;
      while (text[i + n] === '`') n++;
      let j = i + n;
      let found = -1;
      while (j < text.length) {
        if (text[j] !== '`') {
          j++;
          continue;
        }
        let m = 0;
        while (text[j + m] === '`') m++;
        if (m === n) {
          found = j;
          break;
        }
        j += m;
      }
      if (found >= 0) {
        let code = text.slice(i + n, found).replace(/\n/g, ' ');
        if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
        flush();
        out.push({ t: 'code', text: code });
        i = found + n;
      } else {
        buf += text.slice(i, i + n);
        i += n;
      }
      continue;
    }
    if (ch === '[' || (ch === '!' && text[i + 1] === '[')) {
      const image = ch === '!';
      const open = image ? i + 1 : i;
      const close = closer(text, open);
      if (close > 0 && text[close + 1] === '(') {
        const end = closer(text, close + 1);
        if (end > 0) {
          const m = /^\s*(?:<([^>]*)>|(\S*))/.exec(text.slice(close + 2, end));
          const href = (m?.[1] ?? m?.[2] ?? '').trim();
          const label = text.slice(open + 1, close);
          const children = image ? [label || href] : parseInline(label, true);
          flush();
          if (SAFE_URL.test(href) && !inLink) out.push({ t: 'link', href, children });
          else out.push(...children);
          i = end + 1;
          continue;
        }
      }
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      const d = text.startsWith(ch + ch, i) ? ch + ch : ch;
      const ok =
        (d !== '~' || d.length === 2) &&
        i + d.length < text.length &&
        !SPACE.test(text[i + d.length]) &&
        (ch !== '_' || i === 0 || !ALNUM.test(text[i - 1]));
      const j = ok ? findClose(text, i + d.length, d) : -1;
      if (j > 0) {
        flush();
        const t = d === '~~' ? 'del' : d.length === 2 ? 'strong' : 'em';
        out.push({ t, children: parseInline(text.slice(i + d.length, j), inLink) });
        i = j + d.length;
        continue;
      }
      buf += d;
      i += d.length;
      continue;
    }
    if (ch === 'h' && !inLink && (i === 0 || !ALNUM.test(text[i - 1]))) {
      const m = /^https?:\/\/[^\s<]+/i.exec(text.slice(i));
      if (m) {
        let url = m[0].replace(/[.,;:!?'"]+$/, '');
        while (url.endsWith(')') && url.split(')').length > url.split('(').length) url = url.slice(0, -1).replace(/[.,;:!?'"]+$/, '');
        flush();
        out.push({ t: 'link', href: url, children: [url] });
        i += url.length;
        continue;
      }
    }
    buf += ch;
    i++;
  }
  flush();
  return out;
}
