import { describe, expect, it } from 'vitest';
import { runStatus, tokens } from '../src/format.ts';

describe('runStatus', () => {
  it('tells the reasons a run is paused apart', () => {
    expect(runStatus({ status: 'paused', pauseReason: 'limit' }).label).toBe('Paused for usage limit');
    expect(runStatus({ status: 'paused', pauseReason: 'manual' }).label).toBe('Paused by you');
    expect(runStatus({ status: 'paused', pauseReason: 'connection' }).label).toBe('Paused: subscription paused');
    expect(runStatus({ status: 'running', pauseReason: null }).label).toBe('Working');
  });
});

describe('tokens', () => {
  it('groups counts into thousands, millions and billions', () => {
    expect(tokens(null)).toBe(null);
    expect(tokens(950)).toBe('950 tokens');
    expect(tokens(12_400)).toBe('12k tokens');
    expect(tokens(134_700_000)).toBe('134.7M tokens');
    expect(tokens(1_045_400_000)).toBe('1.05B tokens');
    expect(tokens(1_040_000_000)).toBe('1.04B tokens');
  });
});
