import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/db.ts';

// The tasks migration (#102), which lets a run belong to a task instead of a ticket, rebuilds the table, so it must keep every column.
const TASKS = MIGRATIONS.findIndex((m) => m.includes('CREATE TABLE runs_new'));

function before() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const m of MIGRATIONS.slice(0, TASKS)) db.exec(m);
  db.exec(`
    INSERT INTO connections (id, kind, provider, name, created_at, updated_at) VALUES (1, 'vcs', 'github', 'g', 0, 0), (2, 'model', 'anthropic', 'c', 0, 0);
    INSERT INTO repos (id, vcs_connection_id, full_name, default_branch, url) VALUES (5, 1, 'me/app', 'main', 'https://github.com/me/app');
    INSERT INTO tickets (id, repo_id, number, title, url, author, state, updated_at) VALUES (9, 5, 3, 't', 'u', 'me', 'open', 'x');
    INSERT INTO agent_classes (name, model, model_connection_id, effort, billing, max_turns, timeout_min) VALUES ('implement', 'claude-sonnet-5-5', 2, 'high', 'api', 300, 180);
  `);
  return db;
}

const apply = (db: DatabaseSync) => {
  db.exec('BEGIN');
  for (const m of MIGRATIONS.slice(TASKS)) db.exec(m);
  db.exec('COMMIT');
};

describe('the tasks migration', () => {
  it('keeps every run column, backfills the repository and seeds the Task agent', () => {
    const db = before();
    db.prepare(
      `INSERT INTO runs (id, ticket_id, agent, mode, attempt, environment_id, model_connection_id, model, billing, status, step, container_id, volume, log_since, resumes, exit_code, result, summary, error,
         input_tokens, output_tokens, cost_usd, resets_at, started_at, ended_at, image, pause_reason, pause_requested_at, switched_from, max_turns, timeout_min, step_started_at,
         publish_state, publish_retries, publish_retry_at, publish_failing_since)
       VALUES ('old', 9, 'implement', 'delta', 2, NULL, 2, 'm', 'api', 'succeeded', 'publish', 'c1', 'v1', 'ls', 1, 0, '{}', 'sum', 'err',
         10, 20, 0.5, 7, 100, 200, 'img', 'limit', 8, 2, 300, 60, 150, '{"done":[]}', 3, 400, 350)`,
    ).run();
    db.exec("INSERT INTO runs (id, ticket_id, agent, attempt, model, billing, status, started_at) VALUES ('active', 9, 'design', 1, 'm', 'subscription', 'running', 1)");
    const old = db.prepare("SELECT * FROM runs WHERE id = 'old'").get();
    apply(db);
    expect(db.prepare("SELECT * FROM runs WHERE id = 'old'").get()).toEqual({ ...old, task_id: null, repo_id: 5, prompt: null, browser: 0 });
    expect(db.prepare("SELECT repo_id FROM runs WHERE id = 'active'").get()).toEqual({ repo_id: 5 });
    expect(db.prepare("SELECT model, model_connection_id, effort, billing, max_turns, timeout_min FROM agent_classes WHERE name = 'task'").get()).toEqual({
      model: 'claude-sonnet-5-5',
      model_connection_id: 2,
      effort: 'high',
      billing: 'api',
      max_turns: 200,
      timeout_min: 120,
    });
  });

  it('allows one active run per ticket and per task, and needs exactly one of them', () => {
    const db = before();
    db.exec("INSERT INTO runs (id, ticket_id, agent, attempt, model, billing, status, started_at) VALUES ('active', 9, 'design', 1, 'm', 'subscription', 'running', 1)");
    apply(db);
    db.exec(`INSERT INTO tasks (id, repo_id, title, body, branch, created_at, updated_at) VALUES (1, 5, 'a', 'Do a thing', 'workshop/task-1-a', 0, 0), (2, 5, 'b', 'Do another', 'workshop/task-2-b', 0, 0)`);
    const insert = (id: string, ticket: number | null, task: number | null, status = 'running') =>
      db.prepare("INSERT INTO runs (id, ticket_id, task_id, repo_id, agent, attempt, model, billing, status, started_at) VALUES (?, ?, ?, 5, 'task', 1, 'm', 'subscription', ?, 1)").run(id, ticket, task, status);
    expect(() => insert('second', 9, null)).toThrow(/UNIQUE/);
    insert('t1', null, 1);
    insert('t2', null, 2);
    expect(() => insert('t1-again', null, 1, 'paused')).toThrow(/UNIQUE/);
    insert('t1-old', null, 1, 'succeeded');
    expect(() => insert('neither', null, null)).toThrow(/CHECK/);
    expect(() => insert('both', 9, 1, 'failed')).toThrow(/CHECK/);
  });

  it('deletes the runs of a deleted task', () => {
    const db = before();
    apply(db);
    db.exec("INSERT INTO tasks (id, repo_id, title, body, branch, created_at, updated_at) VALUES (1, 5, 'a', 'b', 'workshop/task-1-a', 0, 0)");
    db.exec("INSERT INTO runs (id, task_id, repo_id, agent, attempt, model, billing, status, started_at) VALUES ('t', 1, 5, 'task', 1, 'm', 'subscription', 'succeeded', 1)");
    db.exec('DELETE FROM tasks WHERE id = 1');
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
  });

  it('drops a run whose ticket row is gone instead of failing', () => {
    const db = before();
    db.exec('PRAGMA foreign_keys = OFF');
    db.exec("INSERT INTO runs (id, ticket_id, agent, attempt, model, billing, status, started_at) VALUES ('orphan', 999, 'design', 1, 'm', 'subscription', 'failed', 1)");
    db.exec('PRAGMA foreign_keys = ON');
    apply(db);
    expect(db.prepare('SELECT COUNT(*) AS n FROM runs').get()).toEqual({ n: 0 });
  });
});
