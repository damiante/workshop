// The per-ticket media store: images under DATA_DIR/media/<ticket id>/ with one row each in `media`.
// Every agent on a ticket gets the folder at /work/media, and Workshop copies new images back out.
import fs from 'node:fs';
import path from 'node:path';
import type { MediaItem } from './api-types.ts';
import { config } from './config.ts';
import { all, one, run } from './db.ts';
import { publish } from './events.ts';
import type { TarEntry } from './providers/docker/tar.ts';
import type { ImageRef } from './providers/types.ts';
import { appendLog } from './runs.ts';
import { checkAgentFile, cleanCaption, EXTENSION, isGitHubImageUrl, isGitHubRedirect, MAX_FILE, MAX_TICKET, sniffImage } from './workflow/media.ts';

export interface MediaRow {
  id: number;
  ticket_id: number;
  name: string;
  source: string;
  source_key: string | null;
  run_id: string | null;
  caption: string | null;
  size: number;
  created_at: number;
}

const MAX_NEW_PER_RUN = 50;
const PARALLEL = 4;
const MAX_REDIRECTS = 3;

export const mediaDir = (ticketId: number) => path.join(config.dataDir, 'media', String(ticketId));
export const listMedia = (ticketId: number) => all<MediaRow>('SELECT * FROM media WHERE ticket_id = ? ORDER BY created_at, id', ticketId);
export const mediaCount = (ticketId: number) => one<{ n: number }>('SELECT COUNT(*) AS n FROM media WHERE ticket_id = ?', ticketId)?.n ?? 0;
const usedBytes = (ticketId: number) => one<{ n: number }>('SELECT COALESCE(SUM(size), 0) AS n FROM media WHERE ticket_id = ?', ticketId)?.n ?? 0;

export const mediaView = (row: MediaRow): MediaItem => ({
  name: row.name,
  source: row.source,
  runId: row.run_id,
  caption: row.caption,
  size: row.size,
  createdAt: row.created_at,
  url: `/api/tickets/${row.ticket_id}/media/${row.name}`,
});

/** Notes a skipped file or image in the run log, where the owner will see it. */
export function warn(runId: string, text: string) {
  appendLog(runId, { step: 'workshop', stream: 'stderr', text });
}

function save(ticketId: number, name: string, bytes: Buffer, row: { source: string; sourceKey?: string | null; runId?: string | null; caption?: string | null }) {
  fs.mkdirSync(mediaDir(ticketId), { recursive: true });
  fs.writeFileSync(path.join(mediaDir(ticketId), name), bytes);
  run(
    `INSERT INTO media (ticket_id, name, source, source_key, run_id, caption, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (ticket_id, name) DO UPDATE SET source = excluded.source, run_id = excluded.run_id, caption = excluded.caption, size = excluded.size, created_at = excluded.created_at`,
    ticketId,
    name,
    row.source,
    row.sourceKey ?? null,
    row.runId ?? null,
    row.caption ?? null,
    bytes.length,
    Date.now(),
  );
  publish('media');
  publish('tickets');
  publish('runs');
}

