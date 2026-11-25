import { describe, expect, it } from 'vitest';
import { runStatus } from '../src/format.ts';

describe('runStatus', () => {
  it('tells the reasons a run is paused apart', () => {
    expect(runStatus({ status: 'paused', pauseReason: 'limit' }).label).toBe('Paused for usage limit');
    expect(runStatus({ status: 'paused', pauseReason: 'manual' }).label).toBe('Paused by you');
    expect(runStatus({ status: 'paused', pauseReason: 'connection' }).label).toBe('Paused: subscription paused');
    expect(runStatus({ status: 'running', pauseReason: null }).label).toBe('Working');
  });
});
