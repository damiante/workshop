import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { seedAgents } from '../src/agents.ts';
import { createApp } from '../src/app.ts';
import { initCrypto, totp } from '../src/crypto.ts';
import { initDb } from '../src/db.ts';

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
    run("INSERT INTO repos (vcs_connection_id, full_name, default_branch, url, enabled) VALUES (1, 'me/app', 'main', 'u', 1)");
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
