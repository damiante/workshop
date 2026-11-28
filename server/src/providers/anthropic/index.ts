import Anthropic from '@anthropic-ai/sdk';
import type { Billing, ProviderInfo, UsageWindow } from '../../api-types.ts';
import type { ModelInfo, ModelProvider } from '../types.ts';

export interface AnthropicConfig {
  /** Comma-separated extra model IDs. */
  customModels?: string;
}

export interface AnthropicSecret {
  oauthToken?: string;
  apiKey?: string;
}

export const KNOWN_MODELS: ModelInfo[] = [
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2' },
];

export const anthropicInfo: ProviderInfo = {
  id: 'anthropic',
  kind: 'model',
  name: 'Claude',
  description: 'Runs agents with Claude Code, billed to your Claude subscription, an API key, or either per agent.',
  fields: [
    {
      key: 'oauthToken',
      label: 'Subscription token',
      type: 'password',
      secret: true,
      help: 'Run "claude setup-token" on any computer with a browser, sign in, and paste the token it prints (sk-ant-oat01-…). It lasts about a year.',
    },
    {
      key: 'apiKey',
      label: 'API key',
      type: 'password',
      secret: true,
      help: 'From platform.claude.com → API keys. Billed per token; Workshop caps spend per run and per day (Settings).',
    },
    { key: 'customModels', label: 'Extra model IDs', type: 'text', placeholder: 'claude-sonnet-5', help: 'Optional, comma-separated. Added to the model list.' },
  ],
};

export class AnthropicProvider implements ModelProvider {
  private cfg: AnthropicConfig;
  private secret: AnthropicSecret;

  constructor(cfg: AnthropicConfig, secret: AnthropicSecret) {
    this.cfg = cfg;
    this.secret = secret;
  }

  models(): ModelInfo[] {
    const extra = (this.cfg.customModels ?? '').split(',').map((id) => id.trim()).filter(Boolean);
    return [...KNOWN_MODELS, ...extra.filter((id) => !KNOWN_MODELS.some((m) => m.id === id)).map((id) => ({ id, label: id }))];
  }

  billing(): Billing[] {
    const modes: Billing[] = [];
    if (this.secret.oauthToken) modes.push('subscription');
    if (this.secret.apiKey) modes.push('api');
    return modes;
  }

  launchEnv(billing: Billing): Record<string, string> {
    // Exactly one credential: with both set, Claude Code would bill the API key.
    if (billing === 'api') {
      if (!this.secret.apiKey) throw new Error('This Claude connection has no API key.');
      return { ANTHROPIC_API_KEY: this.secret.apiKey };
    }
    if (!this.secret.oauthToken) throw new Error('This Claude connection has no subscription token.');
    return { CLAUDE_CODE_OAUTH_TOKEN: this.secret.oauthToken };
  }

  /** Confirms the API key works; returns how many models it can use. */
  async checkApiKey(): Promise<number> {
    const client = new Anthropic({ apiKey: this.secret.apiKey });
    let count = 0;
    for await (const _model of client.models.list()) count++;
    return count;
  }
}

const toMs = (t: number | undefined) => (t === undefined ? null : t < 1e12 ? t * 1000 : t);

/** Claude Code reports utilization as a fraction (0.45 = 45%) and reset times in epoch seconds. */
function toWindow(w: { utilization?: number; resetsAt?: number } | undefined): UsageWindow | null {
  return w && typeof w.utilization === 'number' ? { pct: Math.round(w.utilization * 1000) / 10, resetsAt: toMs(w.resetsAt) } : null;
}

/** What Workshop learns from a Claude Code stream-json run. */
export interface ClaudeRun {
  sessionId?: string;
  result?: {
    subtype: string;
    isError: boolean;
    structured?: unknown;
    text?: string;
    errors: string[];
    costUsd?: number;
    inputTokens?: number;
    outputTokens?: number;
  };
  /**
   * Tokens used so far, added up from each API response as it arrives, for a session that ends without a result
   * (killed at a limit, paused between turns, out of memory). Input is exact. Output is an estimate from what the
   * agent wrote, because a response's own output count isn't final when it is printed.
   */
  spent?: { inputTokens: number; outputTokens: number; responses: number };
  /** Ids of the API responses already counted in `spent`: one response is printed once per content block. */
  counted?: Set<string>;
  /** The subscription's 5-hour and weekly usage, reported with every API response. */
  usage?: { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null };
  /** Set when Claude hit a usage limit or started billing paid overage. */
  limit?: { status: string; resetsAt: number | null };
  /** Latest API error category, e.g. 'rate_limit' or 'authentication_failed' (from retries or the final error). */
  apiError?: string;
  /** Short description of the latest thing the agent did, for dashboards. */
  activity?: string;
  /** Ids of the agent's own tool calls (not a subagent's) that haven't returned a result yet. */
  openTools?: string[];
  /**
   * True right after a line that ended a turn: every tool call has returned and its result is in the session,
   * so stopping the agent here loses nothing. False after any other line.
   */
  boundary?: boolean;
  /** Ids of the background tasks (commands, subagents) the latest `background_tasks_changed` listed as still running. */
  backgroundTasks?: string[];
}

type Block = { type: string; id?: string; tool_use_id?: string; text?: string; name?: string; input?: Record<string, unknown> };

/**
 * Characters of visible output per output token, measured over finished runs. It is this low because thinking is
 * billed as output but printed empty; treat the result as a rough figure.
 */
const CHARS_PER_OUTPUT_TOKEN = 1.1;

const inputOf = (u: Record<string, number | undefined>) => (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);

