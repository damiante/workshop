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

  it('maps the total link count, leaving it undefined when the list has none', async () => {
    const issue = { number: 3, node_id: 'n', title: 't', body: '', state: 'open', user: { login: 'me' }, labels: [], html_url: 'u', updated_at: 'x' };
    const { app } = gh({ issues: [{ ...issue, issue_dependencies_summary: { blocked_by: 0, total_blocked_by: 2 } }, { ...issue, number: 4 }] });
    const list = await app.listChanged(repo, null);
    expect(list.map((t) => t.totalBlockers)).toEqual([2, undefined]);
  });

  it("keeps a blocker's title", async () => {
    const { app } = gh({ blockers: [{ ...link(2), title: 'Expose the API' }] });
    await expect(app.blockers(repo, 3)).resolves.toMatchObject([{ number: 2, title: 'Expose the API' }]);
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

describe('GitHub git access', () => {
  function gh(grantsWorkflows: boolean) {
    const app = new GitHubApp({ appId: 1, slug: 'workshop', owner: 'me', htmlUrl: '', installations: [1] }, { privateKey: 'unused' });
    const request = vi.fn(async (_route: string, params: { permissions: Record<string, string> }) => {
      if (params.permissions.workflows && !grantsWorkflows) throw Object.assign(new Error('The permissions requested are not granted to this installation.'), { status: 422 });
      return { data: { token: 't' } };
    });
    const priv = app as unknown as { app: { octokit: { request: typeof request } }; installationFor: () => unknown; commitIdentity: () => unknown };
    priv.app = { octokit: { request } };
    vi.spyOn(priv, 'installationFor').mockResolvedValue(1);
    vi.spyOn(priv, 'commitIdentity').mockResolvedValue({ name: 'workshop[bot]', email: 'x' });
    return { app, perms: () => request.mock.calls.map(([, p]) => p.permissions) };
  }

  it('asks for workflows when pushing, so agents can change CI files', async () => {
    const { app, perms } = gh(true);
    await app.gitAccess(repo, true);
    expect(perms()).toEqual([{ contents: 'write', workflows: 'write' }]);
  });

  it("still pushes when the installation hasn't accepted workflows", async () => {
    const { app, perms } = gh(false);
    await expect(app.gitAccess(repo, true)).resolves.toMatchObject({ url: expect.stringContaining('x-access-token:t@') });
    expect(perms()).toEqual([{ contents: 'write', workflows: 'write' }, { contents: 'write' }]);
  });

  it('reads with contents only', async () => {
    const { app, perms } = gh(true);
    await app.gitAccess(repo, false);
    expect(perms()).toEqual([{ contents: 'read' }]);
  });
});

describe('GitHub openPullRequest', () => {
  function gh(open: object[]) {
    const app = new GitHubApp({ appId: 1, slug: 'workshop', owner: 'me', htmlUrl: '', installations: [1] }, { privateKey: 'unused' });
    const request = vi.fn(async (route: string) => {
      if (route.startsWith('POST')) throw Object.assign(new Error('Validation Failed: A pull request already exists for me:b.'), { status: 422 });
      return { data: route.startsWith('GET') ? open : {} };
    });
    vi.spyOn(app as unknown as { kit: () => unknown }, 'kit').mockResolvedValue({ request });
    return { app, request };
  }
  const pr = { branch: 'b', title: 't', body: 'new body' };

  it('takes over the open pull request when one already exists for the branch', async () => {
    const { app, request } = gh([{ number: 253, html_url: 'https://github.com/me/app/pull/253' }]);
    await expect(app.openPullRequest({ ...repo, defaultBranch: 'main' }, pr)).resolves.toEqual({ number: 253, url: 'https://github.com/me/app/pull/253' });
    expect(request).toHaveBeenCalledWith('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', expect.objectContaining({ pull_number: 253, body: 'new body' }));
  });

  it('still fails when no open pull request explains the 422', async () => {
    await expect(gh([]).app.openPullRequest({ ...repo, defaultBranch: 'main' }, pr)).rejects.toThrow('already exists');
  });
});

describe('GitHub mergeRules', () => {
  const main = { ...repo, defaultBranch: 'main' };
  const reviewRule = { type: 'pull_request', ruleset_id: 4, parameters: { required_approving_review_count: 1 } };
  const checksRule = { type: 'required_status_checks', ruleset_id: 5, parameters: { required_status_checks: [{ context: 'test' }] } };
  function gh(opts: { rules?: object[]; ruleset?: object | Error; branch?: object; reviews?: object | Error }) {
    const app = new GitHubApp({ appId: 1, slug: 'workshop', owner: 'me', htmlUrl: '', installations: [1] }, { privateKey: 'unused' });
    const answer = (x: object | Error | undefined) => (x instanceof Error ? Promise.reject(x) : Promise.resolve({ data: x ?? {} }));
    const request = vi.fn(async (route: string) => {
      if (route.includes('/rulesets/')) return answer(opts.ruleset);
      if (route.endsWith('required_pull_request_reviews')) return answer(opts.reviews);
      return answer(opts.branch ?? { protected: false });
    });
    vi.spyOn(app as unknown as { kit: () => unknown }, 'kit').mockResolvedValue({ request, paginate: async () => opts.rules ?? [] });
    return app;
  }
  const denied = Object.assign(new Error('Resource not accessible by integration'), { status: 403 });

  it('finds required checks in rulesets and in classic protection', async () => {
    await expect(gh({ rules: [checksRule] }).mergeRules(main)).resolves.toEqual({ reviewRequired: false, checksRequired: true, unknown: [] });
    const branch = { protected: true, protection: { enabled: true, required_status_checks: { contexts: ['ci'] } } };
    await expect(gh({ branch, reviews: Object.assign(new Error('Not Found'), { status: 404 }) }).mergeRules(main)).resolves.toEqual({ reviewRequired: false, checksRequired: true, unknown: [] });
  });

  it('requires a review only when the ruleset says Workshop can never bypass it', async () => {
    const rules = [reviewRule, reviewRule];
    await expect(gh({ rules, ruleset: { name: 'Main', current_user_can_bypass: 'never' } }).mergeRules(main)).resolves.toMatchObject({ reviewRequired: true });
    await expect(gh({ rules, ruleset: { name: 'Main', current_user_can_bypass: 'pull_requests_only' } }).mergeRules(main)).resolves.toMatchObject({ reviewRequired: false, unknown: [] });
    await expect(gh({ rules, ruleset: { name: 'Main' } }).mergeRules(main)).resolves.toMatchObject({
      reviewRequired: false,
      unknown: ['whether it can bypass the "Main" ruleset on main'],
    });
  });

  it("ignores a pull request rule that doesn't need an approval", async () => {
    const rules = [{ ...reviewRule, parameters: { required_approving_review_count: 0 } }];
    await expect(gh({ rules }).mergeRules(main)).resolves.toEqual({ reviewRequired: false, checksRequired: false, unknown: [] });
  });

  it("reads classic protection's reviews, and says so when it can't", async () => {
    const branch = { protected: true, protection: { enabled: true } };
    await expect(gh({ branch, reviews: { required_approving_review_count: 2 } }).mergeRules(main)).resolves.toMatchObject({ reviewRequired: true });
    const unread = await gh({ branch, reviews: denied }).mergeRules(main);
    expect(unread.reviewRequired).toBe(false);
    expect(unread.unknown).toEqual([expect.stringContaining("the review settings of main's branch protection")]);
  });
});

describe('GitHub with a personal access token', () => {
  function gh(routes: Record<string, unknown> = {}) {
    const app = new GitHubApp({ auth: 'token', appId: 0, slug: 'me', owner: 'me', htmlUrl: '', installations: [] }, { token: 'ghp_secret' });
    const request = vi.fn(async (route: string) => ({ data: routes[route] ?? {} }));
    const paginate = vi.fn(async (route: string) => (routes[route] as unknown[]) ?? []);
    (app as unknown as { user: object }).user = { request, paginate };
    return { app, request, paginate };
  }
  const pr = { html_url: 'u', merged: false, state: 'open', head: { sha: 'head' }, mergeable_state: 'clean' };
  const review = (state: string, login = 'me', commit_id = 'head') => ({ state, user: { login }, commit_id, body: 'please fix', id: 1 });
  const decision = async (reviews: object[], reviewers = ['me']) =>
    (await gh({ 'GET /repos/{owner}/{repo}/pulls/{pull_number}': pr, 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': reviews }).app.pullRequestState(repo, 5, reviewers)).decision;

  it('posts as you and has no installations', async () => {
    const { app } = gh();
    expect(app.selfLogin()).toBe('me');
    await expect(app.installations()).resolves.toEqual([]);
  });

  it('describes the account the token belongs to', async () => {
    const { app } = gh({ 'GET /user': { login: 'me', html_url: 'https://github.com/me' } });
    await expect(app.describe()).resolves.toEqual({ slug: 'me', owner: 'me', htmlUrl: 'https://github.com/me' });
  });

  it('lists the repositories the token can push to', async () => {
    const r = (full_name: string, o: object = {}) => ({ full_name, default_branch: 'main', private: false, html_url: `https://github.com/${full_name}`, permissions: { push: true }, archived: false, ...o });
    const { app } = gh({ 'GET /user/repos': [r('me/app'), r('org/read-only', { permissions: { push: false } }), r('me/old', { archived: true })] });
    await expect(app.listRepos()).resolves.toEqual([{ fullName: 'me/app', defaultBranch: 'main', private: false, url: 'https://github.com/me/app' }]);
  });

  it('fetches and pushes with the token, committing as you', async () => {
    const { app } = gh({ 'GET /user': { login: 'me', id: 42 } });
    await expect(app.gitAccess(repo, true)).resolves.toEqual({
      url: 'https://x-access-token:ghp_secret@github.com/me/app.git',
      cleanUrl: 'https://github.com/me/app.git',
      name: 'me',
      email: '42+me@users.noreply.github.com',
    });
  });

  it('takes your comment review on the latest commit as requesting changes', async () => {
    expect(await decision([review('COMMENTED')])).toBe('changes_requested');
    expect(await decision([review('COMMENTED', 'me', 'older')])).toBeNull();
    expect(await decision([review('COMMENTED', 'someone-else')], ['me', 'someone-else'])).toBeNull();
    expect(await decision([review('COMMENTED'), review('APPROVED', 'colleague')], ['me', 'colleague'])).toBe('approved');
  });

  it('gives agents the comment review as feedback', async () => {
    const { app } = gh({ 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews': [review('COMMENTED')] });
    await expect(app.reviewFeedback(repo, 5, ['me'])).resolves.toEqual([{ author: 'me', body: 'please fix', images: [] }]);
  });
});

describe('GitHub App reviews', () => {
  it("doesn't take a comment review as requesting changes", async () => {
    const app = new GitHubApp({ appId: 1, slug: 'workshop', owner: 'me', htmlUrl: '', installations: [1] }, { privateKey: 'unused' });
    const pr = { html_url: 'u', merged: false, state: 'open', head: { sha: 'head' }, mergeable_state: 'clean' };
    const request = vi.fn(async () => ({ data: pr }));
    const paginate = vi.fn(async () => [{ state: 'COMMENTED', user: { login: 'me' }, commit_id: 'head' }]);
    vi.spyOn(app as unknown as { kit: () => unknown }, 'kit').mockResolvedValue({ request, paginate });
    expect((await app.pullRequestState(repo, 5, ['me'])).decision).toBeNull();
  });
});

describe('GitHub pushToDefault', () => {
  const main = { fullName: 'me/app', defaultBranch: 'main' } as Parameters<GitHubApp['pushToDefault']>[0];
  function gh(opts: { behind?: number; refuse?: number }) {
    const app = new GitHubApp({ appId: 1, slug: 'workshop', owner: 'me', htmlUrl: '', installations: [1] }, { privateKey: 'unused' });
    const request = vi.fn(async (route: string, params: { ref?: string }) => {
      if (route.startsWith('GET /repos/{owner}/{repo}/git/ref/')) return { data: { object: { sha: params.ref === 'heads/main' ? 'base' : 'head' } } };
      if (route.includes('/compare/')) return { data: { behind_by: opts.behind ?? 0 } };
      if (route.startsWith('GET /repos/{owner}/{repo}/git/commits/')) return { data: { tree: { sha: 'tree' } } };
      if (route.startsWith('POST /repos/{owner}/{repo}/git/commits')) return { data: { sha: 'new', html_url: 'https://github.com/me/app/commit/new' } };
      if (route.startsWith('PATCH') && opts.refuse) throw Object.assign(new Error('Update is not a fast forward'), { status: opts.refuse });
      return { data: {} };
    });
    vi.spyOn(app as unknown as { kit: () => unknown }, 'kit').mockResolvedValue({ request });
    return { app, request };
  }

  it("commits the branch's files on top of the default branch and moves it there without forcing", async () => {
    const { app, request } = gh({});
    await expect(app.pushToDefault(main, 'workshop/1-x', 'app: fix (#1)')).resolves.toEqual({ ok: true, sha: 'new', url: 'https://github.com/me/app/commit/new' });
    expect(request).toHaveBeenCalledWith('POST /repos/{owner}/{repo}/git/commits', expect.objectContaining({ message: 'app: fix (#1)', tree: 'tree', parents: ['base'] }));
    expect(request).toHaveBeenCalledWith('PATCH /repos/{owner}/{repo}/git/refs/{ref}', expect.objectContaining({ ref: 'heads/main', sha: 'new', force: false }));
  });

  it("refuses a branch that lacks commits from the default branch, since its files would undo them", async () => {
    const { app, request } = gh({ behind: 2 });
    await expect(app.pushToDefault(main, 'workshop/1-x', 'm')).resolves.toMatchObject({ ok: false });
    expect(request).not.toHaveBeenCalledWith(expect.stringMatching(/^(POST|PATCH)/), expect.anything());
  });

  it('reports a refused update instead of throwing', async () => {
    await expect(gh({ refuse: 422 }).app.pushToDefault(main, 'workshop/1-x', 'm')).resolves.toEqual({ ok: false, message: 'Update is not a fast forward' });
  });
});
