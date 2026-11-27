import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedAgents, updateAgent } from '../src/agents.ts';
import { all, initDb, MIGRATIONS, one, run } from '../src/db.ts';
import { initCrypto } from '../src/crypto.ts';
import { createConnection } from '../src/providers/index.ts';
import { saveSettings } from '../src/settings.ts';
import { backfillSpend, lifetimeSpend, usageHistory } from '../src/spend.ts';

const spendOf = (id: string) => one<{ repo: string | null; agent: string | null; ticket: number | null }>('SELECT repo, agent, ticket FROM spend WHERE run_id = ?', id)!;
const addRun = (id: string, ticket: number, usage: number | null) =>
  run("INSERT INTO runs (id, ticket_id, agent, attempt, model, billing, status, input_tokens, started_at) VALUES (?, ?, 'design', 1, 'm', 'subscription', 'succeeded', ?, 5)", id, ticket, usage);

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

describe('usageHistory', () => {
  const ins = (runId: string, ts: string, o: { model?: string; billing?: string; cost?: number; repo?: string | null; conn?: number | null; name?: string | null } = {}) =>
    run(
      'INSERT INTO spend (run_id, ts, model, billing, input_tokens, output_tokens, cost_usd, repo, connection_id, connection) VALUES (?, ?, ?, ?, 10, 1, ?, ?, ?, ?)',
      runId,
      Date.parse(ts),
      o.model ?? 'opus',
      o.billing ?? 'subscription',
      o.cost ?? 1,
      o.repo === undefined ? 'me/app' : o.repo,
      o.conn ?? null,
      o.name ?? null,
    );

  it('gives 7 contiguous days across a DST change', () => {
    run('DELETE FROM spend');
    const h = usageHistory('7d', 'Europe/London', Date.parse('2026-10-28T12:00:00Z'));
    expect(h.bucket).toBe('day');
    expect(h.buckets).toEqual(['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28']);
    expect(usageHistory('90d', 'Europe/London', Date.parse('2026-10-28T12:00:00Z')).buckets).toHaveLength(90);
  });

  it('counts a resumed run once per bucket, and a run across midnight once in its totals', () => {
    run('DELETE FROM spend');
    ins('a', '2026-11-20T10:00:00Z');
    ins('a', '2026-11-20T11:00:00Z'); // resumed
    ins('b', '2026-11-21T23:30:00Z');
    ins('b', '2026-11-22T00:30:00Z'); // past midnight
    ins('old', '2026-10-01T00:00:00Z'); // outside the range
    const h = usageHistory('7d', 'UTC', Date.parse('2026-11-26T12:00:00Z'));
    const [s] = h.byBilling;
    expect(h.byBilling).toHaveLength(1);
    expect(s).toMatchObject({ key: 'subscription', name: 'Subscription' });
    expect(s.points.map((p) => p.runs)).toEqual([1, 1, 1, 0, 0, 0, 0]);
    expect(s.points[0]).toMatchObject({ inputTokens: 20, costUsd: 2 });
    expect(s.totals).toMatchObject({ runs: 2, inputTokens: 40, costUsd: 4 });
  });

  it('has only the current month and no series when nothing is recorded', () => {
    run('DELETE FROM spend');
    const h = usageHistory('all', 'UTC', Date.parse('2026-11-26T12:00:00Z'));
    expect(h).toMatchObject({ bucket: 'month', buckets: ['2026-11'], byBilling: [], byModel: [], byProject: [], byConnection: [] });
    expect(h.projection.api).toMatchObject({ todayUsd: 0, capAt: null, perDayUsd: 0, monthToDateUsd: 0, monthEndUsd: 0 });
  });

  it('gives contiguous months from the first row for all time', () => {
    run('DELETE FROM spend');
    ins('a', '2025-11-15T00:00:00Z');
    ins('b', '2026-02-01T00:00:00Z');
    const h = usageHistory('all', 'UTC', Date.parse('2026-03-10T12:00:00Z'));
    expect(h.buckets).toEqual(['2025-11', '2025-12', '2026-01', '2026-02', '2026-03']);
    expect(h.byModel[0].points.map((p) => p.runs)).toEqual([1, 0, 0, 1, 0]);
  });

  it('sorts series by cost and names unknown projects and connections', () => {
    run('DELETE FROM spend');
    const conn = Number(run("INSERT INTO connections (kind, provider, name, config, created_at, updated_at) VALUES ('model', 'anthropic', 'Claude-3', '{}', 0, 0)").lastInsertRowid);
    ins('a', '2026-11-25T00:00:00Z', { model: 'sonnet', cost: 1, repo: null, conn, name: 'Old name' });
    ins('b', '2026-11-25T00:00:00Z', { model: 'opus', cost: 5, billing: 'api', conn, name: 'Claude-3' });
    ins('c', '2026-11-25T00:00:00Z', { model: 'haiku', cost: 3 });
    const h = usageHistory('30d', 'UTC', Date.parse('2026-11-26T12:00:00Z'));
    expect(h.buckets).toHaveLength(30);
    expect(h.byModel.map((s) => s.name)).toEqual(['opus', 'haiku', 'sonnet']);
    expect(h.byBilling.map((s) => s.name)).toEqual(['API', 'Subscription']);
    expect(h.byProject.map((s) => s.name)).toEqual(['me/app', 'Unknown']);
    expect(h.byConnection.map((s) => s.name)).toEqual(['Claude-3 (API key)', 'Unknown (subscription)', 'Claude-3 (subscription)']);
  });

  it('splits month-to-date and the pace by billing', () => {
    run('DELETE FROM spend');
    saveSettings({ apiDailyCapUsd: 20 });
    ins('s1', '2026-10-30T00:00:00Z', { cost: 100 }); // last month: in the pace, not month-to-date
    ins('s2', '2026-11-03T00:00:00Z', { cost: 7 });
    ins('a1', '2026-11-25T00:00:00Z', { billing: 'api', cost: 14 });
    const now = Date.parse('2026-11-05T12:00:00Z');
    const h = usageHistory('7d', 'UTC', now);
    // Recording began 6.5 days ago, so the pace divides by 6.5; the API row is in the future of `now` and ignored.
    expect(h.projection.subscription.perDayUsd).toBeCloseTo(107 / 6.5);
    expect(h.projection.subscription.perDayTokens).toBeCloseTo(22 / 6.5);
    expect(h.projection.subscription.monthToDateUsd).toBe(7);
    expect(h.projection.subscription.monthEndUsd).toBeCloseTo(7 + (107 / 6.5) * 25.5);
    expect(h.projection.api).toMatchObject({ perDayUsd: 0, monthToDateUsd: 0, monthEndUsd: 0, dailyCapUsd: 20 });

    const later = usageHistory('7d', 'UTC', Date.parse('2026-11-26T12:00:00Z'));
    expect(later.projection.api.perDayUsd).toBeCloseTo(14 / 1.5); // API first used 1.5 days before
    expect(later.projection.api.monthToDateUsd).toBe(14);
    expect(later.projection.subscription.perDayUsd).toBe(0);
  });

  it("divides each billing's pace by the days since that billing was first used", () => {
    run('DELETE FROM spend');
    ins('s1', '2026-10-01T00:00:00Z', { cost: 1 });
    ins('s2', '2026-11-25T00:00:00Z', { cost: 7 });
    ins('a1', '2026-11-24T12:00:00Z', { billing: 'api', cost: 4 });
    const h = usageHistory('7d', 'UTC', Date.parse('2026-11-26T12:00:00Z'));
    expect(h.projection.subscription.perDayUsd).toBeCloseTo(1);
    expect(h.projection.api.perDayUsd).toBeCloseTo(2);
  });

  it("carries each subscription's probe readings from the last 7 days and projects its windows", () => {
    initCrypto('test-secret-key');
    const now = Date.parse('2026-11-26T12:00:00Z');
    const H = 3600_000;
    const conn = createConnection('model', 'anthropic', 'Claude-9', {}, { oauthToken: 't' });
    const sample = (ts: number, source: string, five: number | null, week: number | null) =>
      run(
        'INSERT INTO allowance_samples (connection_id, ts, source, five_hour, five_hour_resets, seven_day, seven_day_resets) VALUES (?, ?, ?, ?, ?, ?, ?)',
        conn,
        ts,
        source,
        five,
        now + 3 * H,
        week,
        now + 84 * H,
      );
    sample(now - 8 * 24 * H, 'probe', 10, 10); // too old for the chart
    sample(now - H, 'probe', 10, 40);
    sample(now - 30 * 60_000, 'limit', null, null);
    sample(now, 'probe', 20, 50);
    const a = usageHistory('7d', 'UTC', now).allowance.find((x) => x.connectionId === conn)!;
    expect(a.samples).toEqual([
      { ts: now - H, fiveHour: 10, sevenDay: 40 },
      { ts: now, fiveHour: 20, sevenDay: 50 },
    ]);
    expect(a).toMatchObject({ connectionName: 'Claude-9', sampledAt: now, unknown: false, limits: { fiveHour: 70, weekly: 80 } });
    expect(a.fiveHour).toMatchObject({ pct: 20, ratePerHour: 10, limitAt: null, over: false });
    expect(a.sevenDay).toMatchObject({ pct: 50, limitAt: now + Math.round(50.4 * H) });
  });
});

