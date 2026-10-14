import { Router } from 'express';
import type { ApiTokenView, NewApiToken } from '../api-types.ts';
import { randomToken, sha256 } from '../crypto.ts';
import { all, one, run } from '../db.ts';
import { publish } from '../events.ts';
import { check, int } from './util.ts';

interface TokenRow {
  id: number;
  name: string;
  scope: ApiTokenView['scope'];
  created_at: number;
  last_used_at: number | null;
}

const view = (t: TokenRow): ApiTokenView => ({ id: t.id, name: t.name, scope: t.scope, createdAt: t.created_at, lastUsedAt: t.last_used_at });

export const tokensRouter = Router();

tokensRouter.get('/tokens', (_req, res) => {
  res.json(all<TokenRow>('SELECT id, name, scope, created_at, last_used_at FROM api_tokens ORDER BY created_at DESC, id DESC').map(view));
});

tokensRouter.post('/tokens', (req, res) => {
  const { name, scope } = (req.body ?? {}) as { name?: unknown; scope?: unknown };
  const trimmed = typeof name === 'string' ? name.trim() : '';
  check(trimmed.length >= 1 && trimmed.length <= 60, 'Give the token a name of up to 60 characters.');
  check(scope === 'read' || scope === 'write', 'Scope must be read or write.');
  const token = `wks_${randomToken()}`;
  const { lastInsertRowid } = run('INSERT INTO api_tokens (name, token_hash, scope, created_at) VALUES (?, ?, ?, ?)', trimmed, sha256(token), scope, Date.now());
  const created: NewApiToken = { token, view: view(one<TokenRow>('SELECT * FROM api_tokens WHERE id = ?', Number(lastInsertRowid))!) };
  publish('tokens');
  res.status(201).json(created);
});

tokensRouter.delete('/tokens/:id', (req, res) => {
  const { changes } = run('DELETE FROM api_tokens WHERE id = ?', int(req.params.id, 'Token id', 1, Number.MAX_SAFE_INTEGER));
  check(changes, 'Token not found.', 404);
  publish('tokens');
  res.json({ ok: true });
});
