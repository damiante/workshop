import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const hasGit = spawnSync('git', ['--version']).status === 0;
const SCRIPT = path.resolve(import.meta.dirname, '../../agent/entrypoint.sh');
const BRANCH = 'workshop/1-test';

describe.skipIf(!hasGit)('entrypoint publish (real git)', () => {
  let dir: string;
  let remote: string;
  let work: string;
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const step = (name: string) =>
    spawnSync('bash', [SCRIPT, name], {
      encoding: 'utf8',
      env: {
        ...process.env,
        WORKSHOP_DIR: work,
        REPO_URL: remote,
        CLEAN_URL: 'https://example.invalid/me/app.git',
        PUSH_URL: remote,
        BRANCH,
        BASE_BRANCH: 'main',
        GIT_NAME: 't',
        GIT_EMAIL: 't@t',
      },
    });
  const commit = (cwd: string, file: string, text: string) => {
    fs.writeFileSync(path.join(cwd, file), text);
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', `edit ${file}`);
  };
  /** A second clone moves the branch on the remote, as the owner would. */
  const other = (file: string, text: string) => {
    const c = path.join(dir, 'other');
    fs.rmSync(c, { recursive: true, force: true });
    git(dir, 'clone', '-q', remote, c);
    const exists = spawnSync('git', ['rev-parse', '--verify', '-q', `origin/${BRANCH}`], { cwd: c }).status === 0;
    git(c, 'checkout', '-q', '-B', BRANCH, exists ? `origin/${BRANCH}` : 'origin/main');
    commit(c, file, text);
    git(c, 'push', '-q', 'origin', `HEAD:refs/heads/${BRANCH}`);
    return git(c, 'rev-parse', 'HEAD');
  };
  const tip = () => git(remote, 'rev-parse', `refs/heads/${BRANCH}`);
  const repoDir = () => path.join(work, 'repo');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-'));
    remote = path.join(dir, 'remote.git');
    work = path.join(dir, 'work');
    fs.mkdirSync(work);
    git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
    const seed = path.join(dir, 'seed');
    git(dir, 'clone', '-q', remote, seed);
    git(seed, 'checkout', '-q', '-b', 'main');
    commit(seed, 'a.txt', 'one\n');
    git(seed, 'push', '-q', 'origin', 'main');
    expect(step('prepare').status).toBe(0);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('pushes new commits', () => {
    commit(repoDir(), 'b.txt', 'x\n');
    const r = step('publish');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1)!);
    expect(out.after).toBe(tip());
    expect(out.ahead).toBe(1);
  });

  it('merges in a non-conflicting commit that appeared on the remote', () => {
    commit(repoDir(), 'b.txt', 'x\n');
    const theirs = other('c.txt', 'y\n');
    const r = step('publish');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1)!);
    expect(out.before).toBe(theirs);
    expect(out.after).toBe(tip());
    expect(out.after).not.toBe(theirs);
    expect(git(remote, 'ls-tree', '--name-only', tip()).split('\n')).toEqual(expect.arrayContaining(['b.txt', 'c.txt']));
    expect(fs.existsSync(path.join(repoDir(), '.git/FETCH_HEAD'))).toBe(false);
  });

  it('saves the work on a separate branch when the changes conflict', () => {
    commit(repoDir(), 'a.txt', 'mine\n');
    const mine = git(repoDir(), 'rev-parse', 'HEAD');
    const theirs = other('a.txt', 'theirs\n');
    const r = step('publish');
    expect(r.status).toBe(3);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1)!);
    expect(git(remote, 'rev-parse', `refs/heads/${out.rescued}`)).toBe(mine);
    expect(tip()).toBe(theirs);
    expect(fs.existsSync(path.join(repoDir(), '.git/MERGE_HEAD'))).toBe(false);
    expect(fs.readFileSync(path.join(repoDir(), 'a.txt'), 'utf8')).not.toContain('<<<<<<<');
    expect(fs.existsSync(path.join(repoDir(), '.git/FETCH_HEAD'))).toBe(false);
  });

  it('pushes a branch the agent rebased when nobody else moved it', () => {
    commit(repoDir(), 'b.txt', 'x\n');
    expect(step('publish').status).toBe(0);
    const seed = path.join(dir, 'seed');
    commit(seed, 'c.txt', 'y\n');
    git(seed, 'push', '-q', 'origin', 'main');
    expect(step('prepare').status).toBe(0);
    git(repoDir(), 'rebase', '-q', 'origin/main');
    commit(repoDir(), 'd.txt', 'z\n');
    const mine = git(repoDir(), 'rev-parse', 'HEAD');
    const r = step('publish');
    expect(r.status).toBe(0);
    expect(tip()).toBe(mine);
  });

  it('reports no new commits when the agent committed nothing and the remote moved', () => {
    const theirs = other('c.txt', 'y\n');
    const r = step('publish');
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1)!);
    expect(out.before).toBe(theirs);
    expect(out.after).toBe(theirs);
  });
});
