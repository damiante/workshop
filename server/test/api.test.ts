import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { seedAgents } from '../src/agents.ts';
import { createApp } from '../src/app.ts';
import { initCrypto, totp } from '../src/crypto.ts';
import { DatabaseSync } from 'node:sqlite';
import { initDb, MIGRATIONS, one, run } from '../src/db.ts';
import { mediaDir } from '../src/media.ts';
import { createConnection } from '../src/providers/index.ts';
import { publish } from '../src/events.ts';
import { appendLog, readLog } from '../src/runs.ts';
import { saveSettings } from '../src/settings.ts';
import { apiRouter } from '../src/http/api.ts';
import { OPENAPI } from '../src/http/openapi.ts';
import { sweepExpiredTokens } from '../src/http/tokens.ts';

// The ticket source is faked, so label edits can be recorded or made to fail, and the code host's branch rules.
const fakeTickets = vi.hoisted(() => ({ setLabels: null as any, createTicket: null as any }));
const fakeVcs = vi.hoisted(() => ({ mergeRules: null as any }));
vi.mock('../src/providers/index.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ticketsOf: () => fakeTickets,
  vcsOf: () => fakeVcs,
}));

const PASSWORD = 'correct horse battery'; // see vitest.config.ts
const app = (() => {
  initCrypto('test-secret-key');
  initDb(':memory:');
  seedAgents();
  return createApp();
})();

let cookie = '';
const code = (secret: string) => totp(secret, Math.floor(Date.now() / 30_000));

describe('sign-in', () => {
  it('protects the API', async () => {
    expect((await request(app).get('/api/overview')).status).toBe(401);
  });

  it('enrols an authenticator on first sign-in, then issues a session', async () => {
    expect((await request(app).post('/api/auth/login').send({ password: 'nope' })).status).toBe(401);
    const first = await request(app).post('/api/auth/login').send({ password: PASSWORD });
    expect(first.body.enroll.uri).toMatch(/^otpauth:\/\/totp\/Workshop\?secret=/);
    const secret = first.body.enroll.secret;
    // The same pending secret is offered until enrolment completes, so a reload doesn't invalidate a scan.
    expect((await request(app).post('/api/auth/login').send({ password: PASSWORD })).body.enroll.secret).toBe(secret);

    const done = await request(app).post('/api/auth/login').send({ password: PASSWORD, code: code(secret) });
    expect(done.body).toEqual({ ok: true });
    cookie = done.headers['set-cookie'][0].split(';')[0];
    expect(done.headers['set-cookie'][0]).toMatch(/HttpOnly; SameSite=Lax/);

    // The code just used can't be replayed.
    expect((await request(app).post('/api/auth/login').send({ password: PASSWORD, code: code(secret) })).status).toBe(401);
    expect((await request(app).get('/api/auth/state').set('cookie', cookie)).body).toMatchObject({ authenticated: true, enrolled: true });
  });
});

