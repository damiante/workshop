import { Router, type Response } from 'express';
import { suggestModels } from '../agents.ts';
import type { FieldDef, ProviderInfo, TestResult, UsageWindow } from '../api-types.ts';
import { randomToken } from '../crypto.ts';
import { all, one, run } from '../db.ts';
import { publish } from '../events.ts';
import { appManifest, convertManifest, type GitHubConfig } from '../providers/github/index.ts';
import {
  createConnection,
  environmentOf,
  getConnection,
  githubOf,
  listConnections,
  modelsOf,
  PROVIDERS,
  providerInfo,
  setConnectionStatus,
  toView,
  updateConnection,
  vcsOf,
  type Connection,
} from '../providers/index.ts';
import { kick, probeAllowance, syncSoon } from '../scheduler/loop.ts';
import { getSettings, getValue, saveSettings, setValue } from '../settings.ts';
import { repoRef, repoView, sourceFor, type RepoRow } from '../tickets.ts';
import { LABEL_DEFS } from '../workflow/labels.ts';
import { check, HttpError, int } from './util.ts';

const visible = (f: FieldDef, values: Record<string, unknown>, existing?: Connection) =>
  !f.showIf || f.showIf.equals.includes(String(values[f.showIf.key] ?? existing?.config[f.showIf.key] ?? ''));

/** Validates submitted form values against the provider's fields; splits them into config and secret. */
function splitValues(info: ProviderInfo, values: Record<string, unknown>, existing?: Connection) {
  const config: Record<string, unknown> = {};
  const secret: Record<string, string> = {};
  for (const f of info.fields) {
    if (!visible(f, values, existing)) continue;
    let value = typeof values[f.key] === 'string' ? (values[f.key] as string).trim() : values[f.key];
    if (value === undefined || value === null || value === '') {
      // On edit, an empty field keeps what's stored (secrets are never sent to the browser).
      const kept = f.secret ? existing?.secret[f.key] : existing?.config[f.key];
      if (f.required && !kept && f.defaultValue === undefined) throw new HttpError(400, `${f.label} is required.`);
      if (!existing && !f.secret && f.defaultValue !== undefined) config[f.key] = f.defaultValue;
      continue;
    }
    if (f.type === 'number') {
      value = Number(value);
      check(Number.isFinite(value) && (value as number) >= 0, `${f.label} must be a number.`);
    }
    if (f.type === 'select') check(f.options?.some((o) => o.value === value), `${f.label}: choose one of the options.`);
    if (f.type === 'connection') {
      value = Number(value);
      check(getConnection(value as number)?.provider === f.connectionProvider, `${f.label}: choose a connection.`);
    }
    if (f.secret) secret[f.key] = String(value);
    else config[f.key] = value;
  }
  return { config, secret };
}

const pct = (w: UsageWindow | null | undefined) => (w ? `${Math.round(w.pct)}%` : '0%');

async function describe(c: Connection): Promise<string> {
  switch (c.provider) {
    case 'github': {
      const app = githubOf(c);
      const info = await app.describe();
      const cfg = c.config as unknown as GitHubConfig;
      if (info.slug !== cfg.slug || info.htmlUrl !== cfg.htmlUrl) updateConnection(c.id, { config: { slug: info.slug, owner: info.owner, htmlUrl: info.htmlUrl } });
      const installs = await app.installations();
      const approved = installs.filter((i) => i.approved).length;
      return `GitHub App "${info.slug}" works. ${approved} of ${installs.length} installation(s) approved.`;
    }
    case 'github-issues': {
      const app = getConnection(Number(c.config.appConnectionId));
      check(app, 'Its GitHub connection was removed.');
      await githubOf(app).describe();
      return `Reading issues through ${app.name}.`;
    }
    case 'docker': {
      const s = await environmentOf(c).describe();
      const memGb = Math.round(s.memoryMb / 1024);
      const specs = `${s.cpus} CPUs, ${memGb} GB RAM, ${s.os} (${s.arch})`;
      // json_set leaves updated_at alone, so the cached client (and its pinned SSH host key) stays.
      run("UPDATE connections SET config = json_set(config, '$.specs', ?) WHERE id = ?", specs, c.id);
      const cfg = c.config as { cpus?: number; memoryGb?: number };
      const fits = Math.max(1, Math.min(Math.floor(s.cpus / (cfg.cpus || 2)), Math.floor(memGb / (cfg.memoryGb || 4))));
      return `Connected to ${s.name}: ${specs}, Docker ${s.version}. With the per-agent limits set, up to ${fits} agent(s) fit at once.`;
    }
    case 'anthropic': {
      const parts: string[] = [];
      if (c.secret.apiKey) parts.push(`API key works (${await modelsOf(c).checkApiKey()} models)`);
      if (c.secret.oauthToken) {
        const usage = await probeAllowance(c.id, true);
        parts.push(usage ? `Subscription works: 5-hour ${pct(usage.fiveHour)}, weekly ${pct(usage.sevenDay)}` : 'A usage check is already running');
      }
      check(parts.length, 'Add a subscription token, an API key, or both.');
      return `${parts.join('. ')}.`;
    }
  }
  throw new Error(`Unknown provider ${c.provider}`);
}

