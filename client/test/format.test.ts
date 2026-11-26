import { describe, expect, it } from 'vitest';
import type { RunView } from '../../server/src/api-types.ts';
import { runStatus, taskState } from '../src/format.ts';

describe('runStatus', () => {
  it('tells the reasons a run is paused apart', () => {
    expect(runStatus({ status: 'paused', pauseReason: 'limit' }).label).toBe('Paused for usage limit');
    expect(runStatus({ status: 'paused', pauseReason: 'manual' }).label).toBe('Paused by you');
    expect(runStatus({ status: 'paused', pauseReason: 'connection' }).label).toBe('Paused: subscription paused');
    expect(runStatus({ status: 'running', pauseReason: null }).label).toBe('Working');
  });
});

describe('taskState', () => {
  const run = (over: object) => ({ status: 'succeeded', pauseReason: null, result: { outcome: 'done', summary: 's', questions: [], tests: null, findings: [] }, ...over }) as unknown as RunView;
  it('follows the latest outcome, closed first', () => {
    expect(taskState({ closed: true, latest: run({}) }).label).toBe('Closed');
    expect(taskState({ closed: false, latest: null }).label).toBe('No agents yet');
    expect(taskState({ closed: false, latest: run({}) }).label).toBe('Done');
    expect(taskState({ closed: false, latest: run({ result: { outcome: 'needs_info', summary: 's', questions: ['q'], tests: null, findings: [] } }) }).label).toBe('Needs your answer');
    expect(taskState({ closed: false, latest: run({ status: 'running', result: null }) }).label).toBe('Working');
  });
  it("shows a run that failed or was stopped after the agent reported by how it ended", () => {
    expect(taskState({ closed: false, latest: run({ status: 'failed' }) })).toEqual({ label: 'Failed', tone: 'error' });
    expect(taskState({ closed: false, latest: run({ status: 'cancelled' }) }).label).toBe('Stopped');
  });
});
