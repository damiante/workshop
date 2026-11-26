import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import { all, initDb, MIGRATIONS, one, run } from '../src/db.ts';
import { backfillSpend, lifetimeSpend } from '../src/spend.ts';

const spendOf = (id: string) => one<{ repo: string | null; agent: string | null; ticket: number | null }>('SELECT repo, agent, ticket FROM spend WHERE run_id = ?', id)!;
const addRun = (id: string, ticket: number, usage: number | null) =>
  run("INSERT INTO runs (id, ticket_id, repo_id, agent, attempt, model, billing, status, input_tokens, started_at) VALUES (?, ?, (SELECT repo_id FROM tickets WHERE id = ?2), 'design', 1, 'm', 'subscription', 'succeeded', ?, 5)", id, ticket, usage);

let ticket: number;

beforeAll(() => {
  initDb(':memory:');
  run("INSERT INTO connections (kind, provider, name, config, created_at, updated_at) VALUES ('vcs', 'github', 'g', '{}', 0, 0)");
  const conn = one<{ id: number }>('SELECT id FROM connections')!.id;
  run("INSERT INTO repos (vcs_connection_id, ticket_connection_id, full_name, default_branch, url, enabled) VALUES (?, ?, 'me/app', 'main', 'u', 1)", conn, conn);
  const repo = one<{ id: number }>('SELECT id FROM repos')!.id;
  ticket = Number(run("INSERT INTO tickets (repo_id, number, title, body, url, author, state, labels, updated_at) VALUES (?, 7, 't', '', 'u', 'me', 'open', '[]', '2026-10-13T00:00:00Z')", repo).lastInsertRowid);
});

describe('backfillSpend', () => {
  it('fills known runs, leaves orphans, adds missing rows, and is idempotent', () => {
    addRun('known', ticket, 10);
    addRun('missing', ticket, 20);
    addRun('nousage', ticket, null);
    const spend = (id: string) => run("INSERT INTO spend (run_id, ts, model, billing, input_tokens, output_tokens, cost_usd) VALUES (?, 1, 'm', 'subscription', 1, 1, 1)", id);
    spend('known');
    spend('orphan');
    expect(backfillSpend('main')).toEqual({ filled: 1, added: 1 });
    expect(spendOf('known')).toEqual({ repo: 'me/app', agent: 'design', ticket: 7 });
    expect(spendOf('orphan')).toEqual({ repo: null, agent: null, ticket: null });
    expect(spendOf('missing')).toEqual({ repo: 'me/app', agent: 'design', ticket: 7 });
    expect(all('SELECT id FROM spend WHERE run_id = ?', 'nousage')).toHaveLength(0);
    expect(backfillSpend('main')).toEqual({ filled: 0, added: 0 });
  });

  it("adds a task's missing row with its repository and no ticket", () => {
    const repo = one<{ id: number }>('SELECT id FROM repos')!.id;
    const task = run("INSERT INTO tasks (repo_id, title, body, branch, created_at, updated_at) VALUES (?, 'Do it', 'Do it', 'workshop/task-1-do-it', 0, 0)", repo).lastInsertRowid;
    run("INSERT INTO runs (id, task_id, repo_id, agent, attempt, model, billing, status, input_tokens, started_at) VALUES ('task', ?, ?, 'task', 1, 'm', 'api', 'succeeded', 3, 5)", task, repo);
    expect(backfillSpend('main')).toEqual({ filled: 0, added: 1 });
    expect(spendOf('task')).toEqual({ repo: 'me/app', agent: 'task', ticket: null });
  });

  it('recovers deleted runs from an attached older database', () => {
    const file = path.join(process.env.DATA_DIR!, 'old.db');
    fs.rmSync(file, { force: true });
    const old = new DatabaseSync(file);
    old.exec('PRAGMA foreign_keys = ON');
    for (const m of MIGRATIONS.slice(0, -1)) old.exec(m);
    old.exec("INSERT INTO connections (kind, provider, name, config, created_at, updated_at) VALUES ('vcs', 'github', 'g', '{}', 0, 0)");
    old.exec("INSERT INTO repos (id, vcs_connection_id, ticket_connection_id, full_name, default_branch, url, enabled) VALUES (1, 1, 1, 'me/gone', 'main', 'u', 1)");
    old.exec("INSERT INTO tickets (id, repo_id, number, title, body, url, author, state, labels, updated_at) VALUES (1, 1, 3, 't', '', 'u', 'me', 'open', '[]', 'x')");
    const r = (id: string) =>
      old.exec(`INSERT INTO runs (id, ticket_id, agent, attempt, model, billing, status, input_tokens, started_at) VALUES ('${id}', 1, 'implement', 1, 'm', 'subscription', 'succeeded', 5, 5)`);
    r('deleted-orphan');
    r('deleted-unrecorded');
    old.close();

    run("INSERT INTO spend (run_id, ts, model, billing, input_tokens, output_tokens, cost_usd) VALUES ('deleted-orphan', 1, 'm', 'subscription', 1, 1, 1)");
    run('ATTACH DATABASE ? AS src', file);
    try {
      expect(backfillSpend('src')).toEqual({ filled: 1, added: 1 });
    } finally {
      run('DETACH DATABASE src');
    }
    expect(spendOf('deleted-orphan')).toEqual({ repo: 'me/gone', agent: 'implement', ticket: 3 });
    expect(spendOf('deleted-unrecorded')).toEqual({ repo: 'me/gone', agent: 'implement', ticket: 3 });
  });

  it('refuses an unknown schema name', () => {
    expect(() => backfillSpend('x; DROP' as 'main')).toThrow();
  });
});

describe('lifetimeSpend by connection', () => {
  it("totals each connection's subscription and API key under its current name, keeping a removed one's recorded name", () => {
    run('DELETE FROM spend');
    const conn = Number(run("INSERT INTO connections (kind, provider, name, config, created_at, updated_at) VALUES ('model', 'anthropic', 'Claude-2', '{}', 0, 0)").lastInsertRowid);
    const add = (id: string, connId: number | null, name: string | null, cost: number) =>
      run("INSERT INTO spend (run_id, ts, model, billing, input_tokens, output_tokens, cost_usd, connection_id, connection) VALUES (?, 1, 'm', 'subscription', 10, 1, ?, ?, ?)", id, cost, connId, name);
    add('a', conn, 'Bailey-Claude', 1);
    add('b', conn, 'Claude-2', 2);
    add('c', 999, 'Gone', 5);
    add('d', null, null, 0.5);
    run("INSERT INTO spend (run_id, ts, model, billing, input_tokens, output_tokens, cost_usd, connection_id, connection) VALUES ('e', 1, 'm', 'api', 10, 1, 4, ?, 'Claude-2')", conn);
    expect(lifetimeSpend('UTC').byConnection).toEqual([
      { connectionId: 999, connection: 'Gone', billing: 'subscription', runs: 1, inputTokens: 10, outputTokens: 1, costUsd: 5 },
      { connectionId: conn, connection: 'Claude-2', billing: 'api', runs: 1, inputTokens: 10, outputTokens: 1, costUsd: 4 },
      { connectionId: conn, connection: 'Claude-2', billing: 'subscription', runs: 2, inputTokens: 20, outputTokens: 2, costUsd: 3 },
      { connectionId: null, connection: null, billing: 'subscription', runs: 1, inputTokens: 10, outputTokens: 1, costUsd: 0.5 },
    ]);
  });
});
