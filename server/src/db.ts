import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Append-only: each entry upgrades the schema by one version (PRAGMA user_version).
export const MIGRATIONS = [
  `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL
  );

  CREATE TABLE connections (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('vcs', 'tickets', 'environment', 'model')),
    provider TEXT NOT NULL,
    name TEXT NOT NULL,
    config TEXT NOT NULL DEFAULT '{}',
    secret TEXT,
    status TEXT NOT NULL DEFAULT 'unknown',
    checked_at INTEGER,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE agent_classes (
    name TEXT PRIMARY KEY,
    model TEXT,
    model_connection_id INTEGER REFERENCES connections(id) ON DELETE SET NULL,
    effort TEXT,
    billing TEXT NOT NULL DEFAULT 'subscription',
    prompt TEXT,
    max_turns INTEGER NOT NULL,
    timeout_min INTEGER NOT NULL
  );

  CREATE TABLE repos (
    id INTEGER PRIMARY KEY,
    vcs_connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    ticket_connection_id INTEGER REFERENCES connections(id) ON DELETE SET NULL,
    full_name TEXT NOT NULL,
    default_branch TEXT NOT NULL,
    private INTEGER NOT NULL DEFAULT 0,
    url TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    synced_at TEXT,
    UNIQUE (vcs_connection_id, full_name)
  );

  CREATE TABLE tickets (
    id INTEGER PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    node_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL,
    author TEXT NOT NULL,
    state TEXT NOT NULL,
    labels TEXT NOT NULL DEFAULT '[]',
    branch TEXT,
    pr_number INTEGER,
    pr_url TEXT,
    pr_status TEXT,
    failures INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    UNIQUE (repo_id, number)
  );

  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    agent TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'normal',
    attempt INTEGER NOT NULL,
    environment_id INTEGER REFERENCES connections(id) ON DELETE SET NULL,
    model_connection_id INTEGER REFERENCES connections(id) ON DELETE SET NULL,
    model TEXT NOT NULL,
    billing TEXT NOT NULL,
    status TEXT NOT NULL,
    step TEXT,
    container_id TEXT,
    volume TEXT,
    log_since TEXT,
    resumes INTEGER NOT NULL DEFAULT 0,
    exit_code INTEGER,
    result TEXT,
    summary TEXT,
    error TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cost_usd REAL,
    resets_at INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  -- One agent per ticket at a time. Paused runs keep the slot: they resume after the limit resets.
  CREATE UNIQUE INDEX runs_one_active_per_ticket ON runs(ticket_id)
    WHERE status IN ('starting', 'running', 'publishing', 'paused');

  CREATE TABLE alerts (
    id INTEGER PRIMARY KEY,
    level TEXT NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL,
    ref TEXT,
    created_at INTEGER NOT NULL,
    ack_at INTEGER
  );

  CREATE TABLE allowance_samples (
    id INTEGER PRIMARY KEY,
    connection_id INTEGER NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
    ts INTEGER NOT NULL,
    source TEXT NOT NULL,
    five_hour REAL,
    five_hour_resets INTEGER,
    seven_day REAL,
    seven_day_resets INTEGER,
    blocked_until INTEGER
  );
  `,
  `ALTER TABLE tickets ADD COLUMN blocked_by TEXT NOT NULL DEFAULT '[]';`,
  `
  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  `,
  `
  ALTER TABLE tickets ADD COLUMN push TEXT;
  ALTER TABLE tickets ADD COLUMN push_stage TEXT;
  `,
  `
  ALTER TABLE repos ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
  `,
  `ALTER TABLE repos ADD COLUMN selection TEXT NOT NULL DEFAULT 'all';`,
  `
  CREATE TABLE spend (
    id INTEGER PRIMARY KEY,
    run_id TEXT NOT NULL, -- no FK: outlives the run
    ts INTEGER NOT NULL,
    model TEXT NOT NULL,
    billing TEXT NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd REAL NOT NULL
  );
  INSERT INTO spend (run_id, ts, model, billing, input_tokens, output_tokens, cost_usd)
    SELECT id, COALESCE(ended_at, started_at), model, billing,
           COALESCE(input_tokens, 0), COALESCE(output_tokens, 0), COALESCE(cost_usd, 0)
    FROM runs WHERE input_tokens IS NOT NULL OR output_tokens IS NOT NULL OR cost_usd IS NOT NULL;
  `,
  // Re-list every ticket on the next sync so existing rows get their creation time.
  `
  ALTER TABLE tickets ADD COLUMN created_at TEXT;
  UPDATE repos SET synced_at = NULL;
  `,
  `
  CREATE TABLE media (
    id INTEGER PRIMARY KEY,
    ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    source TEXT NOT NULL, -- 'issue', 'comment', or an agent name
    source_key TEXT, -- issue/comment images: imageKey of the URL, so re-syncs don't download them again
    run_id TEXT, -- no FK: outlives the run
    caption TEXT,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (ticket_id, name)
  );
  CREATE INDEX media_run ON media (run_id);
  ALTER TABLE tickets ADD COLUMN ui INTEGER NOT NULL DEFAULT 0;
  `,
  // What a rescued push interrupted (JSON), until the Merge agent has reconciled it.
  `ALTER TABLE tickets ADD COLUMN rescue TEXT;`,
  // The attention key you dismissed from Needs you; hidden while it still matches.
  `ALTER TABLE tickets ADD COLUMN dismissed TEXT;`,
  // New repositories only work on nominated tickets until you choose otherwise (#59).
  `UPDATE repos SET selection = 'nominated' WHERE enabled = 0;`,
  // The image a run uses, chosen (and maybe built) when it starts, so every step and re-attach uses the same one.
  `ALTER TABLE runs ADD COLUMN image TEXT;`,
  // Usage warnings were wrongly recorded as limits; clear them (a real limit is re-recorded on the next run).
  `DELETE FROM allowance_samples WHERE source = 'limit';`,
  // Record which repository, agent and ticket each ledger row belongs to, filled for runs that still exist.
  `
  ALTER TABLE spend ADD COLUMN repo TEXT; -- repos.full_name when recorded; NULL if unknown
  ALTER TABLE spend ADD COLUMN agent TEXT;
  ALTER TABLE spend ADD COLUMN ticket INTEGER; -- issue number in that repo
  UPDATE spend SET repo = x.full_name, agent = x.agent, ticket = x.number
    FROM (SELECT runs.id, repos.full_name, runs.agent, tickets.number
          FROM runs JOIN tickets ON tickets.id = runs.ticket_id JOIN repos ON repos.id = tickets.repo_id) AS x
    WHERE x.id = spend.run_id;
  `,
  `ALTER TABLE tickets ADD COLUMN prioritised INTEGER NOT NULL DEFAULT 0; -- you prioritised it by hand; cleared when it closes`,
  `
  ALTER TABLE repos ADD COLUMN merge_without_review INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE repos ADD COLUMN merge_warning TEXT; -- what the branch check warned about when merge without review was turned on
  `,
  `ALTER TABLE runs ADD COLUMN pause_reason TEXT; -- while paused: 'limit' (Claude refused) or 'threshold' (your Settings limit)`,
  `ALTER TABLE runs ADD COLUMN pause_requested_at INTEGER; -- while starting/running: when you asked to pause at the next turn boundary`,
  // Which Claude connection (subscription or API key) each ledger row was billed to; the name is kept for when it's removed.
  `
  ALTER TABLE spend ADD COLUMN connection_id INTEGER;
  ALTER TABLE spend ADD COLUMN connection TEXT;
  UPDATE spend SET connection_id = x.id, connection = x.name
    FROM (SELECT runs.id AS run_id, connections.id, connections.name
          FROM runs JOIN connections ON connections.id = runs.model_connection_id) AS x
    WHERE x.run_id = spend.run_id;
  CREATE INDEX spend_connection ON spend (connection_id, ts);
  `,
  // Your order of connections of the same kind; subscription agents use the first Claude subscription that isn't blocked.
  `
  ALTER TABLE connections ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
  UPDATE connections SET position = id;
  `,
  // A paused AI model connection keeps its settings, but no new agent uses it.
  `ALTER TABLE connections ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;`,
  // The Claude connection a run just moved off; cleared at its first turn boundary on the new one.
  `ALTER TABLE runs ADD COLUMN switched_from INTEGER;`,
  `
  -- Usage limits per Claude connection (were global settings).
  ALTER TABLE connections ADD COLUMN five_hour_max REAL NOT NULL DEFAULT 70;
  ALTER TABLE connections ADD COLUMN weekly_max REAL NOT NULL DEFAULT 80;
  UPDATE connections SET
    five_hour_max = COALESCE((SELECT json_extract(value, '$.fiveHourMax') FROM settings WHERE key = 'settings'), 70),
    weekly_max = COALESCE((SELECT json_extract(value, '$.weeklyMax') FROM settings WHERE key = 'settings'), 80);
  UPDATE settings SET value = json_remove(value, '$.fiveHourMax', '$.weeklyMax') WHERE key = 'settings';
  `,
  `
  -- The Implementation result the pull request describes, until it opens (JSON).
  ALTER TABLE tickets ADD COLUMN handoff TEXT;
  -- Automatic reworks this review round and the severe findings to fix (JSON).
  ALTER TABLE tickets ADD COLUMN rework TEXT;
  -- Existing installs: the Code reviewer starts with the Design adversary's model and billing.
  INSERT OR IGNORE INTO agent_classes (name, model, model_connection_id, effort, billing, max_turns, timeout_min)
    SELECT 'code-review', model, model_connection_id, effort, billing, 150, 60 FROM agent_classes WHERE name = 'design-review';
  `,
  `
  -- The limits a run's agent session started with, and when its current container started (#93).
  ALTER TABLE runs ADD COLUMN max_turns INTEGER;
  ALTER TABLE runs ADD COLUMN timeout_min INTEGER;
  ALTER TABLE runs ADD COLUMN step_started_at INTEGER;
  `,
];

export let db: DatabaseSync;

export function initDb(file: string): DatabaseSync {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

type Param = string | number | bigint | null | Uint8Array;

export function one<T>(sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function all<T>(sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function run(sql: string, ...params: Param[]) {
  return db.prepare(sql).run(...params);
}
