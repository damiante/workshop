import type { TicketTotals } from './api-types.ts';
import { all } from './db.ts';
import { parseLabels } from './workflow/labels.ts';

interface Row {
  id: number;
  repo: string;
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  labels: string;
  pr_number: number | null;
  pr_url: string | null;
  runs: number;
  failed: number;
  active: number;
  ms: number;
  cost: number | null;
  tokens: number | null;
  turns: number | null;
  first: number;
  last: number | null;
  files: number | null;
  additions: number | null;
  deletions: number | null;
}

/**
 * One line per ticket an agent has worked on: what all its runs added up to, and the branch's diff after the last
 * push. Newest work first. Runs older than the retention period are gone, so an old ticket's totals cover what's left.
 */
export function ticketTotals(now = Date.now()): TicketTotals[] {
  const rows = all<Row>(
    `SELECT t.id, r.full_name AS repo, t.number, t.title, t.url, t.state, t.labels, t.pr_number, t.pr_url,
            COUNT(*) AS runs,
            SUM(runs.status IN ('failed', 'lost')) AS failed,
            SUM(runs.status IN ('starting', 'running', 'publishing', 'paused')) AS active,
            SUM(COALESCE(runs.ended_at, ?) - runs.started_at) AS ms,
            SUM(runs.cost_usd) AS cost,
            SUM(COALESCE(runs.input_tokens, 0) + COALESCE(runs.output_tokens, 0)) AS tokens,
            SUM(s.turns) AS turns,
            MIN(runs.started_at) AS first,
            MAX(runs.ended_at) AS last,
            d.files, d.additions, d.deletions
     FROM tickets t
     JOIN repos r ON r.id = t.repo_id
     JOIN runs ON runs.ticket_id = t.id
     LEFT JOIN run_stats s ON s.run_id = runs.id
     LEFT JOIN run_stats d ON d.run_id = (
       SELECT x.id FROM runs x JOIN run_stats xs ON xs.run_id = x.id
       WHERE x.ticket_id = t.id AND xs.files IS NOT NULL ORDER BY x.started_at DESC LIMIT 1)
     GROUP BY t.id
     ORDER BY MAX(COALESCE(runs.ended_at, runs.started_at)) DESC
     LIMIT 500`,
    now,
  );
  return rows.map((x) => {
    const state = parseLabels(JSON.parse(x.labels));
    return {
      ticketId: x.id,
      ticket: `${x.repo}#${x.number}`,
      title: x.title,
      url: x.url,
      state: x.state,
      size: state.size,
      stage: state.stage,
      skipped: state.skip,
      failed: state.failed,
      prNumber: x.pr_number,
      prUrl: x.pr_url,
      runs: x.runs,
      failedRuns: x.failed,
      working: x.active > 0,
      agentMs: x.ms,
      costUsd: x.cost,
      tokens: x.tokens,
      turns: x.turns,
      firstStartedAt: x.first,
      lastEndedAt: x.last,
      diff: x.files === null ? null : { files: x.files, additions: x.additions ?? 0, deletions: x.deletions ?? 0 },
    };
  });
}