/** Adds one printed assistant message to the running count: its response's input once, and what it wrote. */
function countResponse(run: ClaudeRun, message: { id?: string; usage?: Record<string, number | undefined> }, content: Block[]) {
  if (!message.usage) return;
  const spent = (run.spent ??= { inputTokens: 0, outputTokens: 0, responses: 0 });
  const counted = (run.counted ??= new Set());
  if (message.id && !counted.has(message.id)) {
    counted.add(message.id);
    spent.inputTokens += inputOf(message.usage);
    spent.responses++;
  }
  let chars = 0;
  for (const block of content) {
    if (block.type === 'text') chars += block.text?.length ?? 0;
    else if (block.type === 'tool_use') chars += (block.name?.length ?? 0) + JSON.stringify(block.input ?? {}).length;
  }
  spent.outputTokens += Math.round(chars / CHARS_PER_OUTPUT_TOKEN);
}

/** Every model's tokens in a result's `modelUsage`, which also covers requests the session made on the side. */
function modelTotals(modelUsage: unknown): { inputTokens: number; outputTokens: number } | null {
  if (!modelUsage || typeof modelUsage !== 'object') return null;
  const models = Object.values(modelUsage as Record<string, Record<string, number | undefined>>);
  if (!models.length) return null;
  return {
    inputTokens: models.reduce((n, m) => n + (m.inputTokens ?? 0) + (m.cacheCreationInputTokens ?? 0) + (m.cacheReadInputTokens ?? 0), 0),
    outputTokens: models.reduce((n, m) => n + (m.outputTokens ?? 0), 0),
  };
}

function describeBlock(block: Block): string | undefined {
  if (block.type === 'text' && block.text?.trim()) return block.text.trim().split('\n')[0];
  if (block.type === 'tool_use') {
    const input = block.input ?? {};
    const detail = input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.url ?? '';
    return `${block.name}${detail ? `: ${String(detail).split('\n')[0]}` : ''}`;
  }
  return undefined;
}

/** Folds one stdout line from `claude -p --output-format stream-json` into the run summary. */
export function readClaudeLine(run: ClaudeRun, line: string): ClaudeRun {
  let event: Record<string, any>;
  try {
    event = JSON.parse(line);
  } catch {
    return run;
  }
  run.boundary = false;
  // Subagent traffic carries the id of the Task call it belongs to; only the agent's own turns count.
  const topLevel = !event.parent_tool_use_id;
  const content: Block[] = Array.isArray(event.message?.content) ? event.message.content : [];
  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') run.sessionId = event.session_id;
      if (event.subtype === 'api_retry') run.apiError = event.error;
      if (event.subtype === 'background_tasks_changed' && Array.isArray(event.tasks)) run.backgroundTasks = event.tasks.map((t: { task_id?: string }) => String(t?.task_id));
      break;
    case 'assistant':
      // A request that failed outright (e.g. "Not logged in") arrives as an assistant message with `error`.
      if (event.error) run.apiError = event.error;
      // Subagents' responses too: they are usage like any other.
      if (event.message) countResponse(run, event.message, content);
      for (const block of content) {
        run.activity = describeBlock(block)?.slice(0, 200) ?? run.activity;
        if (topLevel && block.type === 'tool_use' && block.id) run.openTools = [...(run.openTools ?? []), block.id];
      }
      break;
    case 'user':
      if (!topLevel) break;
      for (const block of content) if (block.type === 'tool_result') run.openTools = (run.openTools ?? []).filter((id) => id !== block.tool_use_id);
      run.boundary = !run.openTools?.length;
      break;
    case 'rate_limit_event': {
      const info = event.rate_limit_info ?? {};
      const windows = info.unifiedWindows;
      if (windows) run.usage = { fiveHour: toWindow(windows.five_hour), sevenDay: toWindow(windows.seven_day) };
      // 'allowed_warning' is ignored: its utilization is already in unifiedWindows, which Workshop's own thresholds judge.
      if (info.status === 'rejected') run.limit = { status: info.status, resetsAt: toMs(info.resetsAt) };
      // Past the plan's limits with extra usage enabled: still allowed, but now costs money.
      if (info.isUsingOverage) run.limit = { status: 'overage', resetsAt: toMs(info.resetsAt) };
      break;
    }
    case 'result': {
      const usage = event.usage ?? {};
      run.sessionId = event.session_id ?? run.sessionId;
      // A session can go on after the agent reports (a background task finishing, a ScheduleWakeup firing),
      // and those turns needn't return a result. The latest one reported stands.
      const reported = run.result?.structured;
      // `usage` counts the agent's own turns; `modelUsage` adds what the session spent besides (subagents,
      // compaction), and is what `total_cost_usd` is the price of.
      const totals = modelTotals(event.modelUsage);
      run.result = {
        subtype: event.subtype,
        isError: Boolean(event.is_error) && reported === undefined,
        structured: event.structured_output ?? reported,
        text: event.result,
        errors: event.errors ?? [],
        costUsd: event.total_cost_usd,
        inputTokens: totals?.inputTokens ?? inputOf(usage),
        outputTokens: totals?.outputTokens ?? usage.output_tokens,
      };
      break;
    }
  }
  return run;
}

/** True when the run stopped because the subscription (or API rate) limit was hit, so it should pause, not fail. */
export function hitUsageLimit(run: ClaudeRun): boolean {
  if (run.result?.structured !== undefined) return false; // already reported: nothing left to resume
  if (run.limit?.status === 'rejected') return true;
  if (!run.result?.isError) return false;
  return run.apiError === 'rate_limit' || run.result.errors.some((e) => /usage limit|rate limit|limit reached/i.test(e));
}
