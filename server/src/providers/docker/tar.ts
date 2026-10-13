/**
 * Minimal POSIX ustar archive for Docker's putArchive: regular files and directories (names
 * ending in "/"), owned by `uid`. Names must be under 100 bytes.
 */
export function tar(entries: Record<string, string>, uid = 1000, gid = 1000): Buffer {
  const blocks: Buffer[] = [];
  const mtime = Math.floor(Date.now() / 1000);
  for (const [name, content] of Object.entries(entries)) {
    if (Buffer.byteLength(name) >= 100) throw new Error(`tar entry name too long: ${name}`);
    const isDir = name.endsWith('/');
    const body = Buffer.from(isDir ? '' : content, 'utf8');
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
