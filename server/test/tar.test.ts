import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { tar } from '../src/providers/docker/tar.ts';

it('writes an archive that system tar extracts byte-for-byte', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workshop-tar-'));
  const big = 'x'.repeat(1300) + '\nünïcødé\n';
  fs.writeFileSync(path.join(dir, 'a.tar'), tar({ '.workshop/': '', '.workshop/prompt.md': big, '.workshop/empty.json': '' }));
  execFileSync('tar', ['-xf', 'a.tar'], { cwd: dir });
  expect(fs.readFileSync(path.join(dir, '.workshop/prompt.md'), 'utf8')).toBe(big);
  expect(fs.readFileSync(path.join(dir, '.workshop/empty.json'), 'utf8')).toBe('');
  fs.rmSync(dir, { recursive: true });
});
