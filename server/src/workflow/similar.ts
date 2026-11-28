/**
 * Keyword similarity between a proposed prerequisite ticket and an open one, so Workshop can link an existing
 * ticket instead of opening a near-duplicate. Deliberately simple and conservative: the agent's own search of the
 * open-ticket index is the main defence, and this catches the obvious misses.
 */

/** A proposal is a duplicate when its title scores at least this much and shares `MIN_SHARED` title keywords… */
export const TITLE_THRESHOLD = 0.4;
export const MIN_SHARED = 2;
/** …or when title and body together score at least this much. */
export const TEXT_THRESHOLD = 0.4;
/** How much of each body counts. */
export const BODY_CHARS = 500;

const STOP_WORDS = new Set(
  (
    'the and for with from that this into when its are can not but was were has have had will would should could ' +
    'all any each other some such than then them they there these those which while who whom what where why how ' +
    'our out over under also only more most very just about after before between both does doing done being been ' +
    'you your yours their his her him she one two use using via per new way like make makes need needs ticket support'
  ).split(' '),
);
const SUFFIXES = ['ing', 'ed', 'es', 's'];

function stem(word: string): string {
  let w = word;
  for (const s of SUFFIXES) {
    if (w.endsWith(s) && w.length - s.length >= 3) {
      w = w.slice(0, -s.length);
      break;
    }
  }
  // A trailing e too, so "outcome" and "outcomes", or "save" and "saving", meet.
  return w.endsWith('e') && w.length > 3 ? w.slice(0, -1) : w;
}

/** The text's keywords: lowercase words of three or more letters, without stop words, with one suffix and a trailing e stripped. */
export function keywords(text: string): Set<string> {
  const words = text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP_WORDS.has(w));
  return new Set(words.map(stem));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared++;
  return shared / (a.size + b.size - shared);
}

export interface Similarity {
  /** Jaccard of the title keywords. */
  title: number;
  /** Title keywords the two have in common. */
  shared: number;
  /** Jaccard of the keywords of the title plus the start of the body. */
  text: number;
}

type Text = { title: string; body: string };

export function similarity(a: Text, b: Text): Similarity {
  const ta = keywords(a.title);
  const tb = keywords(b.title);
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  const full = (x: Text) => keywords(`${x.title} ${x.body.slice(0, BODY_CHARS)}`);
  return { title: jaccard(ta, tb), shared, text: jaccard(full(a), full(b)) };
}

export const isDuplicate = (s: Similarity) => (s.title >= TITLE_THRESHOLD && s.shared >= MIN_SHARED) || s.text >= TEXT_THRESHOLD;

/** The candidate most similar to `proposal` that counts as a duplicate, if any. */
export function bestMatch<T extends Text>(proposal: Text, candidates: T[]): { match: T; score: Similarity } | null {
  let best: { match: T; score: Similarity } | null = null;
  for (const c of candidates) {
    const score = similarity(proposal, c);
    if (!isDuplicate(score)) continue;
    if (!best || Math.max(score.title, score.text) > Math.max(best.score.title, best.score.text)) best = { match: c, score };
  }
  return best;
}
