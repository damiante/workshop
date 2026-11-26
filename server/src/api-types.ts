// Types shared with the client (imported type-only). Keep this file free of runtime imports.

export type Topic = 'runs' | 'tickets' | 'alerts' | 'connections' | 'settings' | 'allowance' | 'repos' | 'agents' | 'tokens' | 'media' | 'tasks';

export type Mode = 'paused' | 'scheduled' | 'always';

export type TicketOrder = 'updated-asc' | 'updated-desc' | 'created-asc' | 'created-desc';

export interface Settings {
  mode: Mode;
  timezone: string;
  /** 0 = Sunday … 6 = Saturday */
  days: number[];
  /** 'HH:MM'. start === end means all day; start > end spans midnight. */
  start: string;
  end: string;
  apiRunCapUsd: number;
  apiDailyCapUsd: number;
  pollMinutes: number;
  /** GitHub logins whose tickets Workshop acts on. */
  authors: string[];
  /** Order of tickets within the same push, prioritisation, repo priority and step. */
  ticketOrder: TicketOrder;
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
  /** AI model connections only: subscription agents don't use it and move off it, but API-billed agents still use its key. Its settings are kept. */
  paused: boolean;
}

export interface TestResult {
  ok: boolean;
  message: string;
}

/** Which of a repository's tickets Workshop works on: all open ones, or only those labelled workshop/nominated. */
export type RepoSelection = 'all' | 'nominated';

export interface RepoView {
  id: number;
  connectionId: number;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  url: string;
  enabled: boolean;
  image: string | null;
  /** Higher goes first. Lower-priority repos wait until every open ticket here has been classified. */
  priority: number;
  selection: RepoSelection;
  /** Merge pull requests once they're mergeable, without waiting for your approval. */
  mergeWithoutReview: boolean;
  /** What the branch check couldn't confirm when the setting was turned on (null when all was well or it's off). */
  mergeWarning: string | null;
}

export type AgentName = 'classifier' | 'design' | 'design-review' | 'implement' | 'code-review' | 'merge' | 'task';
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
export type Stage = 'design' | 'design-review' | 'implement' | 'code-review' | 'pr-review' | 'merge' | 'reclassify' | 'reconcile';

/** Fields of a ticket's state to change by hand; fields left out stay as they are. */
export interface TicketStatePatch {
  stage?: Stage | null;
  size?: Size | null;
  needsInfo?: boolean;
  skip?: boolean;
  failed?: boolean;
}

/** How you've pushed a ticket by hand: one stage, or on until Workshop would wait for you. */
export type Push = 'stage' | 'lifecycle';

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
  /** Null when the repository works on its whole backlog, otherwise whether this ticket has the nominated label. */
  nominated: boolean | null;
  /** What Workshop will do next, in words, or null when it's waiting on you or finished. */
  next: string | null;
  branch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prStatus: string | null;
  activeRunId: string | null;
  /** Why the ticket is waiting on you, or null when it isn't. */
  attention: 'question' | 'failed' | 'review' | null;
  /** You dismissed it from Needs you; it comes back when the reason changes. */
  dismissed: boolean;
  /** Set while you've pushed this ticket by hand. */
  push: Push | null;
  /** You put this ticket ahead of the rest of the queue; it stays until you remove it or the ticket closes. */
  prioritised: boolean;
  /** How many images the ticket's media store holds. */
  mediaCount: number;
  updatedAt: string;
}

export type RunStatus = 'starting' | 'running' | 'publishing' | 'paused' | 'succeeded' | 'failed' | 'cancelled' | 'lost';

export interface RunView {
  id: string;
  /** The ticket fields are null for a task run (an agent you started on a task, outside the ticket workflow). */
  ticketId: number | null;
  /** owner/repo#12 */
  ticket: string | null;
  ticketTitle: string | null;
  ticketUrl: string | null;
  /** The repository's full name, owner/repo. */
  repo: string;
  /** The agent host's connection id. */
  environmentId: number | null;
  /** The task a task run belongs to; null for ticket runs. */
  task: TaskRef | null;
  /** A task run's instructions, as you wrote them; null for ticket runs and task runs without any. */
  prompt: string | null;
  /** A task run's reported outcome, once the agent returned one; null for ticket runs. */
  result: TaskResult | null;
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
  /** Why a paused run waits: 'limit' (Claude reported a usage limit), 'threshold' (usage is over your Settings limit) or 'manual' (you paused it; it waits for you to resume it) or 'connection' (its Claude subscription was paused, and it moves to another one). */
  pauseReason: PauseReason | null;
  /** You asked a starting or running agent to pause; it stops after its current step. */
  pauseRequested: boolean;
  /** How many images this run added to the ticket's media store. */
  mediaCount: number;
  /** The turn limit the agent's current or last session ran with; null for runs from before Workshop recorded it. */
  maxTurns: number | null;
  /** The time limit in minutes for each agent session (it restarts when a paused run resumes); null for older runs. */
  timeoutMin: number | null;
  /** When the current step's container started: the time limit counts from here. */
  stepStartedAt: number | null;
}

export interface TaskRef {
  id: number;
  title: string;
}

/** One problem the Code reviewer found. */
export interface Finding {
  severity: 'severe' | 'moderate' | 'minor';
  cause: 'design' | 'implementation';
  title: string;
  detail: string;
  /** How the reviewer checked it. */
  evidence: string;
  fix: string;
  file?: string;
  line?: number;
}

