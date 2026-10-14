import request from 'supertest';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { seedAgents } from '../src/agents.ts';
import { createApp } from '../src/app.ts';
import { initCrypto, totp } from '../src/crypto.ts';
import { initDb, one, run } from '../src/db.ts';
import { createConnection } from '../src/providers/index.ts';
import { apiRouter } from '../src/http/api.ts';
import { OPENAPI } from '../src/http/openapi.ts';

// Only the ticket source is faked, so label edits can be recorded or made to fail.
const fakeTickets = vi.hoisted(() => ({ setLabels: null as any }));
vi.mock('../src/providers/index.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  ticketsOf: () => fakeTickets,
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
});

describe('usage and launch', () => {
  it('reports usage with the caps', async () => {
    const res = await request(app).get('/api/usage').set('cookie', cookie);
    expect(res.body).toMatchObject({ allowance: [], apiSpendTodayUsd: 0, thresholds: { fiveHour: expect.any(Number), weekly: expect.any(Number) } });
    const s = (await request(app).get('/api/settings').set('cookie', cookie)).body;
    expect(res.body).toMatchObject({ apiRunCapUsd: s.apiRunCapUsd, apiDailyCapUsd: s.apiDailyCapUsd });
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
