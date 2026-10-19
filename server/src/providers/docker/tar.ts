/**
 * Minimal POSIX ustar archive for Docker's putArchive: regular files and directories (names
 * ending in "/"), owned by `uid`. Names must be under 100 bytes. Contents are bytes, or text as UTF-8.
 */
export function tar(entries: Record<string, string | Buffer>, uid = 1000, gid = 1000): Buffer {
  const blocks: Buffer[] = [];
  const mtime = Math.floor(Date.now() / 1000);
  for (const [name, content] of Object.entries(entries)) {
    if (Buffer.byteLength(name) >= 100) throw new Error(`tar entry name too long: ${name}`);
    const isDir = name.endsWith('/');
    const body = isDir ? Buffer.alloc(0) : Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512);
    const octal = (offset: number, length: number, value: number) =>
      header.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
    header.write(name, 0, 100, 'utf8');
    octal(100, 8, isDir ? 0o755 : 0o644);
    octal(108, 8, uid);
    octal(116, 8, gid);
    octal(124, 12, body.length);
    octal(136, 12, mtime);
    header.fill(' ', 148, 156);
    header.write(isDir ? '5' : '0', 156, 1, 'ascii');
    header.write('ustar\0' + '00', 257, 8, 'ascii');
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

export interface TarEntry {
  name: string;
  type: 'file' | 'dir' | 'link' | 'other';
  content: Buffer;
}

const field = (block: Buffer, offset: number, length: number) => {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString('utf8');
};

/** Parses PAX extended header records ("<len> key=value\n"). */
function paxRecords(data: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) break;
    const len = Number(data.subarray(pos, space).toString('ascii'));
    if (!Number.isInteger(len) || len <= 0) break;
    const record = data.subarray(space + 1, pos + len - 1).toString('utf8');
    const eq = record.indexOf('=');
    if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
    pos += len;
  }
  return out;
}

/** Reads a tar archive (ustar, with PAX and GNU long names), as returned by Docker's getArchive. */
export function untar(archive: Buffer): TarEntry[] {
  const entries: TarEntry[] = [];
  let pos = 0;
  let nextName: string | undefined;
  let nextSize: number | undefined;
  while (pos + 512 <= archive.length) {
    const header = archive.subarray(pos, pos + 512);
    if (header.every((b) => b === 0)) break;
    const typeflag = String.fromCharCode(header[156] || 0x30);
    let size = nextSize ?? parseInt(field(header, 124, 12).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('Corrupt tar archive.');
    const headerSize = parseInt(field(header, 124, 12).trim() || '0', 8);
    const dataSize = typeflag === 'x' || typeflag === 'g' || typeflag === 'L' ? headerSize : size;
    if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L') size = headerSize;
    const start = pos + 512;
    if (start + dataSize > archive.length) throw new Error('Corrupt tar archive.');
    const data = archive.subarray(start, start + dataSize);
    pos = start + Math.ceil(dataSize / 512) * 512;
    if (typeflag === 'g') continue;
    if (typeflag === 'x') {
      const pax = paxRecords(data);
      if (pax.path) nextName = pax.path;
      if (pax.size) nextSize = Number(pax.size);
      continue;
    }
    if (typeflag === 'L') {
      nextName = data.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    const prefix = field(header, 345, 155);
    const base = field(header, 0, 100);
    const name = nextName ?? (prefix ? `${prefix}/${base}` : base);
    nextName = undefined;
    nextSize = undefined;
    const type = typeflag === '0' ? 'file' : typeflag === '5' ? 'dir' : typeflag === '1' || typeflag === '2' ? 'link' : 'other';
    entries.push({ name, type, content: type === 'file' ? Buffer.from(data) : Buffer.alloc(0) });
  }
  return entries;
}
