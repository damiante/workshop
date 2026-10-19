import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentName, Billing, LogEntry, RunStatus, RunView } from './api-types.ts';
import { config } from './config.ts';
import { all, one } from './db.ts';

export interface RunRow {
  id: string;
  ticket_id: number;
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
  started_at: number;
  ended_at: number | null;
}

export const ACTIVE_STATUSES: RunStatus[] = ['starting', 'running', 'publishing', 'paused'];
export const RUNNING_SQL = "status IN ('starting', 'running', 'publishing')";

export const getRun = (id: string) => one<RunRow>('SELECT * FROM runs WHERE id = ?', id);

const VIEW_SQL = `
  SELECT runs.*, (SELECT COUNT(*) FROM media m WHERE m.run_id = runs.id) AS media_count, t.number, t.title, t.url AS ticket_url, r.full_name, c.name AS env_name
  FROM runs
  JOIN tickets t ON t.id = runs.ticket_id
  JOIN repos r ON r.id = t.repo_id
  LEFT JOIN connections c ON c.id = runs.environment_id`;

type ViewRow = RunRow & { media_count: number; number: number; title: string; ticket_url: string; full_name: string; env_name: string | null };

/** Latest activity of running agents; in memory only, as it changes every few seconds. */
export const activity = new Map<string, string>();

function toView(r: ViewRow): RunView {
  return {
    id: r.id,
    ticketId: r.ticket_id,
    ticket: `${r.full_name}#${r.number}`,
    ticketTitle: r.title,
    ticketUrl: r.ticket_url,
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
    mediaCount: r.media_count,
  };
}

export function runViews(where = '1 = 1', ...params: (string | number)[]): RunView[] {
  return all<ViewRow>(`${VIEW_SQL} WHERE ${where} ORDER BY runs.started_at DESC LIMIT 200`, ...params).map(toView);
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

export function appendLog(runId: string, entry: LogEntry) {
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
