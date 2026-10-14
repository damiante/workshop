import { describe, expect, it, vi } from 'vitest';
import { GitHubApp } from '../src/providers/github/index.ts';

const repo = { fullName: 'me/app' } as Parameters<GitHubApp['close']>[0];

function withIssue(state: string) {
  const gh = new GitHubApp({ appId: 1, slug: 'workshop', owner: 'me', htmlUrl: '', installations: [1] }, { privateKey: 'unused' });
  const request = vi.fn(async (route: string) => {
    if (route.startsWith('PATCH')) throw Object.assign(new Error('This issue was closed by another request.'), { status: 422 });
    return { data: { state } };
  });
  vi.spyOn(gh as unknown as { kit: () => unknown }, 'kit').mockResolvedValue({ request });
  return gh;
}

describe('GitHub close', () => {
  it("accepts an issue GitHub already closed through the PR's Closes #n", async () => {
    await expect(withIssue('closed').close(repo, 1)).resolves.toBeUndefined();
  });

  it('still fails when the issue stayed open', async () => {
    await expect(withIssue('open').close(repo, 1)).rejects.toThrow('closed by another request');
  });
});

describe('GitHub blockers', () => {
  const link = (n: number, state = 'open') => ({ number: n, state, html_url: `https://github.com/me/app/issues/${n}`, repository_url: 'https://api.github.com/repos/me/app' });
  function gh(opts: { blockers?: object[]; issue?: object; issues?: object[] }) {
    const app = new GitHubApp({ appId: 1, slug: 'workshop', owner: 'me', htmlUrl: '', installations: [1] }, { privateKey: 'unused' });
    const request = vi.fn(async (route: string) => {
      if (route.startsWith('GET')) {
        if (!opts.issue) throw Object.assign(new Error('Not Found'), { status: 404 });
        return { data: opts.issue };
      }
      return { data: {} };
    });
    const paginate = vi.fn(async (route: string) => (route.includes('dependencies') ? (opts.blockers ?? []) : (opts.issues ?? [])));
    vi.spyOn(app as unknown as { kit: () => unknown }, 'kit').mockResolvedValue({ request, paginate });
    return { app, request };
  }

  it("links a blocker by the issue's id, not its number", async () => {
    const { app, request } = gh({ issue: { ...link(2), id: 9002 } });
    await expect(app.addBlocker(repo, 3, 2)).resolves.toMatchObject({ repo: 'me/app', number: 2, state: 'open' });
    expect(request).toHaveBeenCalledWith('POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by', expect.objectContaining({ issue_number: 3, issue_id: 9002 }));
  });

  it('skips the POST when the link already exists', async () => {
    const { app, request } = gh({ issue: { ...link(2), id: 9002 }, blockers: [link(2)] });
    await expect(app.addBlocker(repo, 3, 2)).resolves.toMatchObject({ number: 2 });
    expect(request).not.toHaveBeenCalledWith(expect.stringMatching(/^POST/), expect.anything());
  });

  it('refuses a pull request or a missing issue', async () => {
    await expect(gh({ issue: { ...link(2), id: 1, pull_request: {} } }).app.addBlocker(repo, 3, 2)).rejects.toThrow("#2 isn't an issue in me/app.");
    await expect(gh({}).app.addBlocker(repo, 3, 2)).rejects.toThrow("#2 isn't an issue in me/app.");
  });

  it('reads blockers with their state and repo', async () => {
    const { app } = gh({ blockers: [link(2), { ...link(5, 'closed'), repository_url: 'https://api.github.com/repos/other/repo' }] });
    await expect(app.blockers(repo, 3)).resolves.toMatchObject([{ repo: 'me/app', number: 2, state: 'open' }, { repo: 'other/repo', number: 5, state: 'closed' }]);
  });

  it('maps the open-blocker count from the issue list', async () => {
    const issue = { number: 3, node_id: 'n', title: 't', body: '', state: 'open', user: { login: 'me' }, labels: [], html_url: 'u', updated_at: 'x' };
    const { app } = gh({ issues: [{ ...issue, issue_dependencies_summary: { blocked_by: 1 } }, { ...issue, number: 4 }] });
    const list = await app.listChanged(repo, null);
    expect(list.map((t) => t.openBlockers)).toEqual([1, 0]);
  });
});

describe('GitHub ensureLabels', () => {
  it('accepts a label created by a concurrent enable', async () => {
    const gh = new GitHubApp({ appId: 1, slug: 'workshop', owner: 'me', htmlUrl: '', installations: [1] }, { privateKey: 'unused' });
    const request = vi.fn(async () => {
      throw Object.assign(new Error('Validation Failed: {"resource":"Label","code":"already_exists","field":"name"}'), { status: 422 });
    });
    vi.spyOn(gh as unknown as { kit: () => unknown }, 'kit').mockResolvedValue({ request, paginate: async () => [] });
    await expect(gh.ensureLabels(repo, [{ name: 'workshop/skip', color: '9e9e9e', description: '' }])).resolves.toBeUndefined();
    expect(request).toHaveBeenCalledOnce();
  });
});
