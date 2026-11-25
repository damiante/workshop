import { describe, expect, it } from 'vitest';
import { claudeBrief, TOKEN_LIFETIMES } from '../src/access.ts';

describe('claudeBrief', () => {
  it('holds everything Claude needs to look into the run', () => {
    const text = claudeBrief({
      origin: 'https://workshop.example.com',
      token: 'wks_secret',
      expiresAt: Date.parse('2026-11-25T18:00:00Z'),
      run: { id: 'run-abc', ticketId: 42, ticket: 'me/app#7', agent: 'implement', status: 'failed' },
    });
    expect(text).toContain('https://workshop.example.com');
    expect(text).toContain('export WORKSHOP=https://workshop.example.com');
    expect(text).toContain('export TOKEN=wks_secret');
    expect(text).toContain('$WORKSHOP/api/runs/run-abc\n');
    expect(text).toContain('$WORKSHOP/api/runs/run-abc/export');
    expect(text).toContain('$WORKSHOP/api/tickets/42');
    expect(text).toContain('$WORKSHOP/api/alerts');
    expect(text).toContain('It expires 2026-11-25T18:00:00.000Z');
    expect(text).toContain('on me/app#7, status failed');
  });

  it('offers a lifetime that never expires', () => {
    expect(TOKEN_LIFETIMES.at(-1)).toEqual({ label: 'Never', minutes: null });
  });
});
