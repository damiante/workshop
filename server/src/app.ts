import fs from 'node:fs';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { config } from './config.ts';
import { apiRouter } from './http/api.ts';
import { authRouter, requireAuth, sameOrigin } from './http/auth.ts';
import { connectionsRouter } from './http/connections.ts';

const CLIENT_DIR = path.resolve(import.meta.dirname, '../../client/dist');

// form-action allows github.com for the one-click GitHub App setup (a form POST to GitHub).
const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'self' https://github.com",
  "base-uri 'none'",
].join('; ');

export function createApp() {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', sameOrigin);
  app.use('/api/auth', authRouter);
  app.use('/api', requireAuth, apiRouter, connectionsRouter);
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Not found.' });
  });

  if (fs.existsSync(CLIENT_DIR)) {
    app.use(express.static(CLIENT_DIR, { index: false, maxAge: '1h' }));
    app.get('/{*path}', (_req, res) => {
      res.sendFile(path.join(CLIENT_DIR, 'index.html'));
    });
  }

  app.use((err: Error & { status?: number; statusCode?: number }, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message || 'Something went wrong.' });
  });
  return app;
}
