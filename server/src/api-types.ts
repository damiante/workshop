// Types shared with the client (imported type-only). Keep this file free of runtime imports.

export type Topic = 'runs' | 'tickets' | 'alerts' | 'connections' | 'settings' | 'allowance' | 'repos' | 'agents' | 'tokens';

export type Mode = 'paused' | 'scheduled' | 'always';

export interface Settings {
  mode: Mode;
  timezone: string;
  /** 0 = Sunday … 6 = Saturday */
  days: number[];
  /** 'HH:MM'. start === end means all day; start > end spans midnight. */
  start: string;
  end: string;
  fiveHourMax: number;
  weeklyMax: number;
  apiRunCapUsd: number;
  apiDailyCapUsd: number;
  pollMinutes: number;
  /** GitHub logins whose tickets Workshop acts on. */
  authors: string[];
  retentionDays: number;
}

export type ConnectionKind = 'vcs' | 'tickets' | 'environment' | 'model';
export type ConnectionStatus = 'ok' | 'error' | 'unknown';

export interface FieldDef {
  key: string;
  label: string;
  type: 'text' | 'password' | 'textarea' | 'number' | 'select' | 'connection';
  /** Stored encrypted and never sent back to the browser. */
  secret?: boolean;
  required?: boolean;
  help?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  showIf?: { key: string; equals: string[] };
  /** For type 'connection': which provider's connections to offer. */
  connectionProvider?: string;
  defaultValue?: string | number;
}

export interface ProviderInfo {
  id: string;
  kind: ConnectionKind;
  name: string;
  description: string;
  fields: FieldDef[];
  /** Providers with a guided setup instead of (or as well as) a form. */
  setup?: 'github-app';
}

export interface ConnectionView {
  id: number;
  kind: ConnectionKind;
  provider: string;
  name: string;
  config: Record<string, unknown>;
  /** Secret field key → masked hint such as '…a1b2'. */
  secrets: Record<string, string>;
  status: ConnectionStatus;
  checkedAt: number | null;
  error: string | null;
}

export interface TestResult {
  ok: boolean;
  message: string;
}

export interface RepoView {
  id: number;
  connectionId: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  url: string;
  enabled: boolean;
  image: string | null;
}

export type AgentName = 'classifier' | 'design' | 'design-review' | 'implement' | 'merge';
export type Billing = 'subscription' | 'api';

export interface AgentClassView {
  name: AgentName;
  label: string;
  description: string;
  model: string | null;
  modelConnectionId: number | null;
  effort: string | null;
  billing: Billing;
  prompt: string;
  defaultPrompt: string;
  customised: boolean;
  /** Fixed instructions Workshop appends; shown read-only. */
  protocol: string;
  maxTurns: number;
  timeoutMin: number;
}

export interface ModelOption {
  connectionId: number;
  connectionName: string;
  id: string;
  label: string;
  billing: Billing[];
}

export type Size = 'xs' | 's' | 'm' | 'l' | 'xl';
export type Stage = 'design' | 'design-review' | 'implement' | 'pr-review' | 'merge' | 'reclassify';

export interface TicketView {
  id: number;
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  state: 'open' | 'closed';
  labels: string[];
  size: Size | null;
  stage: Stage | null;
  needsInfo: boolean;
  skipped: boolean;
  failed: boolean;
  /** What Workshop will do next, in words, or null when it's waiting on you or finished. */
  next: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prStatus: string | null;
  activeRunId: string | null;
  updatedAt: string;
}

export type RunStatus = 'starting' | 'running' | 'publishing' | 'paused' | 'succeeded' | 'failed' | 'cancelled' | 'lost';

export interface RunView {
  id: string;
  ticketId: number;
  ticket: string;
  ticketTitle: string;
  ticketUrl: string;
  agent: AgentName;
  mode: 'normal' | 'delta';
  attempt: number;
  environment: string | null;
  model: string;
  billing: Billing;
  status: RunStatus;
  step: string | null;
  summary: string | null;
  /** The latest thing a running agent did, e.g. "Bash: npm test". */
  activity: string | null;
  error: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null;
  startedAt: number;
  endedAt: number | null;
  resetsAt: number | null;
}

export interface UsageWindow {
  pct: number;
  resetsAt: number | null;
}

export interface AllowanceView {
  connectionId: number;
  connectionName: string;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  sampledAt: number | null;
  /** Set when Claude itself reported a rate limit during a run. */
  blockedUntil: number | null;
}

export interface HostView {
  id: number;
  name: string;
  status: ConnectionStatus;
  slots: number;
  busy: number;
  specs: string | null;
}

export interface QueueItem {
  ticketId: number;
  ticket: string;
  title: string;
  next: string;
  blockedBy: string | null;
}

export interface AlertView {
  id: number;
  level: 'error' | 'warning' | 'info';
  kind: string;
  message: string;
  ref: string | null;
  createdAt: number;
  ackAt: number | null;
}

export interface Overview {
  mode: Mode;
  withinHours: boolean;
  allowance: AllowanceView[];
  thresholds: { fiveHour: number; weekly: number };
  running: RunView[];
  needsYou: TicketView[];
  queue: QueueItem[];
  hosts: HostView[];
  alerts: AlertView[];
}

export interface Usage {
  allowance: AllowanceView[];
  thresholds: { fiveHour: number; weekly: number };
  apiSpendTodayUsd: number;
  apiRunCapUsd: number;
  apiDailyCapUsd: number;
}

export type TokenScope = 'read' | 'write';

export interface ApiTokenView {
  id: number;
  name: string;
  scope: TokenScope;
  createdAt: number;
  lastUsedAt: number | null;
}

/** Returned once, when a token is created. */
export interface NewApiToken {
  token: string;
  view: ApiTokenView;
}

export interface AuthState {
  authenticated: boolean;
  enrolled: boolean;
  version: string;
}

/** One line of a run's log (DATA_DIR/runs/<id>.jsonl). Lines from the `run` step's stdout are Claude Code stream-json. */
export interface LogEntry {
  step: 'prepare' | 'run' | 'publish' | 'workshop';
  stream: 'stdout' | 'stderr';
  text: string;
  /** Short container id, so a re-attached follower knows how many lines it already has. */
  container?: string;
}

export interface Installation {
  id: number;
  account: string;
  repositorySelection: string;
  approved: boolean;
}

export interface LoginResponse {
  ok?: boolean;
  /** First sign-in: scan this with an authenticator app, then sign in again with a code. */
  enroll?: { secret: string; uri: string };
}
