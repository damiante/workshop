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
  /** The subscription's 5-hour and weekly usage, reported with the first API response of every run. */
  usage?: { fiveHour: UsageWindow | null; sevenDay: UsageWindow | null };
  /** Set when Claude warned about or hit a usage limit, or started billing paid overage. */
  limit?: { status: string; resetsAt: number | null };
  /** Latest API error category, e.g. 'rate_limit' or 'authentication_failed' (from retries or the final error). */
  apiError?: string;
  /** Short description of the latest thing the agent did, for dashboards. */
  activity?: string;
}

type Block = { type: string; text?: string; name?: string; input?: Record<string, unknown> };

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
  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') run.sessionId = event.session_id;
      if (event.subtype === 'api_retry') run.apiError = event.error;
      break;
    case 'assistant':
      // A request that failed outright (e.g. "Not logged in") arrives as an assistant message with `error`.
      if (event.error) run.apiError = event.error;
      for (const block of (event.message?.content ?? []) as Block[]) run.activity = describeBlock(block)?.slice(0, 200) ?? run.activity;
      break;
    case 'rate_limit_event': {
      const info = event.rate_limit_info ?? {};
      const windows = info.unifiedWindows;
      if (windows) run.usage = { fiveHour: toWindow(windows.five_hour), sevenDay: toWindow(windows.seven_day) };
      if (info.status === 'allowed_warning' || info.status === 'rejected') run.limit = { status: info.status, resetsAt: toMs(info.resetsAt) };
      // Past the plan's limits with extra usage enabled: still allowed, but now costs money.
      if (info.isUsingOverage) run.limit = { status: 'overage', resetsAt: toMs(info.resetsAt) };
      break;
    }
    case 'result': {
      const usage = event.usage ?? {};
      run.sessionId = event.session_id ?? run.sessionId;
      run.result = {
        subtype: event.subtype,
        isError: Boolean(event.is_error),
        structured: event.structured_output,
        text: event.result,
        errors: event.errors ?? [],
        costUsd: event.total_cost_usd,
        inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
        outputTokens: usage.output_tokens,
      };
      break;
    }
  }
  return run;
}

/** True when the run stopped because the subscription (or API rate) limit was hit, so it should pause, not fail. */
export function hitUsageLimit(run: ClaudeRun): boolean {
  if (run.limit?.status === 'rejected') return true;
  if (!run.result?.isError) return false;
  return run.apiError === 'rate_limit' || run.result.errors.some((e) => /usage limit|rate limit|limit reached/i.test(e));
}
