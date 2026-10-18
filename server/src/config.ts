import path from 'node:path';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set. See "Configuration" in README.md.`);
  return value;
}

const password = required('WORKSHOP_PASSWORD');
if (password.length < 12) throw new Error('WORKSHOP_PASSWORD must be at least 12 characters.');

export const config = {
  port: Number(process.env.PORT ?? 3000),
  dataDir: path.resolve(process.env.DATA_DIR ?? 'data'),
  password,
  secretKey: required('WORKSHOP_SECRET_KEY'),
  agentBrowserImage: process.env.WORKSHOP_AGENT_BROWSER_IMAGE ?? 'ghcr.io/damiante/workshop-agent-browser:latest',
  agentImage: process.env.WORKSHOP_AGENT_IMAGE ?? 'ghcr.io/damiante/workshop-agent:latest',
  // Only honour X-Forwarded-* from proxies on private networks, so a directly exposed
  // instance can't be fooled into per-IP lockout bypass by a spoofed header.
  trustProxy: process.env.TRUST_PROXY ?? 'loopback, linklocal, uniquelocal',
  resetTotp: process.env.WORKSHOP_RESET_TOTP === '1',
  version: process.env.APP_VERSION ?? 'dev',
  // Distinguishes this Workshop's containers from another instance's on a shared host.
  instance: process.env.WORKSHOP_INSTANCE ?? 'workshop',
};
