import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentName, Billing, LogEntry, PauseReason, RunStatus, RunView, TaskResult } from './api-types.ts';
import { config } from './config.ts';
import { all, one } from './db.ts';

export interface RunRow {
  id: string;
  /** Null for a task run. */
  ticket_id: number | null;
  /** Null for a ticket run. Exactly one of ticket_id and task_id is set. */
  task_id: number | null;
  repo_id: number;
  /** A task run's instructions; null for ticket runs. */
  prompt: string | null;
  /** A task run that asked for the browser image (0 or 1). */
  browser: number;
  agent: AgentName;
  mode: 'normal' | 'delta';
  attempt: number;
  environment_id: number | null;
  model_connection_id: number | null;
  model: string;
  billing: Billing;
  status: RunStatus;
  step: 'prepare' | 'run' | 'publish' | null;
  container_id: string | null;
  volume: string | null;
  resumes: number;
  exit_code: number | null;
  result: string | null;
  summary: string | null;
  error: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  resets_at: number | null;
  /** Why a paused run waits: a usage limit Claude reported, its subscription's limits, you ('manual'), or a move off a paused subscription ('connection'). Null on older rows means 'limit'. */
  pause_reason: PauseReason | null;
  /** While starting or running: when you asked it to pause at the next turn boundary. */
  pause_requested_at: number | null;
  started_at: number;
  ended_at: number | null;
  image: string | null;
  /** The Claude connection this run just moved off, until the moved session reaches its first turn boundary. */
  switched_from: number | null;
  /** The turn limit and time limit (minutes) the latest agent session started with; null on older rows. */
  max_turns: number | null;
  timeout_min: number | null;
  /** When the current step's container started. */
  step_started_at: number | null;
  /** JSON: the publish step's frozen plan, push report and finished steps, so a retry repeats nothing. */
  publish_state: string | null;
  /** How many times publishing was put off because GitHub failed. */
  publish_retries: number;
  /** While publishing waits for GitHub: when the tick may try again. */
  publish_retry_at: number | null;
  /** When publishing started failing on temporary GitHub errors, for the give-up. */
  publish_failing_since: number | null;
}

export const ACTIVE_STATUSES: RunStatus[] = ['starting', 'running', 'publishing', 'paused'];
export const RUNNING_SQL = "status IN ('starting', 'running', 'publishing')";

export const getRun = (id: string) => one<RunRow>('SELECT * FROM runs WHERE id = ?', id);

export const VIEW_SQL = `
  SELECT runs.*, (SELECT COUNT(*) FROM media m WHERE m.run_id = runs.id) AS media_count, t.number, t.title, t.url AS ticket_url, k.title AS task_title, r.full_name, c.name AS env_name
  FROM runs
  LEFT JOIN tickets t ON t.id = runs.ticket_id
  LEFT JOIN tasks k ON k.id = runs.task_id
  JOIN repos r ON r.id = runs.repo_id
  LEFT JOIN connections c ON c.id = runs.environment_id`;

export type ViewRow = RunRow & {
  media_count: number;
  number: number | null;
  title: string | null;
  ticket_url: string | null;
  task_title: string | null;
  full_name: string;
  env_name: string | null;
};

/** A task run's stored result, with the optional lists filled in. Null for ticket runs and runs without one. */
export function taskResultOf(r: Pick<RunRow, 'task_id' | 'result'>): TaskResult | null {
  if (r.task_id === null || !r.result) return null;
  try {
    const v = JSON.parse(r.result) as Partial<TaskResult> & { tests?: string };
    return { outcome: v.outcome ?? 'done', summary: v.summary ?? '', questions: v.questions ?? [], tests: v.tests ?? null, findings: v.findings ?? [] };
  } catch {
    return null;
  }
}

/** Latest activity of running agents; in memory only, as it changes every few seconds. */
export const activity = new Map<string, string>();

export function toView(r: ViewRow): RunView {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    ticket: r.ticket_id === null ? null : `${r.full_name}#${r.number}`,
    ticketTitle: r.ticket_id === null ? null : r.title,
    ticketUrl: r.ticket_id === null ? null : r.ticket_url,
    repo: r.full_name,
    environmentId: r.environment_id,
    task: r.task_id === null ? null : { id: r.task_id, title: r.task_title ?? '' },
    prompt: r.task_id === null ? null : r.prompt,
    result: taskResultOf(r),
    agent: r.agent,
    mode: r.mode,
    attempt: r.attempt,
    environment: r.env_name,
    model: r.model,
    billing: r.billing,
    status: r.status,
    step: r.step,
    summary: r.summary,
    activity: activity.get(r.id) ?? null,
    error: r.error,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: r.cost_usd,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    resetsAt: r.resets_at,
    pauseReason: r.pause_reason,
    pauseRequested: (r.status === 'starting' || r.status === 'running') && r.pause_requested_at != null,
    mediaCount: r.media_count,
    maxTurns: r.max_turns,
    timeoutMin: r.timeout_min,
    stepStartedAt: r.step_started_at,
  };
}

export function runViews(where = '1 = 1', ...params: (string | number)[]): RunView[] {
  return all<ViewRow>(`${VIEW_SQL} WHERE ${where} ORDER BY runs.started_at DESC LIMIT 200`, ...params).map(toView);
}

export function ticketRunViews(ticketId: number): RunView[] {
  return all<ViewRow>(`${VIEW_SQL} WHERE runs.ticket_id = ? ORDER BY runs.started_at ASC, runs.rowid ASC`, ticketId).map(toView);
}

export function runView(id: string): RunView | undefined {
  const row = one<ViewRow>(`${VIEW_SQL} WHERE runs.id = ?`, id);
  return row ? toView(row) : undefined;
}

// Run logs: one JSON object per line in DATA_DIR/runs/<id>.jsonl.

export const logBus = new EventEmitter();
logBus.setMaxListeners(0);

const MAX_LINE = 64_000;
const counts = new Map<string, number>();

export const logPath = (runId: string) => path.join(config.dataDir, 'runs', `${runId}.jsonl`);

export function readLog(runId: string): LogEntry[] {
  try {
    return fs.readFileSync(logPath(runId), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Drops base64 payloads (images Claude Code read) from an over-long stream-json line, so it stays parseable. */
function withoutBase64(text: string): string {
  let event: unknown;
  try {
    event = JSON.parse(text);
  } catch {
    return text;
  }
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (!v || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    if (o.type === 'base64' && typeof o.data === 'string') return { ...o, data: '' };
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, k === 'base64' && typeof x === 'string' ? '' : strip(x)]));
  };
  return JSON.stringify(strip(event));
}

export function appendLog(runId: string, entry: LogEntry) {
  if (entry.text.length > MAX_LINE) entry = { ...entry, text: withoutBase64(entry.text) };
  if (entry.text.length > MAX_LINE) entry = { ...entry, text: entry.text.slice(0, MAX_LINE) + ' …[truncated by Workshop]' };
  if (!counts.has(runId)) counts.set(runId, readLog(runId).length);
  const index = counts.get(runId)!;
  counts.set(runId, index + 1);
  fs.mkdirSync(path.dirname(logPath(runId)), { recursive: true });
  fs.appendFileSync(logPath(runId), JSON.stringify(entry) + '\n');
  logBus.emit(runId, index, entry);
}

/** Lines already logged from one container: where a re-attached log follower resumes. */
export const linesFrom = (runId: string, container: string) => readLog(runId).filter((e) => e.container === container).length;

export function deleteLog(runId: string) {
  counts.delete(runId);
  fs.rmSync(logPath(runId), { force: true });
}