async function testConnection(c: Connection): Promise<TestResult> {
  try {
    const message = await describe(c);
    setConnectionStatus(c.id, 'ok');
    return { ok: true, message };
  } catch (err) {
    const message = (err as Error).message;
    setConnectionStatus(c.id, 'error', message);
    return { ok: false, message };
  }
}

const reposList = () => all<RepoRow>('SELECT * FROM repos ORDER BY full_name').map(repoView);

/** Redirects from GitHub land in the browser, so failures go back to the Connections page as a message. */
const backWithError = (res: Response, err: unknown) => res.redirect(`/connections?error=${encodeURIComponent((err as Error).message)}`);

export const connectionsRouter = Router();

connectionsRouter.get('/providers', (_req, res) => {
  res.json(PROVIDERS);
});

connectionsRouter.get('/connections', (_req, res) => {
  res.json(listConnections().map(toView));
});

connectionsRouter.post('/connections', async (req, res) => {
  const { provider, name, values } = req.body ?? {};
  const info = providerInfo(String(provider));
  check(info, 'Unknown provider.');
  const { config, secret } = splitValues(info, values ?? {});
  if (info.id === 'github') config.installations = [];
  const id = createConnection(info.kind, info.id, String(name || info.name).trim(), config, secret);
  if (info.id === 'anthropic') suggestModels(id);
  const test = await testConnection(getConnection(id)!);
  res.json({ connection: toView(getConnection(id)!), test });
});

connectionsRouter.put('/connections/:id', async (req, res) => {
  const conn = getConnection(Number(req.params.id));
  check(conn, 'Connection not found.', 404);
  const { config, secret } = splitValues(providerInfo(conn.provider)!, req.body?.values ?? {}, conn);
  updateConnection(conn.id, { name: req.body?.name ? String(req.body.name).trim() : undefined, config, secret });
  const test = await testConnection(getConnection(conn.id)!);
  res.json({ connection: toView(getConnection(conn.id)!), test });
});

connectionsRouter.delete('/connections/:id', (req, res) => {
  const id = Number(req.params.id);
  const busy = one(
    "SELECT id FROM runs WHERE (environment_id = ? OR model_connection_id = ?) AND status IN ('starting', 'running', 'publishing', 'paused')",
    id,
    id,
  );
  check(!busy, 'An agent run is using this connection. Stop it first.', 409);
  run('DELETE FROM connections WHERE id = ?', id);
  publish('connections');
  publish('repos');
  res.json({ ok: true });
});

connectionsRouter.post('/connections/:id/test', async (req, res) => {
  const conn = getConnection(Number(req.params.id));
  check(conn, 'Connection not found.', 404);
  res.json(await testConnection(conn));
});

// GitHub App setup: https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest

connectionsRouter.get('/github/manifest', (req, res) => {
  const state = randomToken();
  setValue('github_manifest_state', JSON.stringify({ state, at: Date.now() }));
  res.json({
    action: `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`,
    manifest: JSON.stringify(appManifest(`${req.protocol}://${req.host}`)),
  });
});

connectionsRouter.get('/github/manifest/callback', async (req, res) => {
  try {
    const saved = JSON.parse(getValue('github_manifest_state') ?? '{}');
    check(saved.state && saved.state === req.query.state && Date.now() - saved.at < 3600_000, 'That GitHub App setup link expired. Start again.');
    setValue('github_manifest_state', null);
    const { config, secret } = await convertManifest(String(req.query.code));
    const id = createConnection('vcs', 'github', `GitHub (${config.owner})`, config, secret);
    // Tickets come from the same App, so GitHub Issues is enrolled alongside it.
    if (!listConnections('tickets').some((c) => c.provider === 'github-issues')) {
      createConnection('tickets', 'github-issues', 'GitHub Issues', { appConnectionId: id }, {});
    }
    if (!getSettings().authors.length && config.owner) saveSettings({ authors: [config.owner] });
    setConnectionStatus(id, 'ok');
    res.redirect('/connections?github=created');
  } catch (err) {
    backWithError(res, err);
  }
});

