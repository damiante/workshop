// Every external tool sits behind one of these interfaces. Adding GitLab, Jira or another runtime
// means a new folder under providers/ implementing the relevant interface, plus its ProviderInfo.
import type { Billing } from '../api-types.ts';

export interface RepoRef {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  url: string;
}

export interface LabelDef {
  name: string;
  color: string;
  description: string;
}

export interface RemoteTicket {
  number: number;
  nodeId?: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  author: string;
  labels: string[];
  url: string;
  updatedAt: string;
  /** How many open tickets block this one. Undefined means the source didn't say. */
  openBlockers?: number;
}

/** Another ticket this one is linked to. `repo` is the full name. */
export interface TicketLink {
  repo: string;
  number: number;
  state: 'open' | 'closed';
  url: string;
}

export interface TicketComment {
  author: string;
  body: string;
  createdAt: string;
}

/** Project-management tool (GitHub Issues first). */
export interface TicketSource {
  /** The identity Workshop posts as, so its own comments stay in agent context. */
  selfLogin(): string;
  /** Tickets changed since `since` (ISO time), or all open tickets when `since` is null. */
  listChanged(repo: RepoRef, since: string | null): Promise<RemoteTicket[]>;
  comments(repo: RepoRef, number: number): Promise<TicketComment[]>;
  setLabels(repo: RepoRef, number: number, add: string[], remove: string[]): Promise<void>;
  comment(repo: RepoRef, number: number, body: string): Promise<void>;
  /** Defaults to completed. */
  close(repo: RepoRef, number: number, reason?: 'completed' | 'not_planned'): Promise<void>;
  ensureLabels(repo: RepoRef, labels: LabelDef[]): Promise<void>;
  /** The tickets this one is blocked by, open and closed. */
  blockers(repo: RepoRef, number: number): Promise<TicketLink[]>;
  /** Marks `blocker` (a ticket in the same repo) as blocking `number`. Idempotent. Returns the blocker. */
  addBlocker(repo: RepoRef, number: number, blocker: number): Promise<TicketLink>;
}

export interface GitAccess {
  /** Clone/push URL with a short-lived credential embedded. Never stored. */
  url: string;
  /** The same URL without credentials, kept as the clone's remote. */
  cleanUrl: string;
  name: string;
  email: string;
}

export type Mergeability = 'clean' | 'conflict' | 'behind' | 'blocked' | 'unknown';

export interface PullRequestState {
  number: number;
  url: string;
  state: 'open' | 'closed' | 'merged';
  headSha: string;
  mergeable: Mergeability;
  /** Latest review of the current head commit by an allowed reviewer. */
  decision: 'approved' | 'changes_requested' | null;
}

export interface ReviewFeedback {
  author: string;
  body: string;
  path?: string;
  line?: number;
}

/** Version-control host (GitHub first). */
export interface VcsHost {
  listRepos(): Promise<RepoRef[]>;
  createBranch(repo: RepoRef, branch: string, ticket: { number: number; nodeId?: string }): Promise<void>;
  gitAccess(repo: RepoRef, write: boolean): Promise<GitAccess>;
  fileUrl(repo: RepoRef, branch: string, path: string): string;
  findPullRequest(repo: RepoRef, branch: string): Promise<number | null>;
  openPullRequest(repo: RepoRef, p: { branch: string; title: string; body: string }): Promise<{ number: number; url: string }>;
  updatePullRequest(repo: RepoRef, number: number, body: string): Promise<void>;
  commentOnPullRequest(repo: RepoRef, number: number, body: string): Promise<void>;
  closePullRequest(repo: RepoRef, number: number): Promise<void>;
  /** Missing branches are ignored. */
  deleteBranch(repo: RepoRef, branch: string): Promise<void>;
  pullRequestState(repo: RepoRef, number: number, reviewers: string[]): Promise<PullRequestState>;
  reviewFeedback(repo: RepoRef, number: number, reviewers: string[]): Promise<ReviewFeedback[]>;
  requestReview(repo: RepoRef, number: number, login: string): Promise<void>;
  /** Merge the base branch into the PR branch server-side (no conflicts). */
  updateBranch(repo: RepoRef, number: number): Promise<void>;
  merge(repo: RepoRef, number: number): Promise<{ merged: boolean; message?: string }>;
}

export interface HostSpecs {
  name: string;
  cpus: number;
  memoryMb: number;
  os: string;
  arch: string;
  version: string;
}

export interface StepSpec {
  image: string;
  cmd: string[];
  env: Record<string, string>;
  /** Files written into the container before it starts (path → content). */
  files?: Record<string, string>;
  volume?: string;
  labels: Record<string, string>;
  cpus?: number;
  memoryMb?: number;
}

export interface LogLine {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface ContainerState {
  running: boolean;
  exitCode: number;
  oomKilled: boolean;
}

/** Somewhere agent containers run (Docker first). */
export interface Environment {
  ping(): Promise<void>;
  describe(): Promise<HostSpecs>;
  ensureImage(image: string): Promise<void>;
  createVolume(name: string, labels: Record<string, string>): Promise<void>;
  removeVolume(name: string): Promise<void>;
  /** Creates and starts a container; returns its id. */
  start(spec: StepSpec): Promise<string>;
  /** Streams the container's log lines, skipping the first `skip`, until the container stops. */
  follow(id: string, skip: number, onLine: (line: LogLine) => void): Promise<void>;
  wait(id: string): Promise<ContainerState>;
  inspect(id: string): Promise<ContainerState | null>;
  kill(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  list(labels: Record<string, string>): Promise<{ id: string; labels: Record<string, string>; running: boolean }[]>;
}

export interface ModelInfo {
  id: string;
  label: string;
}

/** An AI model provider and the agent runtime that uses it (Claude Code first). */
export interface ModelProvider {
  models(): ModelInfo[];
  billing(): Billing[];
  /** Environment for the agent container; credentials for exactly one billing mode. */
  launchEnv(billing: Billing): Record<string, string>;
}
