import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { tar, untar } from '../src/providers/docker/tar.ts';

it('writes an archive that system tar extracts byte-for-byte', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-tar-'));
  const big = 'x'.repeat(1300) + '\nünïcødé\n';
  fs.writeFileSync(path.join(dir, 'a.tar'), tar({ '.workshop/': '', '.workshop/prompt.md': big, '.workshop/empty.json': '' }));
  execFileSync('tar', ['-xf', 'a.tar'], { cwd: dir });
  expect(fs.readFileSync(path.join(dir, '.workshop/prompt.md'), 'utf8')).toBe(big);
  expect(fs.readFileSync(path.join(dir, '.workshop/empty.json'), 'utf8')).toBe('');
  fs.rmSync(dir, { recursive: true });
});

it('round-trips binary contents through system tar and untar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-tar-'));
  const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const sizes = [0, 511, 512, 513];
  const entries: Record<string, Buffer> = { 'media/all.bin': all };
  for (const n of sizes) entries[`media/size-${n}.bin`] = Buffer.from(Array.from({ length: n }, (_, i) => (i * 7) % 256));
  const archive = tar({ 'media/': '', ...entries });
  fs.writeFileSync(path.join(dir, 'a.tar'), archive);
  execFileSync('tar', ['-xf', 'a.tar'], { cwd: dir });
  for (const [name, content] of Object.entries(entries)) expect(fs.readFileSync(path.join(dir, name)).equals(content)).toBe(true);
  const back = untar(archive);
  expect(back.map((e) => e.name)).toEqual(['media/', ...Object.keys(entries)]);
  expect(back[0].type).toBe('dir');
  for (const e of back.slice(1)) expect(e.content.equals(entries[e.name])).toBe(true);
  fs.rmSync(dir, { recursive: true });
});

it('reads links and long names from an archive made by system tar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-tar-'));
  const long = 'n'.repeat(120) + '.png';
  fs.mkdirSync(path.join(dir, 'media'));
  fs.writeFileSync(path.join(dir, 'media', long), 'data');
  fs.symlinkSync('/etc/passwd', path.join(dir, 'media', 'link.png'));
  for (const format of ['pax', 'gnu']) {
    execFileSync('tar', ['-cf', `${format}.tar`, `--format=${format}`, 'media'], { cwd: dir });
    const entries = untar(fs.readFileSync(path.join(dir, `${format}.tar`)));
    expect(entries.find((e) => e.name === `media/${long}`)?.content.toString()).toBe('data');
    expect(entries.find((e) => e.name === 'media/link.png')?.type).toBe('link');
  }
  fs.rmSync(dir, { recursive: true });
});