describe('usageHistory burn rates and backlog', () => {
  const H = 3600_000;
  const now = Date.parse('2026-11-26T12:00:00Z');
  let repo: number;
  let claude: number;
  const ticketAt = (number: number, state: 'open' | 'closed', labels: string[]) =>
    run(
      "INSERT INTO tickets (repo_id, number, title, body, url, author, state, labels, updated_at) VALUES (?, ?, 't', '', 'u', 'me', ?, ?, '2026-11-01T00:00:00Z')",
      repo,
      number,
      state,
      JSON.stringify(labels),
    );
  const spend = (ticket: number, agent: string, cost: number, ts = now - 2 * 86400_000, o: { billing?: string; conn?: number | null } = {}) =>
    run(
      "INSERT INTO spend (run_id, ts, model, billing, input_tokens, output_tokens, cost_usd, repo, agent, ticket, connection_id) VALUES (?, ?, 'opus', ?, ?, 0, ?, 'me/backlog', ?, ?, ?)",
      `${ticket}-${agent}-${ts}`,
      ts,
      o.billing ?? 'subscription',
      cost * 100,
      cost,
      agent,
      ticket,
      o.conn ?? null,
    );
  const probe = (conn: number, five: number | null, week: number | null) =>
    run(
      "INSERT INTO allowance_samples (connection_id, ts, source, five_hour, five_hour_resets, seven_day, seven_day_resets) VALUES (?, ?, 'probe', ?, ?, ?, ?)",
      conn,
      now,
      five,
      now + 3 * H,
      week,
      now + 84 * H,
    );

  beforeAll(() => {
    seedAgents();
    initCrypto('test-secret-key');
    saveSettings({ authors: ['me'], apiDailyCapUsd: 20 });
    run('DELETE FROM spend');
    run("DELETE FROM tickets WHERE state = 'open'");
    run("DELETE FROM connections WHERE kind = 'model'");
    const vcs = one<{ id: number }>("SELECT id FROM connections WHERE kind = 'vcs'")!.id;
    repo = Number(
      run("INSERT INTO repos (vcs_connection_id, ticket_connection_id, full_name, default_branch, url, enabled) VALUES (?, ?, 'me/backlog', 'main', 'u', 1)", vcs, vcs).lastInsertRowid,
    );
    claude = createConnection('model', 'anthropic', 'Claude-1', {}, { oauthToken: 't' });
    // Three finished M tickets: implement $6 and code review $3 each, and one design run of $9.
    for (const n of [1, 2, 3]) {
      ticketAt(n, 'closed', ['workshop/size:m']);
      spend(n, 'implement', 6, undefined, { conn: claude });
      spend(n, 'code-review', 3, undefined, { conn: claude });
    }
    spend(1, 'design', 9, undefined, { conn: claude });
    ticketAt(4, 'closed', ['workshop/size:m']); // closed without being implemented: not finished
    spend(4, 'design', 100, now - 3 * 86400_000);
    ticketAt(10, 'open', ['workshop/size:m', 'workshop/stage:implement']);
    ticketAt(11, 'open', []);
    ticketAt(12, 'open', ['workshop/size:m', 'workshop/stage:design']);
    ticketAt(13, 'open', ['workshop/size:m', 'workshop/stage:pr-review']);
    ticketAt(14, 'open', ['workshop/size:m', 'workshop/stage:implement', 'workshop/needs-info']);
    ticketAt(15, 'open', ['workshop/size:m', 'workshop/stage:implement', 'workshop/failed']);
    run("INSERT INTO tickets (repo_id, number, title, body, url, author, state, labels, updated_at) VALUES (?, 16, 't', '', 'u', 'stranger', 'open', '[]', 'x')", repo);
    spend(99, 'implement', 2, now - 2 * H, { billing: 'api' });
    spend(98, 'implement', 1, now - 2 * H, { conn: claude });
  });

  it('gives burn rates per connection and per billing', () => {
    const h = usageHistory('7d', 'UTC', now);
    const a = h.allowance.find((x) => x.connectionId === claude)!;
    // $28 three days of the week ago plus $1 in the last 5 hours, on a connection first used 3 days ago.
    expect(a.burn.fiveHours).toEqual({ usd: 1, tokens: 100 });
    expect(a.burn.day.usd).toBe(1);
    expect(a.burn.perDay.usd).toBeCloseTo(37 / 2);
    expect(h.projection.api.burn.fiveHours).toEqual({ usd: 2, tokens: 200 });
    expect(h.projection.subscription.burn.perDay.usd).toBeCloseTo(137 / 3);
  });

  it('counts and costs the open tickets from finished ones', () => {
    const b = usageHistory('7d', 'UTC', now).projection.backlog;
    expect(b.tickets).toBe(3);
    expect(b.byStage).toEqual([
      { stage: 'new', count: 1 },
      { stage: 'design', count: 1 },
      { stage: 'implement', count: 1 },
    ]);
    expect(b.basis).toBe(3);
    expect(b.unestimated).toBe(0);
    // implement: 6 + 3; design: 3 + 6 + 3; new: the same plus a classifier never seen ($0).
    expect(b.subscription!.usd).toBeCloseTo(9 + 12 + 12);
    expect(b.api).toBeNull();
  });

  it("splits by each agent's current billing", () => {
    updateAgent('implement', { billing: 'api' });
    try {
      const b = usageHistory('7d', 'UTC', now).projection.backlog;
      expect(b.api!.usd).toBeCloseTo(18);
      expect(b.subscription!.usd).toBeCloseTo(15);
      expect(b.api!.perHourUsd).toBeCloseTo(2 / 24);
      expect(b.finishAt).toBe(Math.max(b.api!.finishAt!, b.subscription!.finishAt!));
    } finally {
      updateAgent('implement', { billing: 'subscription' });
    }
  });

  it('runs an unmetered subscription at the pace alone and names it', () => {
    probe(claude, null, null);
    const b = usageHistory('7d', 'UTC', now).projection.backlog;
    expect(b.subscription).toMatchObject({ unmetered: ['Claude-1'], unsized: [], limitedBy: null, reason: null });
    expect(b.subscription!.finishAt).toBe(b.subscription!.unlimitedAt);
  });

  it('sizes windows it has readings for and lists the ones it ignores', () => {
    probe(claude, 2, 40); // 5-hour too low to size; weekly: $38 since it began bought 40%
    const b = usageHistory('7d', 'UTC', now).projection.backlog;
    expect(b.subscription).toMatchObject({ unmetered: [], unsized: ['Claude-1 5-hour'] });
    expect(b.subscription!.finishAt).not.toBeNull();
  });

  it('has no subscription to run on when every one is paused', () => {
    run('UPDATE connections SET paused = 1 WHERE id = ?', claude);
    try {
      expect(usageHistory('7d', 'UTC', now).projection.backlog.subscription).toMatchObject({ reason: 'no-subscription', finishAt: null });
    } finally {
      run('UPDATE connections SET paused = 0 WHERE id = ?', claude);
    }
  });
});
