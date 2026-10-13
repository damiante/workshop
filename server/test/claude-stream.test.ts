import { describe, expect, it } from 'vitest';
import { hitUsageLimit, readClaudeLine, type ClaudeRun } from '../src/providers/anthropic/index.ts';

// Shapes copied from real `claude -p --output-format stream-json --verbose --json-schema …` output (Claude Code 2.1.289).
const RATE_ALLOWED = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed',
    resetsAt: 1791897000,
    rateLimitType: 'five_hour',
    overageStatus: 'rejected',
    isUsingOverage: false,
    unifiedWindows: { five_hour: { utilization: 0.44, resetsAt: 1791897000 }, seven_day: { utilization: 0.07, resetsAt: 1792087200 } },
  },
};
const SUCCESS = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  session_id: 's1',
  total_cost_usd: 0.31,
  usage: { input_tokens: 6, cache_creation_input_tokens: 35984, cache_read_input_tokens: 35447, output_tokens: 597 },
  structured_output: { decision: 'accept', size: 'xs', reason: 'fixture test' },
  result: '{"decision":"accept","size":"xs","reason":"fixture test"}',
};

const read = (...events: unknown[]) => events.reduce<ClaudeRun>((run, e) => readClaudeLine(run, typeof e === 'string' ? e : JSON.stringify(e)), {});

describe('readClaudeLine', () => {
  it('collects session, usage windows, activity and the result', () => {
    const run = read(
      { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-haiku-5-5' },
      RATE_ALLOWED,
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test\n# second line' } }] } },
      'not json',
      SUCCESS,
    );
    expect(run.sessionId).toBe('s1');
    expect(run.usage).toEqual({ fiveHour: { pct: 44, resetsAt: 1791897000_000 }, sevenDay: { pct: 7, resetsAt: 1792087200_000 } });
    expect(run.activity).toBe('Bash: npm test');
    expect(run.result).toMatchObject({ subtype: 'success', isError: false, inputTokens: 71437, outputTokens: 597, costUsd: 0.31 });
    expect(run.result?.structured).toEqual({ decision: 'accept', size: 'xs', reason: 'fixture test' });
    expect(run.limit).toBeUndefined();
    expect(hitUsageLimit(run)).toBe(false);
  });

  it('pauses on a rejected limit or a rate-limited failure, not on a warning', () => {
    const warn = read({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1791897000 } }, SUCCESS);
    expect(warn.limit).toEqual({ status: 'allowed_warning', resetsAt: 1791897000_000 });
    expect(hitUsageLimit(warn)).toBe(false);

    expect(hitUsageLimit(read({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1791897000 } }))).toBe(true);
    const failed = read(
      { type: 'system', subtype: 'api_retry', error: 'rate_limit' },
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['API Error: 429'] },
    );
    expect(hitUsageLimit(failed)).toBe(true);
  });

  it('recognises a credential failure (real shape from a container with no token)', () => {
    const run = read(
      { type: 'assistant', error: 'authentication_failed', is_api_error_message: true, message: { content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } },
      { type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', result: 'Not logged in · Please run /login' },
    );
    expect(run.apiError).toBe('authentication_failed');
    expect(run.result).toMatchObject({ isError: true, text: 'Not logged in · Please run /login' });
    expect(hitUsageLimit(run)).toBe(false);
  });

  it('flags paid overage so new launches stop', () => {
    const run = read({ ...RATE_ALLOWED, rate_limit_info: { ...RATE_ALLOWED.rate_limit_info, isUsingOverage: true } });
    expect(run.limit?.status).toBe('overage');
  });
});
