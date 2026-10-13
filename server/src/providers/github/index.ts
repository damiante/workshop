import { App, Octokit } from 'octokit';
import type { Installation, ProviderInfo } from '../../api-types.ts';
import type {
  GitAccess,
  LabelDef,
  Mergeability,
  PullRequestState,
  RemoteTicket,
  RepoRef,
  ReviewFeedback,
  TicketComment,
  TicketSource,
  VcsHost,
} from '../types.ts';

export interface GitHubConfig {
  appId: number;
  slug: string;
  owner: string;
  htmlUrl: string;
  /** Installations you've approved. Others (anyone can install a public App) are ignored. */
  installations: number[];
}

export interface GitHubSecret {
  privateKey: string;
}

export const githubInfo: ProviderInfo = {
  id: 'github',
  kind: 'vcs',
  name: 'GitHub',
  description: 'Hosts your code. Workshop acts through its own GitHub App, so PRs and comments come from a bot you can review.',
  setup: 'github-app',
  fields: [
    { key: 'appId', label: 'App ID', type: 'text', required: true, help: 'Shown on the App\'s settings page on GitHub (Settings → Developer settings → GitHub Apps).' },
    { key: 'privateKey', label: 'Private key', type: 'textarea', secret: true, required: true, help: 'Generate one on the same page and paste the whole .pem file.' },
  ],
};

export const githubIssuesInfo: ProviderInfo = {
  id: 'github-issues',
  kind: 'tickets',
  name: 'GitHub Issues',
  description: 'Reads tickets from the issues of each enabled repository, using your GitHub connection.',
  fields: [{ key: 'appConnectionId', label: 'GitHub connection', type: 'connection', connectionProvider: 'github', required: true }],
};

/** The GitHub App manifest Workshop asks GitHub to create (see the App-manifest flow docs). */
export function appManifest(baseUrl: string) {
  return {
    name: `Workshop ${Math.random().toString(36).slice(2, 6)}`,
    url: baseUrl,
    description: 'Automated development agents managed by Workshop.',
    hook_attributes: { url: `${baseUrl}/api/github/webhook`, active: false },
    redirect_url: `${baseUrl}/api/github/manifest/callback`,
    setup_url: `${baseUrl}/api/github/installed`,
    setup_on_update: true,
    // A private App can only be installed on the account that owns it; public lets you add your orgs.
    public: true,
    default_permissions: {
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
      metadata: 'read',
      checks: 'read',
      statuses: 'read',
    },
    default_events: [],
  };
}

/** Exchanges the manifest flow's one-time code for the new App's credentials (valid for an hour). */
export async function convertManifest(code: string) {
  const { data } = await new Octokit().request('POST /app-manifests/{code}/conversions', { code });
  return {
    config: { appId: data.id, slug: data.slug ?? '', owner: (data.owner as { login?: string } | null)?.login ?? '', htmlUrl: data.html_url, installations: [] } as GitHubConfig,
    secret: { privateKey: data.pem } as GitHubSecret,
  };
}

const split = (repo: RepoRef) => {
  const [owner, name] = repo.fullName.split('/');
  return { owner, repo: name };
};

const status = (err: unknown) => (err as { status?: number }).status;

const MERGEABILITY: Record<string, Mergeability> = {
  clean: 'clean',
  unstable: 'clean',
  has_hooks: 'clean',
  dirty: 'conflict',
  behind: 'behind',
  blocked: 'blocked',
};

export class GitHubApp implements VcsHost, TicketSource {
  private app: InstanceType<typeof App>;
  private installationOf = new Map<string, number>();
  private identity?: { name: string; email: string };
  private cfg: GitHubConfig;

  constructor(cfg: GitHubConfig, secret: GitHubSecret) {
    this.cfg = cfg;
    this.app = new App({ appId: cfg.appId, privateKey: secret.privateKey });
  }

  selfLogin() {
    return `${this.cfg.slug}[bot]`;
  }

  /** Confirms the credentials work; returns the App's slug and owner. */
  async describe() {
    const { data } = await this.app.octokit.request('GET /app');
    if (!data) throw new Error('GitHub returned no App for these credentials.');
    return { slug: data.slug ?? '', owner: (data.owner as { login?: string } | null)?.login ?? '', htmlUrl: data.html_url };
  }

  async installations(): Promise<Installation[]> {
    const list = await this.app.octokit.paginate('GET /app/installations', { per_page: 100 });
    return list.map((i) => ({
      id: i.id,
      account: (i.account as { login?: string } | null)?.login ?? String(i.id),
      repositorySelection: i.repository_selection,
      approved: this.cfg.installations.includes(i.id),
    }));
  }

