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