/** Downloads one image from an allowed GitHub URL. Redirects are followed only to GitHub's own storage; no credentials are sent. */
async function download(url: string): Promise<Buffer> {
  let current = url;
  for (let hops = 0; ; hops++) {
    const res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(30_000) });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel();
      if (!location) throw new Error('redirect without a location');
      const next = new URL(location, current).toString();
      if (hops >= MAX_REDIRECTS) throw new Error('too many redirects');
      if (!isGitHubRedirect(next)) throw new Error(`redirected to ${new URL(next).hostname}, which isn't a GitHub image host`);
      current = next;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`GitHub answered ${res.status}`);
    }
    const length = Number(res.headers.get('content-length'));
    if (length > MAX_FILE) {
      await res.body?.cancel();
      throw new Error('it is larger than 10 MB');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      total += chunk.length;
      if (total > MAX_FILE) {
        await res.body?.cancel();
        throw new Error('it is larger than 10 MB');
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}

export interface IssueImage {
  source: 'issue' | 'comment';
  ref: ImageRef;
}

/** Copies images from the ticket text into the store, skipping ones already there. A bad image is a run warning, never a failure. */
export async function fetchTicketImages(runId: string, ticketId: number, images: IssueImage[]) {
  const known = new Set(listMedia(ticketId).map((m) => m.source_key).filter(Boolean));
  const todo: IssueImage[] = [];
  for (const i of images) {
    if (known.has(i.ref.key)) continue;
    known.add(i.ref.key);
    todo.push(i);
  }
  const extra = todo.length - MAX_NEW_PER_RUN;
  if (extra > 0) {
    todo.length = MAX_NEW_PER_RUN;
    warn(runId, `Workshop skipped ${extra} image(s) from the ticket: at most ${MAX_NEW_PER_RUN} are copied per run. The rest are copied on the next run.`);
  }
  const next = { n: 0 };
  const one1 = async (i: IssueImage) => {
    try {
      if (!isGitHubImageUrl(i.ref.url)) throw new Error("it isn't hosted by GitHub");
      const bytes = await download(i.ref.url);
      const type = sniffImage(bytes);
      if (!type) throw new Error("it isn't a PNG, JPEG, GIF or WebP image");
      if (usedBytes(ticketId) + bytes.length > MAX_TICKET) throw new Error('the ticket would exceed 100 MB of images');
      const taken = new Set(listMedia(ticketId).map((m) => m.name));
      let n = 1;
      while (taken.has(`${i.source}-${n}.${EXTENSION[type]}`) || fs.existsSync(path.join(mediaDir(ticketId), `${i.source}-${n}.${EXTENSION[type]}`))) n++;
      save(ticketId, `${i.source}-${n}.${EXTENSION[type]}`, bytes, { source: i.source, sourceKey: i.ref.key });
    } catch (err) {
      let where = i.ref.url;
      try {
        const u = new URL(i.ref.url);
        where = u.hostname + u.pathname;
      } catch {
        // keep the raw text
      }
      warn(runId, `Workshop skipped an image from the ticket (${where}): ${(err as Error).message}`);
    }
  };
  const workers = Array.from({ length: Math.min(PARALLEL, todo.length) }, async () => {
    while (next.n < todo.length) await one1(todo[next.n++]);
  });
  await Promise.all(workers);
}

/** Stores the new or changed images an agent left in /work/media. `entries` come from the volume's archive. */
export function collectAgentMedia(runId: string, ticketId: number, agent: string, entries: TarEntry[], captions: Map<string, string>) {
  const ticket = one<{ state: string }>('SELECT state FROM tickets WHERE id = ?', ticketId);
  if (!ticket || ticket.state === 'closed') return; // a copy-back mustn't recreate a store that cleanup just deleted
  for (const entry of entries) {
    const name = entry.name.replace(/^\.\//, '').replace(/\/+$/, '');
    if (name === 'media' && entry.type === 'dir') continue;
    const file = name.replace(/^media\//, '');
    const existing = one<MediaRow>('SELECT * FROM media WHERE ticket_id = ? AND name = ?', ticketId, file);
    const check = checkAgentFile(entry, existing, usedBytes(ticketId));
    if (!check.ok) {
      warn(runId, `Workshop skipped ${name} from /work/media: ${check.reason}.`);
      continue;
    }
    if (existing && fs.existsSync(path.join(mediaDir(ticketId), file)) && fs.readFileSync(path.join(mediaDir(ticketId), file)).equals(entry.content)) continue;
    save(ticketId, file, entry.content, { source: agent, runId, caption: cleanCaption(captions.get(file) ?? '') || null });
  }
}

/** The store as files for putArchive: `media/` always, so agents can write there even when it is empty. */
export function mediaFiles(ticketId: number): Record<string, Buffer | string> {
  const files: Record<string, Buffer | string> = { 'media/': '' };
  for (const m of listMedia(ticketId)) {
    try {
      files[`media/${m.name}`] = fs.readFileSync(path.join(mediaDir(ticketId), m.name));
    } catch {
      // the file is gone from disk; the page would show a broken image, so drop the row
      run('DELETE FROM media WHERE id = ?', m.id);
    }
  }
  return files;
}

export function deleteMedia(ticketId: number) {
  fs.rmSync(mediaDir(ticketId), { recursive: true, force: true });
  const { changes } = run('DELETE FROM media WHERE ticket_id = ?', ticketId);
  if (changes) {
    publish('media');
    publish('tickets');
    publish('runs');
  }
}

/** Deletes the stores of tickets that are gone, closed, or unchanged since `cutoffMs` and not being worked on. */
export function sweepMedia(cutoffMs: number) {
  const ids = new Set(all<{ ticket_id: number }>('SELECT DISTINCT ticket_id FROM media').map((r) => r.ticket_id));
  try {
    for (const d of fs.readdirSync(path.join(config.dataDir, 'media'))) if (/^\d+$/.test(d)) ids.add(Number(d));
  } catch {
    // no media folder yet
  }
  for (const id of ids) {
    const t = one<{ state: string; updated_at: string }>('SELECT state, updated_at FROM tickets WHERE id = ?', id);
    const active = one<{ id: string }>("SELECT id FROM runs WHERE ticket_id = ? AND status IN ('starting', 'running', 'publishing', 'paused')", id);
    if (!t || t.state === 'closed' || (!active && Date.parse(t.updated_at) < cutoffMs)) deleteMedia(id);
  }
}