connectionsRouter.get('/github/:id/install', (req, res) => {
  const conn = getConnection<GitHubConfig>(Number(req.params.id));
  check(conn?.provider === 'github', 'GitHub connection not found.', 404);
  const state = randomToken();
  setValue('github_install_state', JSON.stringify({ state, id: conn.id }));
  res.json({ url: `${conn.config.htmlUrl}/installations/new?state=${encodeURIComponent(state)}` });
});

/** The App's setup URL: GitHub sends you here after installing it. */
connectionsRouter.get('/github/installed', async (req, res) => {
  try {
    const saved = JSON.parse(getValue('github_install_state') ?? '{}');
    const installationId = Number(req.query.installation_id);
    const conn = getConnection(saved.id);
    // Without our state this may not be your own click: approve it by hand on the Connections page.
    if (!conn || !installationId || saved.state !== req.query.state) return res.redirect('/connections?github=review-installations');
    const installs = await githubOf(conn).installations();
    check(installs.some((i) => i.id === installationId), 'GitHub reported an installation this App does not have.');
    const approved = (conn.config as unknown as GitHubConfig).installations;
    updateConnection(conn.id, { config: { installations: [...new Set([...approved, installationId])] } });
    setValue('github_install_state', null);
    res.redirect('/connections?github=installed');
  } catch (err) {
    backWithError(res, err);
  }
});

connectionsRouter.get('/github/:id/installations', async (req, res) => {
  const conn = getConnection(Number(req.params.id));
  check(conn?.provider === 'github', 'GitHub connection not found.', 404);
  res.json(await githubOf(conn).installations());
});

connectionsRouter.put('/github/:id/installations', (req, res) => {
  const conn = getConnection(Number(req.params.id));
  check(conn?.provider === 'github', 'GitHub connection not found.', 404);
  const approved = req.body?.approved;
  check(Array.isArray(approved) && approved.every(Number.isInteger), 'approved must be a list of installation ids.');
  updateConnection(conn.id, { config: { installations: approved } });
  res.json({ ok: true });
});

connectionsRouter.get('/repos', (_req, res) => {
  res.json(reposList());
});

connectionsRouter.post('/repos/refresh', async (_req, res) => {
  for (const c of listConnections('vcs')) {
    for (const r of await vcsOf(c).listRepos()) {
      run(
        `INSERT INTO repos (vcs_connection_id, full_name, default_branch, private, url) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (vcs_connection_id, full_name) DO UPDATE SET default_branch = excluded.default_branch, private = excluded.private, url = excluded.url`,
        c.id,
        r.fullName,
        r.defaultBranch,
        r.private ? 1 : 0,
        r.url,
      );
    }
  }
  publish('repos');
  res.json(reposList());
});

connectionsRouter.put('/repos/:id', async (req, res) => {
  const repo = one<RepoRow>('SELECT * FROM repos WHERE id = ?', Number(req.params.id));
  check(repo, 'Repository not found.', 404);
  const { enabled, image, priority, selection } = req.body ?? {};
  if (selection !== undefined) {
    check(selection === 'all' || selection === 'nominated', 'Choose "all" or "nominated".');
    // Repositories turned on before nominating existed don't have the label yet.
    if (selection === 'nominated' && repo.enabled && enabled !== false) await sourceFor(repo).ensureLabels(repoRef(repo), LABEL_DEFS);
    run('UPDATE repos SET selection = ? WHERE id = ?', selection, repo.id);
  }
  if (image !== undefined) {
    check(image === null || image === '' || (typeof image === 'string' && /^[\w.\-/:@]+$/.test(image)), 'The image must be a Docker image reference.');
    run('UPDATE repos SET image = ? WHERE id = ?', image || null, repo.id);
  }
  if (priority !== undefined) {
    run('UPDATE repos SET priority = ? WHERE id = ?', int(priority, 'Priority', -100, 100), repo.id);
    kick();
  }
  if (enabled === true) {
    const ticketConnection = repo.ticket_connection_id ?? listConnections('tickets').find((c) => Number(c.config.appConnectionId) === repo.vcs_connection_id)?.id;
    check(ticketConnection, 'Add a ticket source (GitHub Issues) under Connections first.');
    await sourceFor({ ...repo, ticket_connection_id: ticketConnection }).ensureLabels(repoRef(repo), LABEL_DEFS);
    run('UPDATE repos SET enabled = 1, ticket_connection_id = ? WHERE id = ?', ticketConnection, repo.id);
    syncSoon();
  } else if (enabled === false) {
    run('UPDATE repos SET enabled = 0 WHERE id = ?', repo.id);
  }
  publish('repos');
  if (selection !== undefined) {
    publish('tickets');
    publish('runs');
    if (selection === 'nominated') kick();
  }
  res.json(repoView(one<RepoRow>('SELECT * FROM repos WHERE id = ?', repo.id)!));
});
