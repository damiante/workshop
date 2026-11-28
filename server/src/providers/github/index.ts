import { App, Octokit } from 'octokit';
import type { Installation, ProviderInfo } from '../../api-types.ts';
import { imageKey, isGitHubImageUrl } from '../../workflow/media.ts';
import type {
  BranchState,
  GitAccess,
  ImageRef,
  LabelDef,
  Mergeability,
  MergeRules,
  PullRequestState,
  RemoteTicket,
  RepoRef,
  ReviewFeedback,
  TicketComment,
  TicketLink,
  TicketSource,
  VcsHost,
} from '../types.ts';

export interface GitHubConfig {
  /** How Workshop signs in: as its own GitHub App (the default), or as you, with a personal access token. */
  auth?: 'app' | 'token';
  appId: number;
  /** The App's slug, or with a token your login. */
  slug: string;
  owner: string;
  htmlUrl: string;
  /** Installations you've approved. Others (anyone can install a public App) are ignored. */
  installations: number[];
}

export interface GitHubSecret {
  privateKey?: string;
  token?: string;
}

export const githubInfo: ProviderInfo = {
  id: 'github',
  kind: 'vcs',
  name: 'GitHub',
  description: 'Hosts your code. Workshop acts through its own GitHub App, so PRs and comments come from a bot you can review, or as you, with a personal access token.',
  setup: 'github-app',
  fields: [
    {
      key: 'auth',
      label: 'Sign in as',
      type: 'select',
      defaultValue: 'app',
      options: [
        { value: 'app', label: "A GitHub App (Workshop's own bot)" },
        { value: 'token', label: 'You, with a personal access token' },
      ],
    },
    // '' is a connection saved before there was a choice: an App.
    { key: 'appId', label: 'App ID', type: 'text', required: true, showIf: { key: 'auth', equals: ['app', ''] }, help: 'Shown on the App\'s settings page on GitHub (Settings → Developer settings → GitHub Apps).' },
    { key: 'privateKey', label: 'Private key', type: 'textarea', secret: true, required: true, showIf: { key: 'auth', equals: ['app', ''] }, help: 'Generate one on the same page and paste the whole .pem file.' },
    {
      key: 'token',
      label: 'Personal access token',
      type: 'password',
      secret: true,
      required: true,
      showIf: { key: 'auth', equals: ['token'] },
      help: 'Fine-grained: contents, issues, pull requests and workflows (read and write) on the repositories Workshop should work on. Classic: the repo and workflow scopes. Commits, comments and pull requests are yours, and GitHub won\'t let you approve your own pull request: see the README.',
    },
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
      workflows: 'write',
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

interface IssueLike {
  number: number;
  title?: string;
  state: string;
  html_url: string;
  repository_url?: string;
  pull_request?: unknown;
}

/** The repo comes from `repository_url` (…/repos/owner/name), or from the issue's page URL. */
function toLink(i: IssueLike): TicketLink {
  const parts = (i.repository_url ? i.repository_url.split('/').slice(-2) : new URL(i.html_url).pathname.split('/').slice(1, 3)).join('/');
  return { repo: parts, number: i.number, state: i.state === 'closed' ? 'closed' : 'open', url: i.html_url, ...(i.title !== undefined ? { title: i.title } : {}) };
}

const MERGEABILITY: Record<string, Mergeability> = {
  clean: 'clean',
  unstable: 'clean',
  has_hooks: 'clean',
  dirty: 'conflict',
  behind: 'behind',
  blocked: 'blocked',
};

/**
 * Waits out a short rate-limit pause once; a longer one fails at once (as a rate-limit error), because waiting
 * would hold up the scheduler tick, and with it every launch, for up to an hour.
 */
const shortWait = (retryAfter: number, options: { request: { retryCount: number } }) => options.request.retryCount === 0 && retryAfter <= 60;

export class GitHubApp implements VcsHost, TicketSource {
  /** Unset when signed in with a personal access token. */
  private app!: InstanceType<typeof App>;
  /** Signed in as you, with a personal access token. Unset for an App. */
  private user?: Octokit;
  private token?: string;
  private installationOf = new Map<string, number>();
  private identity?: { name: string; email: string };
  private cfg: GitHubConfig;
  private limitedUntil = 0;

  constructor(cfg: GitHubConfig, secret: GitHubSecret) {
    this.cfg = cfg;
    // shortcut: one reset time for the whole App, though GitHub limits each installation; fine with one installation.
    const limited = (retryAfter: number, options: { request: { retryCount: number } }) => {
      this.limitedUntil = Math.max(this.limitedUntil, Date.now() + retryAfter * 1000);
      return shortWait(retryAfter, options);
    };
    const Throttled = Octokit.defaults({ throttle: { onRateLimit: limited, onSecondaryRateLimit: limited } });
    if (cfg.auth === 'token') {
      this.token = secret.token ?? '';
      this.user = new Throttled({ auth: this.token });
    } else this.app = new App({ appId: cfg.appId, privateKey: secret.privateKey ?? '', Octokit: Throttled });
  }

  rateLimitedUntil() {
    return this.limitedUntil > Date.now() ? this.limitedUntil : null;
  }

  selfLogin() {
    return this.user ? this.cfg.slug : `${this.cfg.slug}[bot]`;
  }

  /** Confirms the credentials work; returns the App's slug and owner, or with a token your login for both. */
  async describe() {
    if (this.user) {
      const { data } = await this.user.request('GET /user');
      return { slug: data.login, owner: data.login, htmlUrl: data.html_url };
    }
    const { data } = await this.app.octokit.request('GET /app');
    if (!data) throw new Error('GitHub returned no App for these credentials.');
    return { slug: data.slug ?? '', owner: (data.owner as { login?: string } | null)?.login ?? '', htmlUrl: data.html_url };
  }

  async installations(): Promise<Installation[]> {
    if (this.user) return [];
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
    return this.user ?? this.app.getInstallationOctokit(await this.installationFor(repo));
  }

  async listRepos(): Promise<RepoRef[]> {
    const repos: RepoRef[] = [];
    if (this.user) {
      // Every repository the token can push to. A fine-grained token only lists the repositories it was given.
      const list = await this.user.paginate('GET /user/repos', { per_page: 100, sort: 'full_name' });
      return list.filter((r) => r.permissions?.push && !r.archived).map((r) => ({ fullName: r.full_name, defaultBranch: r.default_branch, private: r.private, url: r.html_url }));
    }
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
      .map((i) => {
        const summary = (i as { issue_dependencies_summary?: { blocked_by?: number; total_blocked_by?: number } }).issue_dependencies_summary;
        return {
          number: i.number,
          nodeId: i.node_id,
          title: i.title,
          body: i.body ?? '',
          state: i.state === 'closed' ? 'closed' : 'open',
          author: i.user?.login ?? 'ghost',
          labels: i.labels.map((l) => (typeof l === 'string' ? l : l.name ?? '')).filter(Boolean),
          url: i.html_url,
          updatedAt: i.updated_at,
          createdAt: i.created_at,
          openBlockers: summary?.blocked_by ?? 0,
          // Left undefined when missing, so it doesn't read as "no links".
          totalBlockers: summary?.total_blocked_by,
        };
      });
  }

  async blockers(repo: RepoRef, number: number): Promise<TicketLink[]> {
    const kit = await this.kit(repo);
    const list = (await kit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by', {
      ...split(repo),
      issue_number: number,
      per_page: 100,
    })) as IssueLike[];
    return list.map(toLink);
  }

  async addBlocker(repo: RepoRef, number: number, blocker: number): Promise<TicketLink> {
    const kit = await this.kit(repo);
    const notIssue = new Error(`#${blocker} isn't an issue in ${repo.fullName}.`);
    const data = await kit
      .request('GET /repos/{owner}/{repo}/issues/{issue_number}', { ...split(repo), issue_number: blocker })
      .then((r) => r.data as IssueLike & { id: number })
      .catch((err) => {
        throw status(err) === 404 ? notIssue : err;
      });
    if (data.pull_request) throw notIssue;
    const existing = (await this.blockers(repo, number)).find((l) => l.number === blocker && l.repo.toLowerCase() === repo.fullName.toLowerCase());
    if (existing) return existing;
    await kit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/dependencies/blocked_by', { ...split(repo), issue_number: number, issue_id: data.id });
    return toLink({ ...data, repository_url: undefined });
  }

  async comments(repo: RepoRef, number: number): Promise<TicketComment[]> {
    const kit = await this.kit(repo);
    const list = await kit.paginate('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...split(repo), issue_number: number, per_page: 100, ...FULL });
    return list.map((c) => ({ author: c.user?.login ?? 'ghost', body: c.body ?? '', createdAt: c.created_at, images: imageRefs((c as { body_html?: string }).body_html ?? '') }));
  }

  async ticketImages(repo: RepoRef, number: number): Promise<ImageRef[]> {
    // format: 'full' asks for body_html too: its signed image links work on private repositories.
    const kit = await this.kit(repo);
    const { data } = await kit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', { ...split(repo), issue_number: number, mediaType: { format: 'full' } });
    return imageRefs((data as { body_html?: string }).body_html ?? '');
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

  async createTicket(repo: RepoRef, t: { title: string; body: string; labels: string[] }) {
    const kit = await this.kit(repo);
    const { data } = await kit.request('POST /repos/{owner}/{repo}/issues', { ...split(repo), ...t });
    return { number: data.number, url: data.html_url, nodeId: data.node_id, author: data.user?.login, createdAt: data.created_at, updatedAt: data.updated_at };
  }

  async comment(repo: RepoRef, number: number, body: string) {
    const kit = await this.kit(repo);
    await kit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', { ...split(repo), issue_number: number, body });
  }

  async close(repo: RepoRef, number: number, reason: 'completed' | 'not_planned' = 'completed') {
    const kit = await this.kit(repo);
    try {
      await kit.request('PATCH /repos/{owner}/{repo}/issues/{issue_number}', { ...split(repo), issue_number: number, state: 'closed', state_reason: reason });
    } catch (err) {
      // A merged PR's "Closes #n" can close the issue a moment before we do; GitHub rejects the second close.
      if ((err as { status?: number }).status !== 422) throw err;
      const { data } = await kit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', { ...split(repo), issue_number: number });
      if (data.state !== 'closed') throw err;
    }
  }

  async ensureLabels(repo: RepoRef, labels: LabelDef[]) {
    const kit = await this.kit(repo);
    const existing = new Set((await kit.paginate('GET /repos/{owner}/{repo}/labels', { ...split(repo), per_page: 100 })).map((l) => l.name));
    for (const l of labels.filter((l) => !existing.has(l.name))) {
      try {
        await kit.request('POST /repos/{owner}/{repo}/labels', { ...split(repo), name: l.name, color: l.color, description: l.description });
      } catch (err) {
        // Two enables at once (a second click while the first is still creating labels) race to create the same label.
        if (!String((err as Error).message).includes('already_exists')) throw err;
      }
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
    // A personal access token can't be narrowed to one repository or to read-only: both steps get the token itself.
    if (this.user) {
      return { url: `https://x-access-token:${this.token}@github.com/${repo.fullName}.git`, cleanUrl: `https://github.com/${repo.fullName}.git`, ...(await this.commitIdentity(repo)) };
    }
    const installation_id = await this.installationFor(repo);
    // A token for this one repository, with only the git access this step needs. Expires in an hour.
    const token = (permissions: Record<string, string>) =>
      this.app.octokit.request('POST /app/installations/{installation_id}/access_tokens', { installation_id, repositories: [split(repo).repo], permissions });
    // Pushing changes under .github/workflows needs `workflows`. Installations that haven't accepted it get a 422, so push without it.
    const { data } = write
      ? await token({ contents: 'write', workflows: 'write' }).catch((err) => {
          if (status(err) !== 422) throw err;
          return token({ contents: 'write' });
        })
      : await token({ contents: 'read' });
    return {
      url: `https://x-access-token:${data.token}@github.com/${repo.fullName}.git`,
      cleanUrl: `https://github.com/${repo.fullName}.git`,
      ...(await this.commitIdentity(repo)),
    };
  }

  private async commitIdentity(repo: RepoRef) {
    if (!this.identity && this.user) {
      const { data } = await this.user.request('GET /user');
      this.identity = { name: data.login, email: `${data.id}+${data.login}@users.noreply.github.com` };
    }
    if (!this.identity) {
      const login = `${this.cfg.slug}[bot]`;
      const { data } = await (await this.kit(repo)).request('GET /users/{username}', { username: login });
      this.identity = { name: login, email: `${data.id}+${login}@users.noreply.github.com` };
    }
    return this.identity;
  }

  async readFolder(repo: RepoRef, ref: string, path: string) {
    const kit = await this.kit(repo);
    const get = (p: string) => kit.request('GET /repos/{owner}/{repo}/contents/{path}', { ...split(repo), path: p, ref });
    const { data } = await get(path).catch((err) => {
      if (status(err) === 404) return { data: null };
      throw err;
    });
    if (!Array.isArray(data)) return null;
    const entries = data.filter((e) => e.type === 'file');
    // The contents API returns files up to 1 MB inline; a build context should be far smaller anyway.
    if (entries.length > 20 || entries.some((e) => e.size > 1048576)) throw new Error(`${path}/ holds more than 20 files or a file over 1 MB.`);
    const files: Record<string, Buffer> = {};
    for (const e of entries) {
      const { data: file } = await get(e.path);
      files[e.name] = Buffer.from((file as { content?: string }).content ?? '', 'base64');
    }
    return files;
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
    try {
      const { data } = await kit.request('POST /repos/{owner}/{repo}/pulls', { ...split(repo), head: p.branch, base: repo.defaultBranch, title: p.title, body: p.body });
      return { number: data.number, url: data.html_url };
    } catch (err) {
      // "A pull request already exists": a retried POST or an earlier run opened it. Take it over.
      if (status(err) !== 422) throw err;
      const { data } = await kit.request('GET /repos/{owner}/{repo}/pulls', { ...split(repo), head: `${split(repo).owner}:${p.branch}`, state: 'open' });
      if (!data[0]) throw err;
      await kit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { ...split(repo), pull_number: data[0].number, body: p.body });
      return { number: data[0].number, url: data[0].html_url };
    }
  }

  async updatePullRequest(repo: RepoRef, number: number, body: string) {
    const kit = await this.kit(repo);
    await kit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { ...split(repo), pull_number: number, body, state: 'open' });
  }

  async commentOnPullRequest(repo: RepoRef, number: number, body: string) {
    await this.comment(repo, number, body); // a pull request is an issue on GitHub
  }

  async closePullRequest(repo: RepoRef, number: number) {
    const kit = await this.kit(repo);
    await kit.request('PATCH /repos/{owner}/{repo}/pulls/{pull_number}', { ...split(repo), pull_number: number, state: 'closed' });
  }

  async deleteBranch(repo: RepoRef, branch: string) {
    const kit = await this.kit(repo);
    try {
      await kit.request('DELETE /repos/{owner}/{repo}/git/refs/{ref}', { ...split(repo), ref: `heads/${branch}` });
    } catch (err) {
      if (status(err) !== 404 && status(err) !== 422) throw err; // already gone
    }
  }

  async pullRequestState(repo: RepoRef, number: number, reviewers: string[]): Promise<PullRequestState> {
    const kit = await this.kit(repo);
    const { data: pr } = await kit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', { ...split(repo), pull_number: number });
    const reviews = await kit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', { ...split(repo), pull_number: number, per_page: 100 });
    const allowed = new Set(reviewers.map((r) => r.toLowerCase()));
    // Only a review of the current head commit counts: pushing new work asks for a fresh decision.
    const latest = reviews.filter((r) => r.commit_id === pr.head.sha && allowed.has(r.user?.login.toLowerCase() ?? '') && (r.state === 'APPROVED' || this.asksForChanges(r))).at(-1);
    return {
      number,
      url: pr.html_url,
      state: pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'open',
      headSha: pr.head.sha,
      mergeable: MERGEABILITY[pr.mergeable_state] ?? 'unknown',
      decision: latest ? (latest.state === 'APPROVED' ? 'approved' : 'changes_requested') : null,
    };
  }

  /**
   * Whether a review sends the ticket back. With a personal access token the pull request is your own, and GitHub
   * only lets you comment on it: a comment review from you counts as requesting changes. Workshop itself never reviews.
   */
  private asksForChanges(r: { state: string; user?: { login: string } | null }) {
    if (r.state === 'CHANGES_REQUESTED') return true;
    return Boolean(this.user) && r.state === 'COMMENTED' && r.user?.login.toLowerCase() === (this.cfg.slug ?? '').toLowerCase();
  }

  async reviewFeedback(repo: RepoRef, number: number, reviewers: string[]): Promise<ReviewFeedback[]> {
    const kit = await this.kit(repo);
    const allowed = new Set(reviewers.map((r) => r.toLowerCase()));
    const reviews = await kit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', { ...split(repo), pull_number: number, per_page: 100, ...FULL });
    const latest = reviews.filter((r) => this.asksForChanges(r) && allowed.has(r.user?.login.toLowerCase() ?? '')).at(-1);
    if (!latest) return [];
    const inline = await kit.paginate('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', { ...split(repo), pull_number: number, per_page: 100, ...FULL });
    const html = (x: object) => imageRefs((x as { body_html?: string }).body_html ?? '');
    return [
      ...(latest.body ? [{ author: latest.user?.login ?? 'ghost', body: latest.body, images: html(latest) }] : []),
      ...inline
        .filter((c) => c.pull_request_review_id === latest.id)
        .map((c) => ({ author: c.user.login, body: c.body, path: c.path, line: c.line ?? c.original_line ?? undefined, images: html(c) })),
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

  async branchState(repo: RepoRef, branch: string): Promise<BranchState> {
    const kit = await this.kit(repo);
    const { data } = await kit.request('GET /repos/{owner}/{repo}/compare/{basehead}', { ...split(repo), basehead: `${repo.defaultBranch}...${branch}`, per_page: 100 });
    return { ahead: data.ahead_by, behind: data.behind_by, subjects: data.commits.map((c) => c.commit.message.split('\n')[0]) };
  }

  async mergeDefaultInto(repo: RepoRef, branch: string) {
    const kit = await this.kit(repo);
    try {
      await kit.request('POST /repos/{owner}/{repo}/merges', { ...split(repo), base: branch, head: repo.defaultBranch });
      return 'merged' as const;
    } catch (err) {
      if (status(err) === 409) return 'conflict' as const;
      throw err;
    }
  }

  async pushToDefault(repo: RepoRef, branch: string, message: string) {
    const kit = await this.kit(repo);
    const tip = async (name: string) => (await kit.request('GET /repos/{owner}/{repo}/git/ref/{ref}', { ...split(repo), ref: `heads/${name}` })).data.object.sha;
    const [base, head] = [await tip(repo.defaultBranch), await tip(branch)];
    // The commit takes the branch's files as they are, so the branch must already hold everything on the default branch.
    const { data: gap } = await kit.request('GET /repos/{owner}/{repo}/compare/{basehead}', { ...split(repo), basehead: `${base}...${head}`, per_page: 1 });
    if (gap.behind_by > 0) return { ok: false as const, message: `${repo.defaultBranch} has commits ${branch} doesn't.` };
    const { data: commit } = await kit.request('GET /repos/{owner}/{repo}/git/commits/{commit_sha}', { ...split(repo), commit_sha: head });
    const { data: made } = await kit.request('POST /repos/{owner}/{repo}/git/commits', { ...split(repo), message, tree: commit.tree.sha, parents: [base] });
    try {
      // Not forced: if the default branch moved meanwhile this is refused, and the next try starts over.
      await kit.request('PATCH /repos/{owner}/{repo}/git/refs/{ref}', { ...split(repo), ref: `heads/${repo.defaultBranch}`, sha: made.sha, force: false });
    } catch (err) {
      if ([403, 409, 422].includes(status(err) ?? 0)) return { ok: false as const, message: (err as Error).message };
      throw err;
    }
    return { ok: true as const, sha: made.sha, url: made.html_url };
  }

  async mergeRules(repo: RepoRef): Promise<MergeRules> {
    const kit = await this.kit(repo);
    const branch = repo.defaultBranch;
    const result: MergeRules = { reviewRequired: false, checksRequired: false, unknown: [] };
    // Rulesets: every active rule on the branch, whether or not Workshop can bypass it.
    const rules = (await kit.paginate('GET /repos/{owner}/{repo}/rules/branches/{branch}', { ...split(repo), branch, per_page: 100 })) as {
      type: string;
      ruleset_id?: number;
      parameters?: { required_status_checks?: unknown[]; required_approving_review_count?: number };
    }[];
    const bypass = new Map<number, { name: string; canBypass: string | undefined }>();
    for (const rule of rules) {
      if (rule.type === 'required_status_checks' && rule.parameters?.required_status_checks?.length) result.checksRequired = true;
      if (rule.type !== 'pull_request' || !((rule.parameters?.required_approving_review_count ?? 0) >= 1)) continue;
      const id = rule.ruleset_id;
      if (id !== undefined && !bypass.has(id)) {
        const set = await kit
          .request('GET /repos/{owner}/{repo}/rulesets/{ruleset_id}', { ...split(repo), ruleset_id: id, includes_parents: true })
          .then(({ data }) => ({ name: data.name, canBypass: (data as { current_user_can_bypass?: string }).current_user_can_bypass }))
          .catch(() => ({ name: `#${id}`, canBypass: undefined }));
        bypass.set(id, set);
      }
      const set = id === undefined ? undefined : bypass.get(id);
      // Workshop only merges pull requests, so a bypass for pull requests is enough.
      if (set?.canBypass === 'always' || set?.canBypass === 'pull_requests_only') continue;
      if (set?.canBypass === 'never') result.reviewRequired = true;
      else {
        const what = `whether it can bypass the "${set?.name ?? 'unnamed'}" ruleset on ${branch}`;
        if (!result.unknown.includes(what)) result.unknown.push(what);
      }
    }
    // Classic branch protection.
    const { data } = await kit.request('GET /repos/{owner}/{repo}/branches/{branch}', { ...split(repo), branch });
    const checks = data.protection?.required_status_checks;
    if (checks?.contexts?.length || checks?.checks?.length) result.checksRequired = true;
    if (data.protection?.enabled ?? data.protected) {
      try {
        const { data: reviews } = await kit.request('GET /repos/{owner}/{repo}/branches/{branch}/protection/required_pull_request_reviews', { ...split(repo), branch });
        if ((reviews.required_approving_review_count ?? 0) >= 1) result.reviewRequired = true;
      } catch (err) {
        // Normally a 403: reading these needs the administration permission, which the App doesn't ask for.
        if (status(err) !== 404) {
          result.unknown.push(`the review settings of ${branch}'s branch protection (reading them needs the administration permission, which the Workshop App doesn't request)`);
        }
      }
    }
    return result;
  }
}

// Spread in, so the typed route parameters don't reject it. format 'full' asks for body_html as well: its signed image links work on private repositories.
const FULL = { mediaType: { format: 'full' } };

const decodeAttr = (v: string) => v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** The GitHub-hosted images in rendered HTML. Anything from another host is dropped, so a commenter can't choose what Workshop fetches. */
export function imageRefs(html: string): ImageRef[] {
  const refs = new Map<string, ImageRef>();
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    const attr = (name: string) => {
      const m = new RegExp(`(?:^|\\s)${name}=(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
      const v = m?.[1] ?? m?.[2];
      return v === undefined ? undefined : decodeAttr(v);
    };
    const src = attr('src');
    const canonical = attr('data-canonical-src');
    const url = [src, canonical].find((u) => u && isGitHubImageUrl(u));
    if (!url) continue;
    const key = imageKey(canonical ?? src ?? url);
    if (!refs.has(key)) refs.set(key, { url, key });
  }
  return [...refs.values()];
}