  private async installationFor(repo: RepoRef) {
    let id = this.installationOf.get(repo.fullName);
    if (!id) {
      const { data } = await this.app.octokit.request('GET /repos/{owner}/{repo}/installation', split(repo));
      id = data.id;
      this.installationOf.set(repo.fullName, id);
    }
    if (!this.cfg.installations.includes(id)) throw new Error(`${repo.fullName} belongs to an installation you haven't approved in Workshop.`);
    return id;
  }

  private async kit(repo: RepoRef) {
    return this.app.getInstallationOctokit(await this.installationFor(repo));
  }

  async listRepos(): Promise<RepoRef[]> {
    const repos: RepoRef[] = [];
    for (const id of this.cfg.installations) {
      const kit = await this.app.getInstallationOctokit(id);
      const list = await kit.paginate('GET /installation/repositories', { per_page: 100 });
      for (const r of list) {
        this.installationOf.set(r.full_name, id);
        repos.push({ fullName: r.full_name, defaultBranch: r.default_branch, private: r.private, url: r.html_url });
      }
    }
    return repos;
  }

  async listChanged(repo: RepoRef, since: string | null): Promise<RemoteTicket[]> {
    const kit = await this.kit(repo);
    const issues = await kit.paginate('GET /repos/{owner}/{repo}/issues', {
      ...split(repo),
      state: since ? 'all' : 'open',
      ...(since ? { since } : {}),
      sort: 'updated',
      direction: 'asc',
      per_page: 100,
    });
    return issues
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        nodeId: i.node_id,
        title: i.title,
        body: i.body ?? '',
        state: i.state === 'closed' ? 'closed' : 'open',
        author: i.user?.login ?? 'ghost',
        labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean),
        url: i.html_url,
        updatedAt: i.updated_at,
      }));
  }

  async comments(repo: RepoRef, number: number): Promise<TicketComment[]> {
    const kit = await this.kit(repo);
    const list = await kit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...split(repo), issue_number: number, per_page: 100 });
    return list.map((c) => ({ author: c.user?.login ?? 'ghost', body: c.body ?? '', createdAt: c.created_at }));
  }

  async setLabels(repo: RepoRef, number: number, add: string[], remove: string[]) {
    const kit = await this.kit(repo);
    if (add.length) await kit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/labels', { ...split(repo), issue_number: number, labels: add });
    for (const name of remove) {
      await kit
        .request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}', { ...split(repo), issue_number: number, name })
        .catch((err) => {
          if (status(err) !== 404) throw err;
        });
    }
  }

  async comment(repo: RepoRef, number: number, body: string) {
    const kit = await this.kit(repo);
    await kit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...split(repo), issue_number: number, body });
  }

  async close(repo: RepoRef, number: number) {
    const kit = await this.kit(repo);
    await kit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', { ...split(repo), issue_number: number, state: 'closed', state_reason: 'completed' });
  }

  async ensureLabels(repo: RepoRef, labels: LabelDef[]) {
    const kit = await this.kit(repo);
    const existing = new Set((await kit.paginate('GET /repos/{owner}/{repo}/labels', { ...split(repo), per_page: 100 })).map((l) => l.name));
    for (const l of labels.filter((l) => !existing.has(l.name))) {
      await kit.request('POST /repos/{owner}/{repo}/labels', { ...split(repo), name: l.name, color: l.color, description: l.description });
    }
  }

  async createBranch(repo: RepoRef, branch: string, ticket: { number: number; nodeId?: string }) {
    const kit = await this.kit(repo);
    const { data } = await kit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...split(repo), ref: `heads/${repo.defaultBranch}` });
    if (ticket.nodeId) {
      try {
        // Creates the branch and shows it under the issue's "Development" section.
        await kit.graphql(
          'mutation($issueId: ID!, $oid: GitObjectID!, $name: String!) { createLinkedBranch(input: {issueId: $issueId, oid: $oid, name: $name}) { linkedBranch { id } } }',
          { issueId: ticket.nodeId, oid: data.object.sha, name: branch },
        );
        return;
      } catch {
        // Fall through to a plain branch, e.g. when it already exists.
      }
    }
    await kit.request('POST /repos/{owner}/{repo}/git/refs', { ...split(repo), ref: `refs/heads/${branch}`, sha: data.object.sha }).catch((err) => {
      if (status(err) !== 422) throw err; // already exists
    });
  }

  async gitAccess(repo: RepoRef, write: boolean): Promise<GitAccess> {
    const installation_id = await this.installationFor(repo);
    // A token for this one repository, with only the git access this step needs. Expires in an hour.
    const { data } = await this.app.octokit.request('POST /app/installations/{installation_id}/access_tokens', {
      installation_id,
      repositories: [split(repo).repo],
      permissions: { contents: write ? 'write' : 'read' },
    });
    return {
      url: `https://x-access-token:${data.token}@github.com/${repo.fullName}.git`,
      cleanUrl: `https://github.com/${repo.fullName}.git`,
      ...(await this.commitIdentity(repo)),
    };
  }

  private async commitIdentity(repo: RepoRef) {
    if (!this.identity) {
      const login = `${this.cfg.slug}[bot]`;
      const { data } = await (await this.kit(repo)).request('GET /users/{username}', { username: login });
      this.identity = { name: login, email: `${data.id}+${login}@users.noreply.github.com` };
    }
    return this.identity;
  }

  fileUrl(repo: RepoRef, branch: string, path: string) {
    return `https://github.com/${repo.fullName}/blob/${branch}/${path}`;
  }

  async findPullRequest(repo: RepoRef, branch: string) {
    const kit = await this.kit(repo);
    const { owner } = split(repo);
    const { data } = await kit.request('GET /repos/{owner}/{repo}/pulls', { ...split(repo), head: `${owner}:${branch}`, state: 'all', per_page: 10 });
    return (data.find((p) => p.state === 'open') ?? data[0])?.number ?? null;
  }

  async openPullRequest(repo: RepoRef, p: { branch: string; title: string; body: string }) {
    const kit = await this.kit(repo);
    const { data } = await kit.request('POST /repos/{owner}/{repo}/pulls', { ...split(repo), head: p.branch, base: repo.defaultBranch, title: p.title, body: p.body });
    return { number: data.number, url: data.html_url };
  }

  async updatePullRequest(repo: RepoRef, number: number, body: string) {
    const kit = await this.kit(repo);
    await kit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { ...split(repo), pull_number: number, body, state: 'open' });
  }

  async commentOnPullRequest(repo: RepoRef, number: number, body: string) {
    await this.comment(repo, number, body); // a pull request is an issue on GitHub
  }

  async pullRequestState(repo: RepoRef, number: number, reviewers: string[]): Promise<PullRequestState> {
    const kit = await this.kit(repo);
    const { data: pr } = await kit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...split(repo), pull_number: number });
    const reviews = await kit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', { ...split(repo), pull_number: number, per_page: 100 });
    const allowed = new Set(reviewers.map((r) => r.toLowerCase()));
    // Only a review of the current head commit counts: pushing new work asks for a fresh decision.
    const latest = reviews
      .filter((r) => r.commit_id === pr.head.sha && allowed.has(r.user?.login.toLowerCase() ?? '') && (r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED'))
      .at(-1);
    return {
      number,
      url: pr.html_url,
      state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
      headSha: pr.head.sha,
      mergeable: MERGEABILITY[pr.mergeable_state] ?? 'unknown',
      decision: latest ? (latest.state === 'APPROVED' ? 'approved' : 'changes_requested') : null,
    };
  }

  async reviewFeedback(repo: RepoRef, number: number, reviewers: string[]): Promise<ReviewFeedback[]> {
    const kit = await this.kit(repo);
    const allowed = new Set(reviewers.map((r) => r.toLowerCase()));
    const reviews = await kit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', { ...split(repo), pull_number: number, per_page: 100 });
    const latest = reviews.filter((r) => r.state === 'CHANGES_REQUESTED' && allowed.has(r.user?.login.toLowerCase() ?? '')).at(-1);
    if (!latest) return [];
    const inline = await kit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', { ...split(repo), pull_number: number, per_page: 100 });
    return [
      ...(latest.body ? [{ author: latest.user?.login ?? 'ghost', body: latest.body }] : []),
      ...inline
        .filter((c) => c.pull_request_review_id === latest.id)
        .map((c) => ({ author: c.user.login, body: c.body, path: c.path, line: c.line ?? c.original_line ?? undefined })),
    ];
  }

  async requestReview(repo: RepoRef, number: number, login: string) {
    const kit = await this.kit(repo);
    await kit.request('POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers', { ...split(repo), pull_number: number, reviewers: [login] }).catch((err) => {
      if (status(err) !== 422) throw err; // e.g. not a collaborator; the PR still notifies via the issue link
    });
  }

  async updateBranch(repo: RepoRef, number: number) {
    const kit = await this.kit(repo);
    await kit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch', { ...split(repo), pull_number: number });
  }

  async merge(repo: RepoRef, number: number) {
    const kit = await this.kit(repo);
    try {
      const { data } = await kit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge', { ...split(repo), pull_number: number, merge_method: 'squash' });
      return { merged: data.merged, message: data.message };
    } catch (err) {
      if ([405, 409, 422].includes(status(err) ?? 0)) return { merged: false, message: (err as Error).message };
      throw err;
    }
  }
}