describe('authenticated API', () => {
  it('starts paused with nothing queued', async () => {
    const res = await request(app).get('/api/overview').set('cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mode: 'paused', queue: [], running: [], hosts: [] });
  });

  it('validates settings', async () => {
    const bad = await request(app).put('/api/settings').set('cookie', cookie).send({ timezone: 'Mars/Olympus' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/isn't a time zone/);
    expect((await request(app).put('/api/settings').set('cookie', cookie).send({ start: '25:00' })).status).toBe(400);
    const ok = await request(app).put('/api/settings').set('cookie', cookie).send({ mode: 'scheduled', start: '22:00', end: '07:00', authors: ['@Damiante'] });
    expect(ok.body).toMatchObject({ mode: 'scheduled', start: '22:00', end: '07:00', authors: ['Damiante'] });
  });

  it('validates and saves the ticket order', async () => {
    const bad = await request(app).put('/api/settings').set('cookie', cookie).send({ ticketOrder: 'random' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Unknown ticket order.');
    const ok = await request(app).put('/api/settings').set('cookie', cookie).send({ ticketOrder: 'created-desc' });
    expect(ok.body.ticketOrder).toBe('created-desc');
    expect((await request(app).get('/api/settings').set('cookie', cookie)).body.ticketOrder).toBe('created-desc');
  });

  it('treats a prompt equal to the default as not customised', async () => {
    const agents = (await request(app).get('/api/agents').set('cookie', cookie)).body;
    const classifier = agents.find((a: { name: string }) => a.name === 'classifier');
    const custom = await request(app).put('/api/agents/classifier').set('cookie', cookie).send({ prompt: 'Be brief.' });
    expect(custom.body).toMatchObject({ prompt: 'Be brief.', customised: true });
    const reset = await request(app).put('/api/agents/classifier').set('cookie', cookie).send({ prompt: classifier.defaultPrompt });
    expect(reset.body.customised).toBe(false);
  });

  it('refuses cross-site writes', async () => {
    const res = await request(app).put('/api/settings').set('cookie', cookie).set('origin', 'https://evil.example').send({ mode: 'always' });
    expect(res.status).toBe(403);
  });

  it('validates connection forms against the provider fields', async () => {
    const res = await request(app).post('/api/connections').set('cookie', cookie).send({ provider: 'docker', values: { mode: 'ssh', host: 'box' } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/SSH user is required/);
  });
});

describe('API tokens', () => {
  let write = '';
  let read = '';
  let writeId = 0;
  const create = (body: object) => request(app).post('/api/tokens').set('cookie', cookie).send(body);

  it('shows a new token once and never lists it', async () => {
    const made = await create({ name: ' Home ', scope: 'write' });
    expect(made.status).toBe(201);
    expect(made.body.token).toMatch(/^wks_/);
    expect(made.body.view).toMatchObject({ name: 'Home', scope: 'write', lastUsedAt: null });
    write = made.body.token;
    writeId = made.body.view.id;
    read = (await create({ name: 'Dash', scope: 'read' })).body.token;
    const list = await request(app).get('/api/tokens').set('cookie', cookie);
    expect(list.body.map((t: { name: string }) => t.name)).toEqual(['Dash', 'Home']);
    expect(JSON.stringify(list.body)).not.toContain(write);
  });

  it('validates name and scope', async () => {
    expect((await create({ name: '', scope: 'read' })).status).toBe(400);
    expect((await create({ name: 'x'.repeat(61), scope: 'read' })).status).toBe(400);
    const bad = await create({ name: 'ok', scope: 'admin' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Scope must be read or write.');
  });

  it('lets a write token use the API and records its use', async () => {
    expect((await request(app).get('/api/overview').set('authorization', `Bearer ${write}`)).status).toBe(200);
    const put = await request(app).put('/api/settings').set('authorization', `Bearer ${write}`).send({ mode: 'always' });
    expect(put.body.mode).toBe('always');
    expect(one<{ last_used_at: number }>('SELECT last_used_at FROM api_tokens WHERE id = ?', writeId)?.last_used_at).toBeGreaterThan(0);
  });

  it('keeps a read token to GET', async () => {
    const put = await request(app).put('/api/settings').set('authorization', `Bearer ${read}`).send({ mode: 'paused' });
    expect(put.status).toBe(403);
    expect(put.body.error).toBe('This API token is read-only.');
    expect((await request(app).get('/api/usage').set('authorization', `Bearer ${read}`)).status).toBe(200);
    expect((await request(app).get('/api/usage/lifetime').set('authorization', `Bearer ${read}`)).status).toBe(200);
    const history = await request(app).get('/api/usage/history').set('authorization', `Bearer ${read}`);
    expect(history.status).toBe(200);
    expect(history.body).toMatchObject({ range: '30d', bucket: 'day' });
    expect(history.body.buckets).toHaveLength(30);
  });

  it('answers an unknown token with JSON 401, not a redirect', async () => {
    const res = await request(app).get('/api/overview').set('accept', 'text/html').set('authorization', 'Bearer wks_nope');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('That API token is wrong or was revoked.');
  });

  it("can't reach connections or tokens, which still work with the session", async () => {
    const auth = { authorization: `Bearer ${write}` };
    for (const res of [
      await request(app).get('/api/connections').set(auth),
      await request(app).post('/api/tokens').set(auth).send({ name: 'x', scope: 'read' }),
      await request(app).delete(`/api/tokens/${writeId}`).set(auth),
    ]) {
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/can't manage connections or tokens/);
    }
    expect((await request(app).get('/api/connections').set('cookie', cookie)).status).toBe(200);
  });

  it('stops a revoked token and 404s an unknown id', async () => {
    expect((await request(app).delete(`/api/tokens/${writeId}`).set('cookie', cookie)).status).toBe(200);
    expect((await request(app).get('/api/overview').set('authorization', `Bearer ${write}`)).status).toBe(401);
    expect((await request(app).delete(`/api/tokens/${writeId}`).set('cookie', cookie)).status).toBe(404);
  });

  it('stores a lifetime, and never expires without one', async () => {
    const timed = (await create({ name: 'Timed', scope: 'read', expiresInMinutes: 60 })).body;
    expect(timed.view.expiresAt - timed.view.createdAt).toBe(3_600_000);
    const forever = (await create({ name: 'Forever', scope: 'read', expiresInMinutes: null })).body;
    expect(forever.view.expiresAt).toBeNull();
    expect((await request(app).get('/api/overview').set('authorization', `Bearer ${timed.token}`)).status).toBe(200);
    const list = (await request(app).get('/api/tokens').set('cookie', cookie)).body as { name: string; expiresAt: number | null }[];
    expect(list.find((t) => t.name === 'Timed')?.expiresAt).toBe(timed.view.expiresAt);
    expect(list.find((t) => t.name === 'Forever')?.expiresAt).toBeNull();
  });

  it('refuses an expired token without recording its use', async () => {
    const made = (await create({ name: 'Brief', scope: 'read', expiresInMinutes: 5 })).body;
    run('UPDATE api_tokens SET expires_at = ? WHERE id = ?', Date.now() - 1, made.view.id);
    const res = await request(app).get('/api/overview').set('authorization', `Bearer ${made.token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('That API token has expired. Create a new one in Settings.');
    expect(one<{ last_used_at: number | null }>('SELECT last_used_at FROM api_tokens WHERE id = ?', made.view.id)?.last_used_at).toBeNull();
  });

  it('validates the lifetime', async () => {
    for (const expiresInMinutes of [1, 'abc', 525_601, 60.5]) {
      const res = await create({ name: 'x', scope: 'read', expiresInMinutes });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Lifetime in minutes must be a whole number from 5 to 525600.');
    }
  });

  it('sweeps tokens a week after they expire', async () => {
    const ids = [];
    for (const [name, ago] of [['Old', 8], ['Recent', 1], ['Endless', null]] as const) {
      const id = (await create({ name, scope: 'read', expiresInMinutes: ago === null ? null : 60 })).body.view.id as number;
      if (ago !== null) run('UPDATE api_tokens SET expires_at = ? WHERE id = ?', Date.now() - ago * 86400_000, id);
      ids.push(id);
    }
    sweepExpiredTokens();
    const left = (id: number) => Boolean(one('SELECT id FROM api_tokens WHERE id = ?', id));
    expect(ids.map(left)).toEqual([false, true, true]);
  });
});

describe('usage history', () => {
  it('refuses an unknown range', async () => {
    const res = await request(app).get('/api/usage/history?range=1y').set('cookie', cookie);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Range must be 24h, 7d, 30d, 90d or all.');
    expect((await request(app).get('/api/usage/history?range=7d&range=30d').set('cookie', cookie)).status).toBe(400);
  });

  it('answers each range', async () => {
    for (const [range, n] of [['7d', 7], ['90d', 90]] as const) {
      const res = await request(app).get(`/api/usage/history?range=${range}`).set('cookie', cookie);
      expect(res.body.buckets).toHaveLength(n);
    }
  });

  it('includes burn rates and the backlog projection', async () => {
    const res = await request(app).get('/api/usage/history?range=7d').set('cookie', cookie);
    expect(res.body.projection.backlog).toMatchObject({ tickets: expect.any(Number), byStage: expect.any(Array), basis: expect.any(Number) });
    expect(res.body.projection.subscription.burn).toMatchObject({ fiveHours: { usd: 0, tokens: 0 } });
    for (const a of res.body.allowance) expect(a.burn).toHaveProperty('perDay');
  });
});

describe('lifetime usage', () => {
  const ins = (run_id: string, ts: string, model: string, billing: string, i: number, o: number, c: number, repo: string | null = null) =>
    run('INSERT INTO spend (run_id, ts, model, billing, input_tokens, output_tokens, cost_usd, repo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', run_id, Date.parse(ts), model, billing, i, o, c, repo);

  it('is empty before anything is recorded', async () => {
    const res = await request(app).get('/api/usage/lifetime').set('cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.since).toBeNull();
    expect(res.body.total).toEqual({ runs: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
    expect(res.body.byModel).toEqual([]);
    expect(res.body.byProject).toEqual([]);
  });

  it('groups by project, with spend of unknown origin under null', async () => {
    run('DELETE FROM spend');
    ins('a', '2026-10-01T00:00:00Z', 'opus', 'subscription', 100, 10, 1, 'me/app');
    ins('a', '2026-10-02T00:00:00Z', 'opus', 'subscription', 50, 5, 0.5, 'me/app'); // resumed
    ins('b', '2026-10-03T00:00:00Z', 'sonnet', 'api', 20, 2, 2, 'me/other');
    ins('c', '2026-10-04T00:00:00Z', 'sonnet', 'subscription', 10, 1, 0.1);
    const b = (await request(app).get('/api/usage/lifetime').set('cookie', cookie)).body;
    expect(b.byProject.map((p: { project: string | null }) => p.project)).toEqual(['me/other', 'me/app', null]);
    expect(b.byProject[1]).toMatchObject({ runs: 1, inputTokens: 150 });
    expect(b.byProject[2]).toMatchObject({ runs: 1, inputTokens: 10 });
    const sum = (k: 'runs' | 'inputTokens') => b.byProject.reduce((n: number, p: Record<string, number>) => n + p[k], 0);
    expect(sum('runs')).toBe(b.total.runs);
    expect(sum('inputTokens')).toBe(b.total.inputTokens);
    run('DELETE FROM spend');
  });

  it('totals by billing, model and month in the settings time zone', async () => {
    run('DELETE FROM spend');
    saveSettings({ timezone: 'Australia/Sydney' });
    ins('a', '2026-09-30T20:00:00Z', 'opus', 'subscription', 100, 10, 1); // 1 Oct in Sydney
    ins('a', '2026-10-02T00:00:00Z', 'opus', 'subscription', 50, 5, 0.5); // same run, resumed
    ins('b', '2026-10-03T00:00:00Z', 'sonnet', 'api', 20, 2, 0.25);
    ins('c', '2026-08-15T00:00:00Z', 'sonnet', 'subscription', 10, 1, 0.1);
    const res = await request(app).get('/api/usage/lifetime').set('cookie', cookie);
    const b = res.body;
    expect(b.since).toBe(Date.parse('2026-08-15T00:00:00Z'));
    expect(b.total).toMatchObject({ runs: 3, inputTokens: 180, outputTokens: 18 });
    expect(b.total.costUsd).toBeCloseTo(1.85);
    expect(b.subscription).toMatchObject({ runs: 2, inputTokens: 160 });
    expect(b.api).toMatchObject({ runs: 1, inputTokens: 20, costUsd: 0.25 });
    expect(b.byModel.map((m: { model: string }) => m.model)).toEqual(['opus', 'sonnet']);
    expect(b.byModel[0]).toMatchObject({ runs: 1, inputTokens: 150 });
    expect(b.byMonth.map((m: { month: string }) => m.month)).toEqual(['2026-10', '2026-08']);
    expect(b.byMonth[0]).toMatchObject({ runs: 2, inputTokens: 170 });
    run('DELETE FROM spend');
    saveSettings({ timezone: 'UTC' });
  });
});

describe('usage limits per subscription', () => {
  let sub: number;
  beforeAll(() => {
    sub = createConnection('model', 'anthropic', 'Claude', {}, { oauthToken: 'sk-ant-oat01-x' });
  });
  afterAll(() => {
    run('DELETE FROM connections WHERE id = ?', sub);
  });

  it('lists each subscription with its limits', async () => {
    const res = await request(app).get('/api/usage').set('cookie', cookie);
    expect(res.body.allowance).toEqual([expect.objectContaining({ connectionId: sub, limits: { fiveHour: 70, weekly: 80 } })]);
    expect((await request(app).get('/api/overview').set('cookie', cookie)).body.allowance[0].limits).toEqual({ fiveHour: 70, weekly: 80 });
  });

  it('saves the limits you send and keeps the rest', async () => {
    const res = await request(app).put(`/api/usage/limits/${sub}`).set('cookie', cookie).send({ fiveHour: 50 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ connectionId: sub, connectionName: 'Claude', limits: { fiveHour: 50, weekly: 80 } });
    await request(app).put(`/api/usage/limits/${sub}`).set('cookie', cookie).send({ weekly: 90.5 });
    expect((await request(app).get('/api/usage').set('cookie', cookie)).body.allowance[0].limits).toEqual({ fiveHour: 50, weekly: 90.5 });
  });

  it('validates the limits', async () => {
    for (const body of [{ fiveHour: 101 }, { weekly: -1 }, { fiveHour: 'lots' }]) {
      const res = await request(app).put(`/api/usage/limits/${sub}`).set('cookie', cookie).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/limit must be between 0 and 100/);
    }
  });

  it('only sets limits on Claude subscriptions', async () => {
    const host = createConnection('environment', 'docker', 'box', { mode: 'socket', slots: 1 }, {});
    const apiKey = createConnection('model', 'anthropic', 'API', {}, { apiKey: 'sk-ant-api-x' });
    try {
      for (const id of [host, apiKey, 9999]) {
        const res = await request(app).put(`/api/usage/limits/${id}`).set('cookie', cookie).send({ fiveHour: 50 });
        expect(res.status).toBe(404);
        expect(res.body.error).toBe("That isn't a Claude subscription connection.");
      }
    } finally {
      run('DELETE FROM connections WHERE id IN (?, ?)', host, apiKey);
    }
  });

  it('refuses a read-only token', async () => {
    const token = (await request(app).post('/api/tokens').set('cookie', cookie).send({ name: 'limits', scope: 'read' })).body.token;
    expect((await request(app).put(`/api/usage/limits/${sub}`).set('authorization', `Bearer ${token}`).send({ fiveHour: 10 })).status).toBe(403);
  });

  it('points old scripts that set global limits to the new route', async () => {
    for (const body of [{ fiveHourMax: 50 }, { weeklyMax: 60 }]) {
      const res = await request(app).put('/api/settings').set('cookie', cookie).send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Usage limits are set per subscription now: PUT /api/usage/limits/:connectionId.');
    }
    expect((await request(app).get('/api/settings').set('cookie', cookie)).body).not.toHaveProperty('fiveHourMax');
  });

  it('migrates the global limits onto every connection', () => {
    const limits = MIGRATIONS.findIndex((m) => m.includes('ADD COLUMN five_hour_max'));
    const migrate = (settings: object | null) => {
      const db = new DatabaseSync(':memory:');
      for (const m of MIGRATIONS.slice(0, limits)) db.exec(m);
      db.exec("INSERT INTO connections (kind, provider, name, config, created_at, updated_at) VALUES ('model', 'anthropic', 'c', '{}', 0, 0)");
      if (settings) db.prepare("INSERT INTO settings (key, value) VALUES ('settings', ?)").run(JSON.stringify(settings));
      db.exec(MIGRATIONS[limits]);
      const conn = db.prepare('SELECT five_hour_max, weekly_max FROM connections').get();
      const stored = db.prepare("SELECT value FROM settings WHERE key = 'settings'").get() as { value: string } | undefined;
      db.close();
      return { conn: { ...conn }, settings: stored ? JSON.parse(stored.value) : null };
    };
    expect(migrate({ mode: 'always', fiveHourMax: 55, weeklyMax: 65 })).toEqual({ conn: { five_hour_max: 55, weekly_max: 65 }, settings: { mode: 'always' } });
    expect(migrate(null)).toEqual({ conn: { five_hour_max: 70, weekly_max: 80 }, settings: null });
    expect(migrate({ mode: 'paused' })).toEqual({ conn: { five_hour_max: 70, weekly_max: 80 }, settings: { mode: 'paused' } });
  });
});

describe('code reviewer migration', () => {
  it("gives existing installs a Code reviewer with the Design adversary's model and billing", () => {
    const db = new DatabaseSync(':memory:');
    const at = MIGRATIONS.findIndex((m) => m.includes("SELECT 'code-review'"));
    for (const m of MIGRATIONS.slice(0, at)) db.exec(m);
    db.exec("INSERT INTO connections (kind, provider, name, config, created_at, updated_at) VALUES ('model', 'anthropic', 'c', '{}', 0, 0)");
    db.exec("INSERT INTO agent_classes (name, model, model_connection_id, effort, billing, max_turns, timeout_min) VALUES ('design-review', 'claude-opus-5-5', 1, 'high', 'api', 80, 45)");
    db.exec(MIGRATIONS[at]);
    const row = { ...db.prepare("SELECT * FROM agent_classes WHERE name = 'code-review'").get() };
    const columns = db.prepare('SELECT name FROM pragma_table_info(?)').all('tickets').map((c) => c.name);
    db.close();
    expect(row).toEqual({ name: 'code-review', model: 'claude-opus-5-5', model_connection_id: 1, effort: 'high', billing: 'api', prompt: null, max_turns: 150, timeout_min: 60 });
    expect(columns).toEqual(expect.arrayContaining(['handoff', 'rework']));
  });

  it('adds no row to a fresh database, so seeding gives the defaults', () => {
    const db = new DatabaseSync(':memory:');
    for (const m of MIGRATIONS) db.exec(m);
    expect(db.prepare("SELECT COUNT(*) AS n FROM agent_classes WHERE name = 'code-review'").get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('usage and launch', () => {
  it('reports usage with the caps', async () => {
    const res = await request(app).get('/api/usage').set('cookie', cookie);
    expect(res.body).toMatchObject({ allowance: [], apiSpendTodayUsd: 0 });
    expect(res.body).not.toHaveProperty('thresholds');
    const s = (await request(app).get('/api/settings').set('cookie', cookie)).body;
    expect(res.body).toMatchObject({ apiRunCapUsd: s.apiRunCapUsd, apiDailyCapUsd: s.apiDailyCapUsd });
  });

  it('accepts a refresh, which a read token may not ask for', async () => {
    const res = await request(app).post('/api/refresh').set('cookie', cookie);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true });
    const token = (await request(app).post('/api/tokens').set('cookie', cookie).send({ name: 'refresh', scope: 'read' })).body.token;
    expect((await request(app).post('/api/refresh').set('authorization', `Bearer ${token}`)).status).toBe(403);
  });

  it('refuses to launch what cannot run', async () => {
    const post = (id: number) => request(app).post(`/api/tickets/${id}/launch`).set('cookie', cookie);
    expect((await post(999)).status).toBe(404);

    const conn = createConnection('vcs', 'github', 'GitHub', { appId: 1, slug: 'bot', installations: [1] }, { privateKey: 'x' });
    run("INSERT INTO repos (vcs_connection_id, ticket_connection_id, full_name, default_branch, url, enabled) VALUES (?, ?, 'me/app', 'main', 'u', 1)", conn, conn);
    const repo = one<{ id: number }>('SELECT id FROM repos')!.id;
    const ticket = (labels: string[]) =>
      Number(run("INSERT INTO tickets (repo_id, number, title, body, url, author, state, labels, updated_at) VALUES (?, ?, 't', '', 'u', 'Damiante', 'open', ?, '2026-10-13T00:00:00Z')", repo, Math.floor(Math.random() * 1e6), JSON.stringify(labels)).lastInsertRowid);
    await request(app).put('/api/settings').set('cookie', cookie).send({ mode: 'paused' });

    const done = await post(ticket(['workshop/size:s', 'workshop/stage:pr-review']));
    expect(done.status).toBe(409);
    expect(done.body.error).toBe("There's nothing for an agent to do on this ticket right now.");

    // Paused doesn't matter; the missing agent host still does.
    const ready = await post(ticket(['workshop/size:s', 'workshop/stage:implement']));
    expect(ready.status).toBe(409);
    expect(ready.body.error).toMatch(/^Can't start an agent yet: /);
    expect(ready.body.error).not.toMatch(/paused/i);
  });
});

describe('repository priority', () => {
  it('is set through the repo settings and validated', async () => {
    const id = Number(run("INSERT INTO repos (vcs_connection_id, full_name, default_branch, url, enabled) VALUES (1, 'me/prio', 'main', 'u', 1)").lastInsertRowid);
    const put = (priority: unknown) => request(app).put(`/api/repos/${id}`).set('cookie', cookie).send({ priority });
    const ok = await put(3);
    expect(ok.status).toBe(200);
    expect(ok.body.priority).toBe(3);
    for (const bad of [1.5, 500]) {
      const res = await put(bad);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Priority must be a whole number from -100 to 100.');
    }
  });
});

describe('repository settings', () => {
  it('saves several fields at once, and none of them when one is rejected', async () => {
    const id = Number(run("INSERT INTO repos (vcs_connection_id, full_name, default_branch, url, enabled, selection) VALUES (1, 'me/settings', 'main', 'u', 1, 'nominated')").lastInsertRowid);
    const put = (body: object) => request(app).put(`/api/repos/${id}`).set('cookie', cookie).send(body);
    const ok = await put({ selection: 'all', priority: 2, image: 'ghcr.io/me/agent:1' });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ selection: 'all', priority: 2, image: 'ghcr.io/me/agent:1' });

    const bad = await put({ selection: 'nominated', image: 'not an image', priority: 5 });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('The image must be a Docker image reference.');
    const badPriority = await put({ selection: 'nominated', image: '', priority: 500 });
    expect(badPriority.status).toBe(400);
    const row = one<{ selection: string; priority: number; image: string | null }>('SELECT selection, priority, image FROM repos WHERE id = ?', id)!;
    expect(row).toEqual({ selection: 'all', priority: 2, image: 'ghcr.io/me/agent:1' });
  });
});

describe('Set up agent image', () => {
  it('opens a ticket for an agent, nominated when the repository needs that, and only one at a time', async () => {
    const conn = Number(run("INSERT INTO connections (kind, provider, name, config, secret, status, created_at, updated_at) VALUES ('tickets', 'github', 'Issues img', '{}', '', 'ok', 0, 0)").lastInsertRowid);
    const id = Number(run("INSERT INTO repos (vcs_connection_id, ticket_connection_id, full_name, default_branch, url, enabled, selection) VALUES (1, ?, 'me/android', 'main', 'u', 0, 'nominated')", conn).lastInsertRowid);
    fakeTickets.createTicket = vi.fn(async () => ({ number: 21, url: 'https://github.com/me/android/issues/21' }));
    const post = () => request(app).post(`/api/repos/${id}/image-ticket`).set('cookie', cookie).send({});

    expect((await post()).body.error).toBe('Turn the repository on first.');
    run('UPDATE repos SET enabled = 1 WHERE id = ?', id);
    const ok = await post();
    expect(ok.body).toEqual({ number: 21, url: 'https://github.com/me/android/issues/21' });
    const [, ticket] = fakeTickets.createTicket.mock.calls[0];
    expect(ticket).toMatchObject({ title: 'Set up a Workshop agent image for this repository', labels: ['workshop/nominated'] });
    expect(ticket.body).toContain('FROM ${WORKSHOP_BASE}');

    run("INSERT INTO tickets (repo_id, number, title, body, url, author, state, labels, updated_at) VALUES (?, 21, ?, '', 'u', 'bot[bot]', 'open', '[]', 'x')", id, ticket.title);
    const again = await post();
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('Ticket #21 already asks for an agent image.');
  });
});

describe('media', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]);
  let ticketId = 0;

  beforeAll(() => {
    const conn = Number(run("INSERT INTO connections (kind, provider, name, config, secret, status, created_at, updated_at) VALUES ('vcs', 'github', 'GH media', '{}', '', 'ok', 0, 0)").lastInsertRowid);
    const repo = Number(run("INSERT INTO repos (vcs_connection_id, full_name, default_branch, url, enabled) VALUES (?, 'me/media', 'main', 'u', 1)", conn).lastInsertRowid);
    ticketId = Number(run("INSERT INTO tickets (repo_id, number, title, body, url, author, state, labels, updated_at) VALUES (?, 5, 'Dark mode', '', 'u', 'Damiante', 'open', '[]', '2026-10-13T00:00:00Z')", repo).lastInsertRowid);
    fs.mkdirSync(mediaDir(ticketId), { recursive: true });
    fs.writeFileSync(path.join(mediaDir(ticketId), 'after.png'), PNG);
    run("INSERT INTO media (ticket_id, name, source, run_id, caption, size, created_at) VALUES (?, 'after.png', 'Implementation', 'r1', 'Dark', ?, 5)", ticketId, PNG.length);
  });

  it('needs sign-in', async () => {
    expect((await request(app).get(`/api/tickets/${ticketId}/media`)).status).toBe(401);
    expect((await request(app).get(`/api/tickets/${ticketId}/media/after.png`)).status).toBe(401);
  });

  it('lists the items', async () => {
    const res = await request(app).get(`/api/tickets/${ticketId}/media`).set('cookie', cookie);
    expect(res.body).toMatchObject({ ticketId, ticket: 'me/media#5', title: 'Dark mode' });
    expect(res.body.items).toEqual([{ name: 'after.png', source: 'Implementation', runId: 'r1', caption: 'Dark', size: PNG.length, createdAt: 5, url: `/api/tickets/${ticketId}/media/after.png` }]);
    expect((await request(app).get('/api/tickets/99999/media').set('cookie', cookie)).status).toBe(404);
    expect((await request(app).get('/api/tickets/abc/media').set('cookie', cookie)).status).toBe(400);
    const view = (await request(app).get('/api/tickets').set('cookie', cookie)).body.find((t: { id: number }) => t.id === ticketId);
    expect(view.mediaCount).toBe(1);
  });

  it('serves the file with its own type and safe headers', async () => {
    const res = await request(app).get(`/api/tickets/${ticketId}/media/after.png`).set('cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-disposition']).toMatch(/^inline/);
    expect(res.headers['cache-control']).toBe('private, no-cache'); // a replaced screenshot keeps its URL
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.body.equals(PNG)).toBe(true);
  });

  it('rejects bad names and unknown files', async () => {
    for (const name of ['a..png', '..%2Fx.png', '%2e%2e%2f%2e%2e%2fetc%2fpasswd', 'x.svg.png.']) {
      const res = await request(app).get(`/api/tickets/${ticketId}/media/${name}`).set('cookie', cookie);
      expect([400, 404]).toContain(res.status);
      expect(res.headers['content-type']).toMatch(/json/);
    }
    expect((await request(app).get(`/api/tickets/${ticketId}/media/a..png`).set('cookie', cookie)).status).toBe(400);
    expect((await request(app).get(`/api/tickets/${ticketId}/media/..%2Fx.png`).set('cookie', cookie)).status).toBe(400);
    expect((await request(app).get(`/api/tickets/${ticketId}/media/other.png`).set('cookie', cookie)).status).toBe(404);
  });
});

describe('ticket lifecycle', () => {
  let ticketId = 0;

  beforeAll(() => {
    const conn = Number(run("INSERT INTO connections (kind, provider, name, config, secret, status, created_at, updated_at) VALUES ('vcs', 'github', 'GH life', '{}', '', 'ok', 0, 0)").lastInsertRowid);
    const repo = Number(run("INSERT INTO repos (vcs_connection_id, full_name, default_branch, url, enabled) VALUES (?, 'me/life', 'main', 'u', 1)", conn).lastInsertRowid);
    ticketId = Number(run("INSERT INTO tickets (repo_id, number, title, body, url, author, state, labels, updated_at) VALUES (?, 9, 'Lifecycle', '', 'u', 'Damiante', 'closed', '[]', '2026-10-13T00:00:00Z')", repo).lastInsertRowid);
    const ins = "INSERT INTO runs (id, ticket_id, agent, mode, attempt, model, billing, status, summary, started_at) VALUES (?, ?, ?, ?, 1, 'm', 'subscription', 'succeeded', ?, ?)";
    run(ins, 'l-3', ticketId, 'classifier', 'delta', 'Sized S', 30);
    run(ins, 'l-1', ticketId, 'classifier', 'normal', 'Sized M', 10);
    run(ins, 'l-2', ticketId, 'implement', 'normal', 'Built it', 20);
    run("INSERT INTO media (ticket_id, name, source, run_id, caption, size, created_at) VALUES (?, 'shot.png', 'Implementation', 'l-2', NULL, 3, 5)", ticketId);
  });

  it('needs sign-in', async () => {
    expect((await request(app).get(`/api/tickets/${ticketId}`)).status).toBe(401);
  });

  it('returns a closed ticket with its runs oldest first and its media', async () => {
    const res = await request(app).get(`/api/tickets/${ticketId}`).set('cookie', cookie);
    expect(res.status).toBe(200);
    expect(res.body.ticket).toMatchObject({ id: ticketId, state: 'closed', mediaCount: 1 });
    expect(res.body.runs.map((r: { id: string }) => r.id)).toEqual(['l-1', 'l-2', 'l-3']);
    expect(res.body.runs.map((r: { agent: string; mode: string; summary: string }) => [r.agent, r.mode, r.summary])).toEqual([
      ['classifier', 'normal', 'Sized M'],
      ['implement', 'normal', 'Built it'],
      ['classifier', 'delta', 'Sized S'],
    ]);
    expect(res.body.media).toMatchObject([{ name: 'shot.png', runId: 'l-2' }]);
    expect(Object.keys(res.body).sort()).toEqual(Object.keys((OPENAPI.components.schemas.TicketLifecycle as { properties: object }).properties).sort());
  });

  it('rejects bad and unknown ids', async () => {
    expect((await request(app).get('/api/tickets/abc').set('cookie', cookie)).status).toBe(400);
    expect((await request(app).get('/api/tickets/99999').set('cookie', cookie)).status).toBe(404);
  });
});

describe('OpenAPI', () => {
  const routes = (apiRouter.stack as unknown as { route?: { path: string; methods: Record<string, boolean> } }[])
    .filter((l) => l.route)
    .flatMap((l) => Object.keys(l.route!.methods).map((m) => `${m} ${l.route!.path.replace(/:(\w+)/g, '{$1}')}`));
  const documented = Object.entries(OPENAPI.paths).flatMap(([path, ops]) => Object.keys(ops).map((m) => `${m} ${path}`));

  it('documents every route and nothing else', () => {
    expect(documented.sort()).toEqual(routes.sort());
  });

  it('is served', async () => {
    const res = await request(app).get('/api/openapi.json').set('cookie', cookie);
    expect(res.body.openapi).toBe('3.1.0');
  });

  it.each([
    ['/overview', 'Overview'],
    ['/settings', 'Settings'],
    ['/usage', 'Usage'],
    ['/usage/lifetime', 'LifetimeSpend'],
    ['/usage/history?range=all', 'UsageHistory'],
  ])('%s matches its schema fields', async (path, name) => {
    const res = await request(app).get(`/api${path}`).set('cookie', cookie);
    const props = Object.keys((OPENAPI.components.schemas[name] as { properties: object }).properties);
    expect(Object.keys(res.body).sort()).toEqual(props.sort());
  });

  it('describes the ticket state request body', () => {
    const op = OPENAPI.paths['/tickets/{id}/state'].put as { requestBody: { content: Record<string, { schema: unknown }> } };
    expect(Object.values(op.requestBody.content)[0].schema).toEqual({ $ref: '#/components/schemas/TicketStatePatch' });
    const patch = OPENAPI.components.schemas.TicketStatePatch as { properties: object; required: string[] };
    expect(Object.keys(patch.properties).sort()).toEqual(['failed', 'needsInfo', 'size', 'skip', 'stage']);
    expect(patch.required).toEqual([]);
  });

  it('/agents matches its schema fields', async () => {
    const res = await request(app).get('/api/agents').set('cookie', cookie);
    const props = Object.keys((OPENAPI.components.schemas.AgentClassView as { properties: object }).properties);
    expect(Object.keys(res.body[0]).sort()).toEqual(props.sort());
  });
});

describe('lockout', () => {
  it('locks sign-in after 5 failures', async () => {
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').send({ password: 'wrong' });
    const res = await request(app).post('/api/auth/login').send({ password: PASSWORD, code: '000000' });
    expect(res.status).toBe(429);
    expect(res.body.error).toMatch(/Try again in 15 minutes/);
  });
});

describe('pushing a ticket by hand', () => {
  const push = (id: number | string, scope?: string) => request(app).post(`/api/tickets/${id}/push`).set('cookie', cookie).send({ scope });

  it('validates, refuses what cannot run, then sets and cancels a push', async () => {
    const { run } = await import('../src/db.ts');
    run("INSERT INTO connections (kind, provider, name, config, secret, status, created_at, updated_at) VALUES ('vcs', 'github', 'GitHub', '{}', '', 'ok', 0, 0)");
    run("INSERT INTO repos (vcs_connection_id, full_name, default_branch, url, enabled) VALUES (1, 'me/pushed', 'main', 'u', 1)");
    await request(app).put('/api/settings').set('cookie', cookie).send({ authors: ['me'] });
    run("INSERT INTO tickets (repo_id, number, title, body, url, author, state, labels, updated_at) VALUES (1, 4, 'T', '', 'u', 'me', 'open', '[\"workshop/stage:implement\"]', 'x')");
    const id = (await import('../src/db.ts')).one<{ id: number }>('SELECT id FROM tickets WHERE number = 4')!.id;

    expect((await push(id, 'sideways')).status).toBe(400);
    expect((await push(9999, 'stage')).status).toBe(404);

    const ok = await push(id, 'lifecycle');
    expect(ok.status).toBe(200);
    expect(ok.body.push).toBe('lifecycle');

    const cleared = await request(app).delete(`/api/tickets/${id}/push`).set('cookie', cookie);
    expect(cleared.body.push).toBeNull();

    run("UPDATE tickets SET labels = '[\"workshop/stage:pr-review\"]' WHERE id = ?", id);
    const refused = await push(id, 'stage');
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/waiting for your review/);
  });
});

describe('agent host availability', () => {
  it('switches a host off and on, and reports it in the overview', async () => {
    const { run, one } = await import('../src/db.ts');
    run("INSERT INTO connections (kind, provider, name, config, secret, status, created_at, updated_at) VALUES ('environment', 'docker', 'Box', '{\"slots\":2}', '', 'ok', 0, 0)");
    const id = one<{ id: number }>("SELECT id FROM connections WHERE name = 'Box'")!.id;
    const put = (body: object, c: string | null = cookie) => request(app).put(`/api/hosts/${id}`).set('cookie', c ?? '').send(body);

    const hosts = async () => (await request(app).get('/api/overview').set('cookie', cookie)).body.hosts;
    expect(await hosts()).toMatchObject([{ id, available: true, slots: 2 }]);

    const off = await put({ available: false });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ id, available: false, status: 'ok', slots: 2 });
    expect(await hosts()).toMatchObject([{ id, available: false }]);
    expect((await put({ available: true })).body.available).toBe(true);

    expect((await put({ available: 'no' })).status).toBe(400);
    expect((await request(app).put('/api/hosts/9999').set('cookie', cookie).send({ available: false })).status).toBe(404);
    expect((await request(app).put('/api/hosts/1').set('cookie', cookie).send({ available: false })).status).toBe(404);
  });
});

describe('AI model order', () => {
  it('puts Claude connections in your order and refuses an incomplete list', async () => {
    const { run, all } = await import('../src/db.ts');
    const add = (name: string, position: number) =>
      Number(run("INSERT INTO connections (kind, provider, name, config, secret, status, created_at, updated_at, position) VALUES ('model', 'anthropic', ?, '{}', '', 'ok', 0, 0, ?)", name, position).lastInsertRowid);
    const ids = all<{ id: number }>("SELECT id FROM connections WHERE kind = 'model'").map((r) => r.id);
    const a = add('First', 100);
    const b = add('Second', 101);
    const put = (body: object) => request(app).put('/api/connections/order').set('cookie', cookie).send(body);
    const names = async () => ((await request(app).get('/api/connections').set('cookie', cookie)).body as { kind: string; name: string }[]).filter((c) => c.kind === 'model').map((c) => c.name);

    expect((await names()).slice(-2)).toEqual(['First', 'Second']);
    expect((await put({ ids: [b, a, ...ids] })).status).toBe(200);
    expect((await names()).slice(0, 2)).toEqual(['Second', 'First']);
    for (const bad of [[b], [b, a, a, ...ids], [b, a, 9999, ...ids], 'x']) {
      const res = await put({ ids: bad });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('List every AI model connection exactly once.');
    }
    run('DELETE FROM connections WHERE id IN (?, ?)', a, b);
  });
});

describe('pausing an AI model connection', () => {
  it('pauses and resumes a Claude connection, keeping its settings', async () => {
    const { run, one } = await import('../src/db.ts');
    const id = Number(run("INSERT INTO connections (kind, provider, name, config, secret, status, created_at, updated_at) VALUES ('model', 'anthropic', 'Spare', '{\"x\":1}', '', 'ok', 0, 0)").lastInsertRowid);
    const put = (target: number, body: object) => request(app).put(`/api/connections/${target}/paused`).set('cookie', cookie).send(body);

    const paused = await put(id, { paused: true });
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({ id, paused: true, config: { x: 1 } });
    expect(one<{ paused: number }>('SELECT paused FROM connections WHERE id = ?', id)!.paused).toBe(1);
    expect((await put(id, { paused: false })).body.paused).toBe(false);
    expect((await put(id, { paused: 'yes' })).body.error).toBe('paused must be true or false.');
    const host = one<{ id: number }>("SELECT id FROM connections WHERE kind = 'environment'");
    if (host) expect((await put(host.id, { paused: true })).status).toBe(404);
    expect((await put(999999, { paused: true })).status).toBe(404);
    run('DELETE FROM connections WHERE id = ?', id);
  });
});

describe("changing a ticket's status", () => {
  const put = (id: number | string, body: object) => request(app).put(`/api/tickets/${id}/state`).set('cookie', cookie).send(body);
  const labelsIn = (id: number) => JSON.parse(one<{ labels: string }>('SELECT labels FROM tickets WHERE id = ?', id)!.labels) as string[];
  let id = 0;

  beforeAll(() => {
    run("INSERT INTO connections (kind, provider, name, config, secret, status, created_at, updated_at) VALUES ('tickets', 'github', 'Issues', '{}', '', 'ok', 0, 0)");
    const conn = one<{ id: number }>("SELECT id FROM connections WHERE kind = 'tickets'")!.id;
    run("INSERT INTO repos (vcs_connection_id, ticket_connection_id, full_name, default_branch, url, enabled) VALUES (1, ?, 'me/state', 'main', 'u', 1)", conn);
    const repo = one<{ id: number }>("SELECT id FROM repos WHERE full_name = 'me/state'")!.id;
    run(
      "INSERT INTO tickets (repo_id, number, title, body, url, author, state, labels, failures, updated_at) VALUES (?, 50, 'T', '', 'u', 'me', 'open', ?, 2, 'x')",
      repo,
      JSON.stringify(['bug', 'workshop/stage:design', 'workshop/size:m', 'workshop/failed', 'workshop/running']),
    );
    id = one<{ id: number }>('SELECT id FROM tickets WHERE number = 50')!.id;
  });

  it('validates the body and the ticket', async () => {
    fakeTickets.setLabels = vi.fn();
    expect((await put(id, { stage: 'nowhere' })).status).toBe(400);
    expect((await put(id, { size: 'huge' })).status).toBe(400);
    expect((await put(id, { skip: 'yes' })).status).toBe(400);
    expect((await put(id, {})).status).toBe(400);
    expect((await put(9999, { skip: true })).status).toBe(404);
    expect(fakeTickets.setLabels).not.toHaveBeenCalled();
  });

  it('lists runs waiting to publish apart from the running ones', async () => {
    run("INSERT INTO runs (id, ticket_id, agent, attempt, model, billing, status, publish_retry_at, started_at) VALUES ('r-wait', ?, 'design', 1, 'm', 'subscription', 'publishing', 123, 0)", id);
    try {
      const res = await request(app).get('/api/overview').set('cookie', cookie);
      expect(res.body.running.map((r: { id: string }) => r.id)).not.toContain('r-wait');
      expect(res.body.publishWaiting).toMatchObject([{ id: 'r-wait', publishRetryAt: 123 }]);
    } finally {
      run("DELETE FROM runs WHERE id = 'r-wait'");
    }
  });

  it('refuses while an agent works on the ticket', async () => {
    fakeTickets.setLabels = vi.fn();
    run("INSERT INTO runs (id, ticket_id, agent, attempt, model, billing, status, started_at) VALUES ('r-state', ?, 'design', 1, 'm', 'subscription', 'running', 0)", id);
    const res = await put(id, { skip: true });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Stop it in the run view first/);
    expect(fakeTickets.setLabels).not.toHaveBeenCalled();
    run("UPDATE runs SET status = 'failed' WHERE id = 'r-state'");
  });

  it('turns a GitHub failure into a readable 502 and changes nothing locally', async () => {
    fakeTickets.setLabels = vi.fn().mockRejectedValue(new Error('rate limited'));
    const before = labelsIn(id);
    const res = await put(id, { skip: true });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Couldn't update the labels on GitHub: rate limited/);
    expect(labelsIn(id)).toEqual(before);
  });

  it('changes labels on GitHub, mirrors them, and resets attempts when failed is cleared', async () => {
    fakeTickets.setLabels = vi.fn().mockResolvedValue(undefined);
    const res = await put(id, { stage: 'merge', size: 'l', failed: false });
    expect(res.status).toBe(200);
    const [, number, add, remove] = fakeTickets.setLabels.mock.calls[0];
    expect(number).toBe(50);
    expect([...add].sort()).toEqual(['workshop/size:l', 'workshop/stage:merge']);
    expect([...remove].sort()).toEqual(['workshop/failed', 'workshop/size:m', 'workshop/stage:design']);
    expect(res.body).toMatchObject({ stage: 'merge', size: 'l', failed: false });
    expect(labelsIn(id).sort()).toEqual(['bug', 'workshop/running', 'workshop/size:l', 'workshop/stage:merge']);
    expect(one<{ failures: number }>('SELECT failures FROM tickets WHERE id = ?', id)!.failures).toBe(0);
  });

  it('clears the stored rescue when the ticket leaves reconcile', async () => {
    fakeTickets.setLabels = vi.fn().mockResolvedValue(undefined);
    run("UPDATE tickets SET labels = ?, rescue = '{\"branch\":\"b\"}' WHERE id = ?", JSON.stringify(['workshop/stage:reconcile']), id);
    expect((await put(id, { stage: 'implement' })).status).toBe(200);
    expect(one<{ rescue: string | null }>('SELECT rescue FROM tickets WHERE id = ?', id)!.rescue).toBeNull();
  });

  it('refuses reconcile when there is no saved work to merge', async () => {
    fakeTickets.setLabels = vi.fn().mockResolvedValue(undefined);
    const res = await put(id, { stage: 'reconcile' });
    expect(res.status).toBe(400);
    expect(fakeTickets.setLabels).not.toHaveBeenCalled();
  });

  it('keeps a read-only token out', async () => {
    const made = await request(app).post('/api/tokens').set('cookie', cookie).send({ name: 'RO', scope: 'read' });
    const res = await request(app).put(`/api/tickets/${id}/state`).set('authorization', `Bearer ${made.body.token}`).send({ skip: true });
    expect(res.status).toBe(403);
  });
});

describe('nominating tickets', () => {
  it('validates the setting and refuses tickets that are not nominated', async () => {
    const { run, one } = await import('../src/db.ts');
    const id = one<{ id: number }>('SELECT id FROM tickets WHERE number = 4')!.id;
    run("UPDATE tickets SET labels = '[\"workshop/stage:implement\"]' WHERE id = ?", id);
    const nominate = (body: object) => request(app).put(`/api/tickets/${id}/nominated`).set('cookie', cookie).send(body);

    expect((await request(app).put('/api/repos/1').set('cookie', cookie).send({ selection: 'bad' })).status).toBe(400);
    expect((await nominate({ nominated: 'yes' })).status).toBe(400);
    expect((await nominate({ nominated: true })).status).toBe(409);

    run("UPDATE repos SET selection = 'nominated' WHERE id = 1");
    const refused = await request(app).post(`/api/tickets/${id}/push`).set('cookie', cookie).send({ scope: 'stage' });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toMatch(/Nominate this ticket first/);
  });
});

describe('dismissing Needs you items', () => {
  it('hides an item until the reason it needs you changes', async () => {
    const { run, one } = await import('../src/db.ts');
    const id = one<{ id: number }>('SELECT id FROM tickets WHERE number = 4')!.id;
    const setLabels = (labels: string[]) => run('UPDATE tickets SET labels = ? WHERE id = ?', JSON.stringify(labels), id);
    const dismiss = (body: object) => request(app).put(`/api/tickets/${id}/dismissed`).set('cookie', cookie).send(body);
    const lists = async () => {
      const o = (await request(app).get('/api/overview').set('cookie', cookie)).body;
      const has = (l: { id: number }[]) => l.some((t) => t.id === id);
      return { needs: has(o.needsYou), dismissed: has(o.dismissed) };
    };
    const addRun = (rid: string, at: number) =>
      run("INSERT INTO runs (id, ticket_id, agent, attempt, model, billing, status, started_at) VALUES (?, ?, 'design', 1, 'm', 'subscription', 'failed', ?)", rid, id, at);

    setLabels(['workshop/stage:implement']);
    expect((await dismiss({ dismissed: true })).status).toBe(409);
    expect((await dismiss({ dismissed: 'yes' })).status).toBe(400);
    expect((await request(app).put('/api/tickets/99999/dismissed').set('cookie', cookie).send({ dismissed: true })).status).toBe(404);
    expect(await lists()).toEqual({ needs: false, dismissed: false });

    setLabels(['workshop/stage:implement', 'workshop/needs-info']);
    expect(await lists()).toEqual({ needs: true, dismissed: false });
    const res = await dismiss({ dismissed: true });
    expect(res.body).toMatchObject({ dismissed: true, attention: 'question' });
    expect(await lists()).toEqual({ needs: false, dismissed: true });
    expect((await dismiss({ dismissed: false })).body.dismissed).toBe(false);
    expect(await lists()).toEqual({ needs: true, dismissed: false });

    // Stays dismissed after an unrelated label edit.
    await dismiss({ dismissed: true });
    setLabels(['workshop/stage:implement', 'workshop/needs-info', 'bug']);
    expect(await lists()).toEqual({ needs: false, dismissed: true });

    // A different reason brings it back.
    setLabels(['workshop/stage:implement', 'workshop/failed']);
    expect(await lists()).toEqual({ needs: true, dismissed: false });

    // A new run brings it back.
    await dismiss({ dismissed: true });
    expect(await lists()).toEqual({ needs: false, dismissed: true });
    addRun('r-dismiss-1', 9_000_000_000_000);
    expect(await lists()).toEqual({ needs: true, dismissed: false });

    // Review: dismissed, then a new revision.
    setLabels(['workshop/stage:pr-review']);
    await dismiss({ dismissed: true });
    expect(await lists()).toEqual({ needs: false, dismissed: true });
    addRun('r-dismiss-2', 9_000_000_000_001);
    expect(await lists()).toEqual({ needs: true, dismissed: false });

    // Leaving Needs you removes it from both lists.
    await dismiss({ dismissed: true });
    setLabels(['workshop/stage:implement']);
    expect(await lists()).toEqual({ needs: false, dismissed: false });
    run("DELETE FROM runs WHERE id LIKE 'r-dismiss-%'");
  });
});

describe('prioritising a ticket', () => {
  it('sets and removes priority, and refuses closed tickets', async () => {
    const { run, one } = await import('../src/db.ts');
    const id = one<{ id: number }>('SELECT id FROM tickets WHERE number = 4')!.id;
    const prioritise = (body: object, tid: number = id) => request(app).put(`/api/tickets/${tid}/prioritised`).set('cookie', cookie).send(body);

    expect((await prioritise({ prioritised: 'yes' })).status).toBe(400);
    expect((await prioritise({ prioritised: true }, 99999)).status).toBe(404);
    run("UPDATE repos SET selection = 'nominated' WHERE id = 1");
    expect((await prioritise({ prioritised: true })).body.error).toMatch(/Nominate this ticket first/);
    run("UPDATE repos SET selection = 'all' WHERE id = 1");
    const on = await prioritise({ prioritised: true });
    expect(on.status).toBe(200);
    expect(on.body.prioritised).toBe(true);
    const queue = (await request(app).get('/api/overview').set('cookie', cookie)).body.queue as { ticketId: number; prioritised: boolean }[];
    expect(queue.find((q) => q.ticketId === id)?.prioritised ?? true).toBe(true);
    const off = await prioritise({ prioritised: false });
    expect(off.status).toBe(200);
    expect(off.body.prioritised).toBe(false);

    run("UPDATE tickets SET state = 'closed', prioritised = 1 WHERE id = ?", id);
    try {
      const refused = await prioritise({ prioritised: true });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('This ticket is closed.');
      const removed = await prioritise({ prioritised: false });
      expect(removed.status).toBe(200);
      expect(removed.body.prioritised).toBe(false);
    } finally {
      run("UPDATE tickets SET state = 'open', prioritised = 0 WHERE id = ?", id);
    }
  });

  it('shows what a prioritised ticket depends on, and that those go first for it', async () => {
    const { run } = await import('../src/db.ts');
    const add = (number: number, blockedBy: string[]) =>
      Number(
        run("INSERT INTO tickets (repo_id, number, title, body, url, author, state, labels, blocked_by, updated_at) VALUES (1, ?, 'T', '', 'u', 'me', 'open', '[]', ?, '2026-10-13T00:00:00Z')", number, JSON.stringify(blockedBy)).lastInsertRowid,
      );
    const a = add(50, []);
    const b = add(51, ['#50']);
    try {
      expect((await request(app).put(`/api/tickets/${b}/prioritised`).set('cookie', cookie).send({ prioritised: true })).status).toBe(200);
      const ticket = async (id: number) => (await request(app).get(`/api/tickets/${id}`).set('cookie', cookie)).body.ticket;
      expect((await ticket(a)).prioritisedFor).toEqual([{ ref: '#51', ticketId: b }]);
      expect((await ticket(a)).prioritised).toBe(false);
      expect((await ticket(b)).dependsOn).toEqual([{ ref: '#50', ticketId: a }]);
      expect((await ticket(b)).prioritisedFor).toEqual([]);
      const queue = (await request(app).get('/api/overview').set('cookie', cookie)).body.queue as { ticketId: number; prioritisedFor: string[] }[];
      expect(queue.some((q) => q.ticketId === a)).toBe(true);
      for (const q of queue) expect(q.prioritisedFor).toEqual(q.ticketId === a ? ['#51'] : []);
      expect((await request(app).put(`/api/tickets/${b}/prioritised`).set('cookie', cookie).send({ prioritised: false })).status).toBe(200);
      expect((await ticket(a)).prioritisedFor).toEqual([]);
    } finally {
      run('DELETE FROM tickets WHERE id IN (?, ?)', a, b);
    }
  });
});

describe('ignoring usage limits for a ticket', () => {
  it('sets and removes the flag, and refuses closed tickets', async () => {
    const id = one<{ id: number }>('SELECT id FROM tickets WHERE number = 4')!.id;
    const bypass = (body: object, tid: number = id) => request(app).put(`/api/tickets/${tid}/bypass-limits`).set('cookie', cookie).send(body);

    expect((await bypass({ bypassLimits: 'yes' })).status).toBe(400);
    expect((await bypass({ bypassLimits: true }, 99999)).status).toBe(404);
    run("UPDATE repos SET selection = 'nominated' WHERE id = 1");
    expect((await bypass({ bypassLimits: true })).body.error).toMatch(/Nominate this ticket first/);
    run("UPDATE repos SET selection = 'all' WHERE id = 1");
    const on = await bypass({ bypassLimits: true });
    expect(on.status).toBe(200);
    expect(on.body.bypassLimits).toBe(true);
    const queue = (await request(app).get('/api/overview').set('cookie', cookie)).body.queue as { ticketId: number; bypassLimits: boolean }[];
    expect(queue.find((q) => q.ticketId === id)?.bypassLimits ?? true).toBe(true);
    const off = await bypass({ bypassLimits: false });
    expect(off.status).toBe(200);
    expect(off.body.bypassLimits).toBe(false);

    run("UPDATE tickets SET state = 'closed', bypass_limits = 1 WHERE id = ?", id);
    try {
      const refused = await bypass({ bypassLimits: true });
      expect(refused.status).toBe(409);
      expect(refused.body.error).toBe('This ticket is closed.');
      const removed = await bypass({ bypassLimits: false });
      expect(removed.status).toBe(200);
      expect(removed.body.bypassLimits).toBe(false);
    } finally {
      run("UPDATE tickets SET state = 'open', bypass_limits = 0 WHERE id = ?", id);
    }
  });
});

describe('alert links', () => {
  it('points run and ticket alerts at a run, and leaves other alerts unlinked', async () => {
    const tid = one<{ id: number }>('SELECT id FROM tickets WHERE number = 4')!.id;
    run("INSERT INTO runs (id, ticket_id, agent, attempt, model, billing, status, started_at) VALUES ('r-old', ?, 'design', 1, 'm', 'subscription', 'failed', 1)", tid);
    run("INSERT INTO runs (id, ticket_id, agent, attempt, model, billing, status, started_at) VALUES ('r-new', ?, 'design', 2, 'm', 'subscription', 'failed', 2)", tid);
    for (const [kind, ref] of [['run-detached', 'run:r-old'], ['ticket-failed', `ticket:${tid}`], ['host-offline', 'host:1'], ['gone', 'run:missing']]) {
      run("INSERT INTO alerts (level, kind, message, ref, created_at) VALUES ('error', ?, 'm', ?, 0)", kind, ref);
    }
    const res = await request(app).get('/api/alerts').set('cookie', cookie);
    const byKind = Object.fromEntries(res.body.map((a: { kind: string; runId: string | null }) => [a.kind, a.runId]));
    expect(byKind).toMatchObject({ 'run-detached': 'r-old', 'ticket-failed': 'r-new', 'host-offline': null, gone: null });
  });
});

describe('live streams', () => {
  let base = '';
  let server: ReturnType<typeof app.listen>;
  let ticket = 0;
  beforeAll(async () => {
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    const conn = createConnection('vcs', 'github', 'live', { appId: '1' }, {});
    const repo = Number(run("INSERT INTO repos (vcs_connection_id, full_name, default_branch, url, enabled) VALUES (?, 'me/live', 'main', 'u', 1)", conn).lastInsertRowid);
    ticket = Number(run("INSERT INTO tickets (repo_id, number, title, body, url, author, state, labels, updated_at) VALUES (?, 1, 't', '', 'u', 'Damiante', 'open', '[]', '2026-10-13T00:00:00Z')", repo).lastInsertRowid);
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  const addRun = (id: string, status: string, lines: number) => {
    run("INSERT INTO runs (id, ticket_id, agent, attempt, model, billing, status, started_at) VALUES (?, ?, 'design', 1, 'm', 'subscription', ?, 0)", id, ticket, status);
    for (let i = 0; i < lines; i++) appendLog(id, { step: 'run', stream: 'stdout', text: `line ${i}` });
  };
  const open = async (path: string) => {
    const ctl = new AbortController();
    const res = await fetch(base + path, { headers: { cookie }, signal: ctl.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let pending: ReturnType<typeof reader.read> | undefined;
    return {
      res,
      abort: () => ctl.abort(),
      /** Reads until the stream ends or `until` matches; returns what was read. */
      async read(until?: RegExp) {
        let text = '';
        for (;;) {
          pending ??= reader.read(); // a read that timed out is kept, so it doesn't swallow the next chunk
          const part = await Promise.race([pending, new Promise<null>((r) => setTimeout(() => r(null), 300))]);
          if (!part) return { text, ended: false };
          pending = undefined;
          if (part.done) return { text, ended: true };
          text += decoder.decode(part.value);
          if (until?.test(text)) return { text, ended: false };
        }
      },
    };
  };

  it('forbids caching API responses', async () => {
    expect((await request(app).get('/api/overview').set('cookie', cookie)).headers['cache-control']).toBe('no-store');
  });

  it('sends a visible ping when the event stream opens', async () => {
    const s = await open('/events');
    expect(s.res.headers.get('content-type')).toBe('text/event-stream');
    expect(s.res.headers.get('cache-control')).toContain('no-transform');
    expect((await s.read(/event: ping/)).text).toContain('event: ping\ndata: {}');
    publish('runs');
    expect((await s.read(/"runs"/)).text).toContain('data: {"topic":"runs"}');
    s.abort();
  });

  it('replays a finished run log, then ends the stream', async () => {
    addRun('live-done', 'succeeded', 2);
    const s = await open('/runs/live-done/log');
    const { text, ended } = await s.read();
    expect(text).toContain('line 0');
    expect(text).toContain('line 1');
    expect(text.trimEnd().endsWith('data: {}')).toBe(true);
    expect(text).toContain('event: end');
    expect(ended).toBe(true);
  });

  it('exports a run log as a JSON Lines download', async () => {
    const res = await request(app).get('/api/runs/live-done/export').set('cookie', cookie).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toContain('workshop-run-live-done.jsonl');
    const lines = res.body.toString().trim().split('\n').map((l: string) => JSON.parse(l));
    expect(lines.map((l: { text: string }) => l.text)).toEqual(['line 0', 'line 1']);
    expect((await request(app).get('/api/runs/nope/export').set('cookie', cookie)).status).toBe(404);
  });

  it('drops image data from over-long log lines so they stay readable', async () => {
    run("INSERT INTO runs (id, ticket_id, agent, attempt, model, billing, status, started_at) VALUES ('live-image', ?, 'design', 1, 'm', 'subscription', 'done', 0)", ticket);
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(100_000) } };
    const event = { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [image] }] }, tool_use_result: { file: { base64: 'B'.repeat(100_000) } } };
    appendLog('live-image', { step: 'run', stream: 'stdout', text: JSON.stringify(event) });
    appendLog('live-image', { step: 'run', stream: 'stdout', text: 'x'.repeat(70_000) });
    const [kept, cut] = readLog('live-image');
    expect(JSON.parse(kept.text)).toMatchObject({ message: { content: [{ content: [{ source: { media_type: 'image/png', data: '' } }] }] }, tool_use_result: { file: { base64: '' } } });
    expect(cut.text).toMatch(/…\[truncated by Workshop\]$/);
  });

  it('resumes from ?after= and Last-Event-ID', async () => {
    const a = await (await open('/runs/live-done/log?after=0')).read();
    expect(a.text).not.toContain('line 0');
    expect(a.text).toContain('line 1');
    const ctl = await fetch(`${base}/runs/live-done/log?after=0`, { headers: { cookie, 'last-event-id': '1' } });
    expect(await ctl.text()).not.toContain('line 1');
    const junk = await (await open('/runs/live-done/log?after=abc')).read();
    expect(junk.text).toContain('line 0');
  });

  it('keeps an active run log open, then ends it when the run finishes', async () => {
    addRun('live-active', 'running', 1);
    const s = await open('/runs/live-active/log');
    const first = await s.read();
    expect(first.text).toContain('line 0');
    expect(first.ended).toBe(false);
    appendLog('live-active', { step: 'run', stream: 'stdout', text: 'tail' });
    run("UPDATE runs SET status = 'succeeded' WHERE id = 'live-active'");
    publish('runs');
    const rest = await s.read();
    expect(rest.text).toContain('tail');
    expect(rest.text).toContain('event: end');
    expect(rest.ended).toBe(true);
  });
});

describe('repository enrolment', () => {
  it('moves disabled repositories to nominated tickets and leaves enabled ones alone', async () => {
    const { MIGRATIONS } = await import('../src/db.ts');
    const add = (name: string, enabled: number) => Number(run('INSERT INTO repos (vcs_connection_id, full_name, default_branch, url, enabled) VALUES (1, ?, ?, ?, ?)', name, 'main', 'u', enabled).lastInsertRowid);
    const off = add('me/off', 0);
    const on = add('me/on', 1);
    run(MIGRATIONS.find((m) => m.startsWith("UPDATE repos SET selection = 'nominated'"))!);
    expect(one<{ selection: string }>('SELECT selection FROM repos WHERE id = ?', off)?.selection).toBe('nominated');
    expect(one<{ selection: string }>('SELECT selection FROM repos WHERE id = ?', on)?.selection).toBe('all');
  });
});

describe('merge without review', () => {
  let id = 0;
  beforeAll(() => {
    const conn = Number(run("INSERT INTO connections (kind, provider, name, config, secret, status, created_at, updated_at) VALUES ('vcs', 'github', 'GH merge', '{}', '', 'ok', 0, 0)").lastInsertRowid);
    id = Number(run("INSERT INTO repos (vcs_connection_id, full_name, default_branch, url, enabled) VALUES (?, 'me/overnight', 'main', 'u', 0)", conn).lastInsertRowid);
  });
  const put = (mergeWithoutReview: unknown) => request(app).put(`/api/repos/${id}`).set('cookie', cookie).send({ mergeWithoutReview });
  const row = () => one<{ merge_without_review: number; merge_warning: string | null }>('SELECT merge_without_review, merge_warning FROM repos WHERE id = ?', id)!;
  const rules = (over: object) => vi.fn(async () => ({ reviewRequired: false, checksRequired: true, unknown: [], ...over }));

  it('is refused when an approving review is required', async () => {
    fakeVcs.mergeRules = rules({ reviewRequired: true });
    const res = await put(true);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/^main requires an approving review/);
    expect(res.body.error).toContain('add the App as a bypass actor');
    expect(row().merge_without_review).toBe(0);
  });

  it('is turned on without a warning when the branch requires checks and no review', async () => {
    fakeVcs.mergeRules = rules({});
    const res = await put(true);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mergeWithoutReview: true, mergeWarning: null });
  });

  it('warns when no status checks are required', async () => {
    fakeVcs.mergeRules = rules({ checksRequired: false });
    const res = await put(true);
    expect(res.status).toBe(200);
    expect(res.body.mergeWithoutReview).toBe(true);
    expect(res.body.mergeWarning).toMatch(/^No status checks are required on main, so failing CI won't stop a merge\./);
    expect(row().merge_warning).toBe(res.body.mergeWarning);
  });

  it('warns about what it couldn\'t check', async () => {
    fakeVcs.mergeRules = rules({ unknown: ["the review settings of main's branch protection"] });
    const res = await put(true);
    expect(res.status).toBe(200);
    expect(res.body.mergeWarning).toBe(
      "Workshop couldn't check the review settings of main's branch protection. If that requires an approving review, pull requests will wait in merge until you approve them.",
    );
  });

  it('warns when the rules can\'t be read at all', async () => {
    fakeVcs.mergeRules = vi.fn(async () => {
      throw new Error('Resource not accessible by integration');
    });
    const res = await put(true);
    expect(res.status).toBe(200);
    expect(res.body.mergeWarning).toMatch(/^Workshop couldn't read the rules for main \(Resource not accessible by integration\)\./);
  });

  it('is turned off without a check, clearing the warning', async () => {
    run("UPDATE repos SET merge_without_review = 1, merge_warning = 'old' WHERE id = ?", id);
    fakeVcs.mergeRules = rules({});
    const res = await put(false);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mergeWithoutReview: false, mergeWarning: null });
    expect(row()).toEqual({ merge_without_review: 0, merge_warning: null });
    expect(fakeVcs.mergeRules).not.toHaveBeenCalled();
  });

  it('must be true or false', async () => {
    const res = await put('yes');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Say whether to merge without review.');
  });
});

describe('pausing and resuming a run', () => {
  const post = (id: string, action: 'pause' | 'resume') => request(app).post(`/api/runs/${id}/${action}`).set('cookie', cookie);
  let ticket = 0;

  beforeAll(() => {
    run("INSERT INTO connections (kind, provider, name, config, secret, status, created_at, updated_at) VALUES ('tickets', 'github', 'Pause issues', '{}', '', 'ok', 0, 0)");
    const conn = one<{ id: number }>("SELECT id FROM connections WHERE name = 'Pause issues'")!.id;
    run("INSERT INTO repos (vcs_connection_id, ticket_connection_id, full_name, default_branch, url, enabled) VALUES (?, ?, 'me/pause', 'main', 'u', 1)", conn, conn);
    const repo = one<{ id: number }>("SELECT id FROM repos WHERE full_name = 'me/pause'")!.id;
    run("INSERT INTO tickets (repo_id, number, title, body, url, author, state, labels, updated_at) VALUES (?, 60, 'P', '', 'u', 'me', 'open', '[]', 'x')", repo);
    ticket = one<{ id: number }>('SELECT id FROM tickets WHERE repo_id = ? AND number = 60', repo)!.id;
  });

  const add = (id: string, status: string) =>
    run("INSERT INTO runs (id, ticket_id, agent, attempt, model, billing, status, started_at) VALUES (?, ?, 'implement', 1, 'm', 'subscription', ?, 0)", id, ticket, status);

  it('answers 404 for an unknown run', async () => {
    expect((await post('nope', 'pause')).status).toBe(404);
    expect((await post('nope', 'resume')).status).toBe(404);
  });

  it('refuses to pause a run that has ended', async () => {
    add('p-ended', 'succeeded');
    const res = await post('p-ended', 'pause');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This run has already ended.');
  });

  it('asks a running agent to pause, and takes it back on resume', async () => {
    add('p-running', 'running');
    const paused = await post('p-running', 'pause');
    expect(paused.status).toBe(200);
    expect(paused.body).toMatchObject({ status: 'running', pauseRequested: true });
    const kept = await post('p-running', 'resume');
    expect(kept.status).toBe(200);
    expect(kept.body).toMatchObject({ status: 'running', pauseRequested: false });
    expect((await post('p-running', 'resume')).status).toBe(409);
    run("UPDATE runs SET status = 'cancelled' WHERE id = 'p-running'");
  });

});
