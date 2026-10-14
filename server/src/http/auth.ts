import { Router, type NextFunction, type Request, type Response } from 'express';
import type { AuthState, LoginResponse, TokenScope } from '../api-types.ts';
import { config } from '../config.ts';
import { newTotpSecret, randomToken, safeEqual, seal, sha256, unseal, verifyTotp } from '../crypto.ts';
import { one, run } from '../db.ts';
import { getValue, setValue } from '../settings.ts';

// Password (from the environment) + TOTP + server-side sessions. Basic Auth alone isn't enough
// for a service that holds a GitHub App key and root-equivalent access to Docker hosts.

const COOKIE = 'workshop_session';
const SESSION_MS = 30 * 86400_000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60_000;
const failures = new Map<string, { count: number; first: number }>();

function readSession(req: Request): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === COOKIE) return decodeURIComponent(value.join('='));
  }
  return null;
}

function setCookie(req: Request, res: Response, token: string | null) {
  const attrs = [`${COOKIE}=${token ?? ''}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${token ? SESSION_MS / 1000 : 0}`];
  if (req.secure) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

/** Valid session → true, refreshing its sliding expiry about once a day. */
function checkSession(req: Request, res: Response): boolean {
  const token = readSession(req);
  if (!token) return false;
  const hash = sha256(token);
  const row = one<{ last_seen: number }>('SELECT last_seen FROM sessions WHERE token_hash = ?', hash);
  if (!row || Date.now() - row.last_seen > SESSION_MS) return false;
  if (Date.now() - row.last_seen > 86400_000) {
    run('UPDATE sessions SET last_seen = ? WHERE token_hash = ?', Date.now(), hash);
    setCookie(req, res, token);
  }
  return true;
}

function readBearer(req: Request): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') ?? '');
  return m ? m[1] : null;
}

/** Known API token → its id and scope. Refreshes `last_used_at` at most once a minute. */
function checkToken(token: string): { id: number; scope: TokenScope } | null {
  const row = one<{ id: number; scope: TokenScope; last_used_at: number | null }>('SELECT id, scope, last_used_at FROM api_tokens WHERE token_hash = ?', sha256(token));
  if (!row) return null;
  if (!row.last_used_at || Date.now() - row.last_used_at > 60_000) run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', Date.now(), row.id);
  return { id: row.id, scope: row.scope };
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const bearer = readBearer(req);
  if (bearer) {
    const token = checkToken(bearer);
    if (!token) return res.status(401).json({ error: 'That API token is wrong or was revoked.' });
    if (token.scope === 'read' && req.method !== 'GET' && req.method !== 'HEAD') return res.status(403).json({ error: 'This API token is read-only.' });
    res.locals.token = token;
    return next();
  }
  if (checkSession(req, res)) return next();
  // Browser navigations (e.g. GitHub redirecting back) go to the sign-in page instead of a JSON error.
  if (req.method === 'GET' && req.accepts(['json', 'html']) === 'html') return res.redirect('/');
  res.status(401).json({ error: 'Sign in to continue.' });
}

/** Keeps API tokens away from routes that hold credentials: connections and the tokens themselves. */
export function sessionOnly(_req: Request, res: Response, next: NextFunction) {
  if (res.locals.token) return res.status(403).json({ error: "API tokens can't manage connections or tokens. Sign in to Workshop to do that." });
  next();
}

/** Refuses state-changing requests from other sites (defence in depth on top of SameSite cookies). */
export function sameOrigin(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.get('origin');
  if (origin && new URL(origin).host !== req.host) return res.status(403).json({ error: 'Cross-site request refused.' });
  next();
}

export function resetTotp() {
  setValue('totp_secret', null);
  setValue('totp_pending', null);
  run('DELETE FROM sessions');
  console.warn('WORKSHOP_RESET_TOTP is set: the authenticator was removed and everyone signed out. Remove the variable after you sign in again.');
}

export const authRouter = Router();

authRouter.get('/state', (req, res) => {
  const state: AuthState = { authenticated: checkSession(req, res), enrolled: Boolean(getValue('totp_secret')), version: config.version };
  res.json(state);
});

authRouter.post('/login', (req, res) => {
  const ip = req.ip ?? 'unknown';
  const record = failures.get(ip);
  if (record && Date.now() - record.first > LOCKOUT_MS) failures.delete(ip);
  if (record && record.count >= MAX_FAILURES && Date.now() - record.first <= LOCKOUT_MS) {
    const minutes = Math.ceil((record.first + LOCKOUT_MS - Date.now()) / 60_000);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` });
  }
  const deny = (message: string) => {
    const r = failures.get(ip) ?? { count: 0, first: Date.now() };
    failures.set(ip, { ...r, count: r.count + 1 });
    res.status(401).json({ error: message });
  };

  const { password, code } = (req.body ?? {}) as { password?: unknown; code?: unknown };
  if (typeof password !== 'string' || !safeEqual(password, config.password)) return deny('Wrong password or code.');

  const sealed = getValue('totp_secret');
  if (!sealed) {
    // First sign-in: enrol an authenticator app before any session exists.
    let pending = getValue('totp_pending');
    if (!pending) {
      pending = seal(newTotpSecret());
      setValue('totp_pending', pending);
    }
    const secret = unseal(pending);
    if (!code) {
      const body: LoginResponse = { enroll: { secret, uri: `otpauth://totp/Workshop?secret=${secret}&issuer=Workshop` } };
      return res.json(body);
    }
    const counter = verifyTotp(secret, String(code));
    if (counter === null) return deny("That code didn't match. Check the time on your phone is correct.");
    setValue('totp_secret', pending);
    setValue('totp_pending', null);
    setValue('totp_last', String(counter));
  } else {
    const counter = verifyTotp(unseal(sealed), String(code ?? ''), Date.now(), Number(getValue('totp_last') ?? -1));
    if (counter === null) return deny('Wrong password or code.');
    setValue('totp_last', String(counter));
  }

  failures.delete(ip);
  const token = randomToken();
  run('INSERT INTO sessions (token_hash, created_at, last_seen) VALUES (?, ?, ?)', sha256(token), Date.now(), Date.now());
  setCookie(req, res, token);
  const body: LoginResponse = { ok: true };
  res.json(body);
});

authRouter.post('/logout', (req, res) => {
  const token = readSession(req);
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  setCookie(req, res, null);
  res.json({ ok: true });
});
