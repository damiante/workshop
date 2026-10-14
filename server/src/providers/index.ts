import type { ConnectionKind, ConnectionStatus, ConnectionView, ProviderInfo } from '../api-types.ts';
import { seal, unseal } from '../crypto.ts';
import { all, one, run } from '../db.ts';
import { publish } from '../events.ts';
import { AnthropicProvider, anthropicInfo, type AnthropicConfig, type AnthropicSecret } from './anthropic/index.ts';
import { DockerEnvironment, dockerInfo, type DockerConfig, type DockerSecret } from './docker/index.ts';
import { GitHubApp, githubInfo, githubIssuesInfo, type GitHubConfig, type GitHubSecret } from './github/index.ts';
import type { TicketSource } from './types.ts';

export const PROVIDERS: ProviderInfo[] = [githubInfo, githubIssuesInfo, dockerInfo, anthropicInfo];

export const providerInfo = (id: string) => PROVIDERS.find((p) => p.id === id);

interface Row {
  id: number;
  kind: ConnectionKind;
  provider: string;
  name: string;
  config: string;
  secret: string | null;
  status: ConnectionStatus;
  checked_at: number | null;
  error: string | null;
  updated_at: number;
}

export interface Connection<C = Record<string, unknown>, S = Record<string, string>> {
  id: number;
  kind: ConnectionKind;
  provider: string;
  name: string;
  config: C;
  secret: S;
  status: ConnectionStatus;
  checkedAt: number | null;
  error: string | null;
  updatedAt: number;
}

function fromRow(row: Row): Connection {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    name: row.name,
    config: JSON.parse(row.config),
    secret: row.secret ? JSON.parse(unseal(row.secret)) : {},
    status: row.status,
    checkedAt: row.checked_at,
    error: row.error,
    updatedAt: row.updated_at,
  };
}

export function getConnection<C = Record<string, unknown>, S = Record<string, string>>(id: number | null | undefined) {
  if (id === null || id === undefined) return undefined;
  const row = one<Row>('SELECT * FROM connections WHERE id = ?', id);
  return row ? (fromRow(row) as unknown as Connection<C, S>) : undefined;
}

export function listConnections(kind?: ConnectionKind): Connection[] {
  const rows = kind ? all<Row>('SELECT * FROM connections WHERE kind = ? ORDER BY id', kind) : all<Row>('SELECT * FROM connections ORDER BY id');
  return rows.map(fromRow);
}

export function toView(c: Connection): ConnectionView {
  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(c.secret)) if (value) secrets[key] = `…${String(value).trim().slice(-4)}`;
  return { id: c.id, kind: c.kind, provider: c.provider, name: c.name, config: c.config, secrets, status: c.status, checkedAt: c.checkedAt, error: c.error };
}

export function createConnection(kind: ConnectionKind, provider: string, name: string, config: object, secret: object): number {
  const now = Date.now();
  const result = run(
    'INSERT INTO connections (kind, provider, name, config, secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    kind,
    provider,
    name,
    JSON.stringify(config),
    seal(JSON.stringify(secret)),
    now,
    now,
  );
  publish('connections');
  return Number(result.lastInsertRowid);
}

/** Merges config; secret keys that are omitted keep their stored value. */
export function updateConnection(id: number, patch: { name?: string; config?: object; secret?: Record<string, string> }) {
  const current = getConnection(id);
  if (!current) throw new Error('Connection not found');
  const secret = { ...current.secret, ...Object.fromEntries(Object.entries(patch.secret ?? {}).filter(([, v]) => v !== '')) };
  run(
    'UPDATE connections SET name = ?, config = ?, secret = ?, updated_at = ? WHERE id = ?',
    patch.name ?? current.name,
    JSON.stringify({ ...current.config, ...patch.config }),
    seal(JSON.stringify(secret)),
    Date.now(),
    id,
  );
  publish('connections');
}

export function setConnectionStatus(id: number, status: ConnectionStatus, error: string | null = null) {
  const before = one<{ status: string; error: string | null }>('SELECT status, error FROM connections WHERE id = ?', id);
  run('UPDATE connections SET status = ?, error = ?, checked_at = ? WHERE id = ?', status, error, Date.now(), id);
  if (before?.status !== status || before?.error !== error) publish('connections');
}

const instances = new Map<number, { updatedAt: number; value: unknown }>();

function cached<T>(c: Connection, make: () => T): T {
  const hit = instances.get(c.id);
  if (hit && hit.updatedAt === c.updatedAt) return hit.value as T;
  const value = make();
  instances.set(c.id, { updatedAt: c.updatedAt, value });
  return value;
}

/** Drops a host's cached client, so the next use connects afresh (a dead SSH or TCP session never recovers on its own). */
export function forgetEnvironment(id: number) {
  instances.delete(id);
}

export function environmentOf(c: Connection) {
  const cfg = c.config as unknown as DockerConfig;
  return cached(c, () =>
    new DockerEnvironment(cfg, c.secret as DockerSecret, (fingerprint) => {
      cfg.hostKey = fingerprint;
      // Persist without bumping updated_at, so this instance (now pinned) stays cached.
      run('UPDATE connections SET config = ? WHERE id = ?', JSON.stringify(cfg), c.id);
    }),
  );
}

export function githubOf(c: Connection) {
  return cached(c, () => new GitHubApp(c.config as unknown as GitHubConfig, c.secret as unknown as GitHubSecret));
}

export function vcsOf(c: Connection) {
  if (c.provider !== 'github') throw new Error(`Unsupported code host: ${c.provider}`);
  return githubOf(c);
}

export function ticketsOf(c: Connection): TicketSource {
  if (c.provider !== 'github-issues') throw new Error(`Unsupported ticket source: ${c.provider}`);
  const app = getConnection(Number((c.config as { appConnectionId?: number }).appConnectionId));
  if (!app) throw new Error(`${c.name}: its GitHub connection was removed.`);
  return githubOf(app);
}

export function modelsOf(c: Connection) {
  return cached(c, () => new AnthropicProvider(c.config as AnthropicConfig, c.secret as AnthropicSecret));
}