/** What an agent on a task reported when it finished. */
export interface TaskResult {
  outcome: 'done' | 'needs_info' | 'failed';
  /** The agent's report, in Markdown. When the task asked a question, it holds the answer. */
  summary: string;
  /** Questions for you (needs_info); answer them when you start the next agent. */
  questions: string[];
  tests: string | null;
  /** The Code reviewer's findings; empty for other agents. */
  findings: Finding[];
}

export interface TaskSummary {
  id: number;
  /** owner/repo */
  repo: string;
  title: string;
  closed: boolean;
  /** The branch every agent on the task shares, workshop/task-<id>-<title>. */
  branch: string;
  /** Set once Workshop pushed the branch with commits on it. */
  branchUrl: string | null;
  createdAt: number;
  updatedAt: number;
  /** How many agents have run on the task. */
  runs: number;
  /** The newest run, if any. */
  latest: RunView | null;
}

export interface TaskView extends Omit<TaskSummary, 'runs'> {
  /** The description, as you wrote it. */
  body: string;
  /** Every run on the task, oldest first. */
  runs: RunView[];
  /** The agents you can start on a task. */
  agents: AgentName[];
}

export interface TaskRepo {
  id: number;
  fullName: string;
}

export interface TasksView {
  /** Every repository Workshop can see, enabled ones first. */
  repos: TaskRepo[];
  /** The agents you can start on a task. */
  agents: AgentName[];
  /** Open tasks first, then by when they last changed, newest first. */
  tasks: TaskSummary[];
}

export type PauseReason = 'limit' | 'threshold' | 'manual' | 'connection';

export interface MediaItem {
  name: string;
  /** 'issue', 'comment', or the agent that added it. */
  source: string;
  runId: string | null;
  /** What the image shows; may contain line breaks. */
  caption: string | null;
  size: number;
  createdAt: number;
  /** Where to fetch the image, e.g. /api/tickets/3/media/issue-1.png */
  url: string;
}

export interface TicketLifecycle {
  ticket: TicketView;
  /** Every run on the ticket still kept, oldest first. */
  runs: RunView[];
  media: MediaItem[];
}

export interface TicketMedia {
  ticketId: number;
  ticket: string;
  title: string;
  items: MediaItem[];
}

export interface UsageWindow {
  pct: number;
  resetsAt: number | null;
}

/** Usage limits as percentages of a subscription's 5-hour and weekly windows. */
export interface Limits {
  fiveHour: number;
  weekly: number;
}

export interface AllowanceView {
  connectionId: number;
  connectionName: string;
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  sampledAt: number | null;
  /** Set when Claude itself reported a rate limit during a run. */
  blockedUntil: number | null;
  /** The account works but Claude doesn't report its 5-hour and weekly usage, so Workshop can't hold launches on its limits. */
  unknown: boolean;
  /** Tokens (input including cache, plus output) that runs on this connection used in the last 5 hours and 7 days. */
  tokens: { fiveHour: number; sevenDay: number };
  /** No new agents start on this subscription above these, and its running agents pause. */
  limits: Limits;
}

export interface HostView {
  id: number;
  name: string;
  status: ConnectionStatus;
  /** False when switched off for new agents; running agents carry on. */
  available: boolean;
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
  push: Push | null;
  prioritised: boolean;
}

export interface AlertView {
  id: number;
  level: 'error' | 'warning' | 'info';
  kind: string;
  message: string;
  ref: string | null;
  /** The run to open for more detail, when the alert is about a run or a ticket that has run. */
  runId: string | null;
  createdAt: number;
  ackAt: number | null;
}

export interface Overview {
  mode: Mode;
  withinHours: boolean;
  allowance: AllowanceView[];
  running: RunView[];
  needsYou: TicketView[];
  /** Needs-you items you dismissed. */
  dismissed: TicketView[];
  queue: QueueItem[];
  hosts: HostView[];
  alerts: AlertView[];
}

export interface Usage {
  allowance: AllowanceView[];
  apiSpendTodayUsd: number;
  apiRunCapUsd: number;
  apiDailyCapUsd: number;
}

export interface SpendTotals {
  runs: number;
  /** Includes cache reads and writes, as runs report it. */
  inputTokens: number;
  outputTokens: number;
  /** Claude Code's token-equivalent cost; for subscription runs it isn't billed. */
  costUsd: number;
}

export interface LifetimeSpend {
  /** Earliest recorded usage; null when nothing is recorded. */
  since: number | null;
  total: SpendTotals;
  subscription: SpendTotals;
  api: SpendTotals;
  byModel: (SpendTotals & { model: string })[];
  /** Repository `owner/name`; null for spend whose run was deleted before Workshop recorded it. Sorted by cost. */
  byProject: (SpendTotals & { project: string | null })[];
  /** The Claude connection and which of its credentials (`billing`: subscription token or API key) it was billed to; null for spend recorded before Workshop kept track. Sorted by cost. */
  byConnection: (SpendTotals & { connectionId: number | null; connection: string | null; billing: string })[];
  /** 'YYYY-MM' in the settings time zone, newest first. */
  byMonth: (SpendTotals & { month: string })[];
}

export type TokenScope = 'read' | 'write';

export interface ApiTokenView {
  id: number;
  name: string;
  scope: TokenScope;
  createdAt: number;
  lastUsedAt: number | null;
  /** When the token stops working; null if it never expires. */
  expiresAt: number | null;
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
