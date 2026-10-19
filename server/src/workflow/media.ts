// Pure helpers for the per-ticket media store: what counts as an image, which URLs may be fetched,
// and how media shows up in prompts and pull requests. No I/O, so it is unit-tested directly.
import type { TarEntry } from '../providers/docker/tar.ts';

export const MEDIA_DIR_IN_RUN = '/work/media';
export const MAX_FILE = 10 * 1024 * 1024;
export const MAX_TICKET = 100 * 1024 * 1024;

export type ImageType = 'png' | 'jpeg' | 'gif' | 'webp';

export const CONTENT_TYPES: Record<ImageType, string> = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };
export const EXTENSION: Record<ImageType, string> = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp' };

/** URLs taken from the ticket text are only fetched from GitHub's image hosts. */
export function isGitHubImageUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (u.hostname === 'private-user-images.githubusercontent.com' || u.hostname === 'user-images.githubusercontent.com') return true;
  return u.hostname === 'github.com' && u.pathname.startsWith('/user-attachments/');
}

/** Where GitHub's own image links may redirect to. Only checked on a Location from an allowed URL. */
export function isGitHubRedirect(url: string): boolean {
  if (isGitHubImageUrl(url)) return true;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && (u.hostname === 'objects.githubusercontent.com' || /^github-production-user-asset-[0-9a-f]+\.s3\.amazonaws\.com$/.test(u.hostname));
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Identifies an attachment across the different URLs GitHub shows for it. */
export function imageKey(url: string): string {
  try {
    const u = new URL(url);
    const id = UUID.exec(u.pathname)?.[0];
    return id ? id.toLowerCase() : u.hostname + u.pathname;
  } catch {
    return url;
  }
}

export const validName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(name) && !name.includes('..');

export function sniffImage(buf: Buffer): ImageType | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 6 && ['GIF87a', 'GIF89a'].includes(buf.subarray(0, 6).toString('latin1'))) return 'gif';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

export function extType(name: string): ImageType | null {
  switch (name.split('.').pop()?.toLowerCase()) {
    case 'png':
      return 'png';
    case 'jpg':
    case 'jpeg':
      return 'jpeg';
    case 'gif':
      return 'gif';
    case 'webp':
      return 'webp';
    default:
      return null;
  }
}

export interface ExistingFile {
  source: string;
  size: number;
}

/** Whether a file an agent left in /work/media may enter the store. `name` is the entry's path inside the archive ("media/a.png"). */
export function checkAgentFile(entry: TarEntry, existing: ExistingFile | undefined, usedBytes: number): { ok: true } | { ok: false; reason: string } {
  const name = entry.name.replace(/^\.\//, '');
  if (entry.type === 'link') return { ok: false, reason: "it's a link" };
  if (entry.type === 'dir') return { ok: false, reason: "subfolders aren't kept" };
  if (entry.type !== 'file') return { ok: false, reason: "it isn't a regular file" };
  if (!name.startsWith('media/')) return { ok: false, reason: 'it is outside /work/media' };
  const file = name.slice('media/'.length);
  if (file.includes('/')) return { ok: false, reason: "subfolders aren't kept" };
  if (!validName(file)) return { ok: false, reason: 'the file name is not allowed' };
  const claimed = extType(file);
  if (!claimed) return { ok: false, reason: 'only png, jpg, jpeg, gif and webp files are kept' };
  if (entry.content.length > MAX_FILE) return { ok: false, reason: `it is larger than ${MAX_FILE / 1048576} MB` };
  if (sniffImage(entry.content) !== claimed) return { ok: false, reason: `its contents aren't a ${claimed.toUpperCase()} image` };
  if (existing && (existing.source === 'issue' || existing.source === 'comment')) return { ok: false, reason: 'it would replace an image from the issue' };
  const delta = entry.content.length - (existing?.size ?? 0);
  if (usedBytes + delta > MAX_TICKET) return { ok: false, reason: `the ticket would exceed ${MAX_TICKET / 1048576} MB of images` };
  return { ok: true };
}

/** One line, no brackets (they would break Markdown links), at most 200 characters. */
export const cleanCaption = (text: string) => text.replace(/\s+/g, ' ').replace(/[[\]]/g, '').trim().slice(0, 200);

/** Replaces GitHub image URLs in ticket text with the local path of the stored copy. */
export function replaceImageLinks(text: string, byKey: Map<string, string>): string {
  return text.replace(/https:\/\/[^\s)"'<>\]]+/g, (url) => {
    if (!isGitHubImageUrl(url)) return url;
    const name = byKey.get(imageKey(url));
    return name ? `${MEDIA_DIR_IN_RUN}/${name}` : url;
  });
}

/** Keeps the PR body well under GitHub's size limit. */
const MAX_LINKS = 20;

export interface ScreenshotItem {
  name: string;
  caption: string | null;
}

/** The "Screenshots" line for a pull request body or comment. */
export function screenshotsLine(items: ScreenshotItem[], publicUrl: string | null, ticketId: number): string {
  if (!items.length) return '';
  if (!publicUrl) return '**Screenshots:** open this ticket in Workshop';
  const base = publicUrl.replace(/\/+$/, '');
  const shown = items.slice(0, MAX_LINKS);
  const more = items.length > shown.length ? [`${items.length - shown.length} more on the page`] : [];
  const links = shown.map((i) => `[${cleanCaption(i.caption ?? '') || i.name}](${base}/api/tickets/${ticketId}/media/${i.name})`);
  return `**Screenshots:** [all screenshots](${base}/tickets/${ticketId}/media) · ${[...links, ...more].join(' · ')}`;
}
