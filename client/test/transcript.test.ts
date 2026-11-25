import { expect, it } from 'vitest';
import type { LogEntry } from '../../server/src/api-types.ts';
import { addEntry, emptyTranscript } from '../src/transcript.ts';

const run = (event: unknown): LogEntry => ({ step: 'run', stream: 'stdout', text: JSON.stringify(event) });

it('turns a run log into steps, prose, tool calls with results, a to-do list and the outcome', () => {
  const t = emptyTranscript();
  const entries: LogEntry[] = [
    { step: 'prepare', stream: 'stdout', text: 'Checked out workshop/3-x at abc123' },
    run({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', claude_code_version: '2.1.296' }),
    run({ type: 'assistant', message: { content: [{ type: 'text', text: 'Running the tests.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test\nmore' } }] } }),
    run({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [{ content: 'Fix it', status: 'in_progress' }] } }] } }),
    run({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '2 failed' }], is_error: true }] } }),
    { step: 'run', stream: 'stderr', text: 'warning: something' },
    run({ type: 'result', is_error: false }),
    { step: 'publish', stream: 'stdout', text: '{"before":"","after":"def"}' },
  ];
  for (const e of entries) addEntry(t, e);

  expect(t.items.map((i) => i.kind)).toEqual(['step', 'log', 'step', 'log', 'say', 'tool', 'log', 'result', 'step', 'log']);
  expect(t.items[5]).toMatchObject({ kind: 'tool', name: 'Bash', summary: 'npm test', output: '2 failed', error: true });
  expect(t.todos).toEqual([{ content: 'Fix it', status: 'in_progress' }]);
  expect(t.items[6]).toMatchObject({ kind: 'log', error: true });
  expect(t.items[7]).toMatchObject({ kind: 'result', ok: true });
  expect(t.items[9]).toEqual({ kind: 'log', text: 'Pushed def.', error: false });
});

const say = (id: string | undefined, text: string, extra: object = {}) => ({ type: 'assistant', ...extra, message: { ...(id ? { id } : {}), content: [{ type: 'text', text }] } });
const tool = (id: string, toolId: string, name = 'Bash', extra: object = {}) => ({
  type: 'assistant',
  ...extra,
  message: { id, content: [{ type: 'tool_use', id: toolId, name, input: name === 'TodoWrite' ? { todos: [] } : { command: 'ls' } }] },
});

it('counts turns by message id and numbers the first item of each', () => {
  const t = emptyTranscript();
  for (const e of [say('m1', 'Looking.'), tool('m1', 't1'), tool('m2', 't2'), say('m2', 'Done.')]) addEntry(t, run(e));
  const agentItems = t.items.filter((i) => i.kind === 'say' || i.kind === 'tool');
  expect(agentItems.map((i) => i.turn)).toEqual([1, undefined, 2, undefined]);
  expect(t).toMatchObject({ turns: 2, segmentTurns: 2 });
});

it("doesn't count a subagent's lines, and counts each line without an id as a turn", () => {
  const t = emptyTranscript();
  addEntry(t, run(say(undefined, 'One.')));
  addEntry(t, run(say(undefined, 'Two.')));
  addEntry(t, run(tool('s1', 'st1', 'Bash', { parent_tool_use_id: 'task1' })));
  addEntry(t, run(say('s2', 'Sub.', { parent_tool_use_id: 'task1' })));
  expect(t.turns).toBe(2);
  expect(t.toolCalls).toBe(0);
  expect(t.items.filter((i) => i.turn).map((i) => i.turn)).toEqual([1, 2]);
});

it('numbers the next item when a turn starts with a to-do update', () => {
  const t = emptyTranscript();
  addEntry(t, run(tool('m1', 't1', 'TodoWrite')));
  addEntry(t, run(tool('m2', 't2')));
  expect(t.turns).toBe(2);
  expect(t.items.find((i) => i.kind === 'tool')!.turn).toBe(2);
});

it('starts the session count again in a new container, and takes Claude Code’s own count', () => {
  const t = emptyTranscript();
  const at = (container: string, event: unknown): LogEntry => ({ ...run(event), container });
  addEntry(t, at('aaa', say('m1', 'One.')));
  addEntry(t, at('aaa', say('m2', 'Two.')));
  addEntry(t, at('bbb', say('m3', 'Three.')));
  expect(t).toMatchObject({ turns: 3, segmentTurns: 1 });
  addEntry(t, at('bbb', { type: 'result', is_error: false, num_turns: 4 }));
  expect(t).toMatchObject({ turns: 3, segmentTurns: 4 });
});

it('counts tool calls and failures, but not to-do updates', () => {
  const t = emptyTranscript();
  addEntry(t, run(tool('m1', 't1')));
  addEntry(t, run(tool('m2', 't2', 'TodoWrite')));
  addEntry(t, run(tool('m3', 't3')));
  addEntry(t, run({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true }] } }));
  addEntry(t, run({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'ok' }] } }));
  expect(t).toMatchObject({ toolCalls: 2, toolErrors: 1 });
});

it('collapses tool results with images, including lines Workshop cut short', () => {
  const t = emptyTranscript();
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR' } };
  addEntry(t, run({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/a.png' } }] } }));
  addEntry(t, run({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'r1', content: [image] }] } }));
  addEntry(t, run({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: '/b.png' } }] } }));
  const cut = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ tool_use_id: 'r2', type: 'tool_result', content: [{ ...image, source: { ...image.source, data: 'A'.repeat(70_000) } }] }] } });
  addEntry(t, { step: 'run', stream: 'stdout', text: cut.slice(0, 64_000) + ' …[truncated by Workshop]' });
  addEntry(t, { step: 'run', stream: 'stdout', text: '{"type":"assistant","message":{"content":[{"type":"text","text":"cut' });

  expect(t.items.map((i) => i.kind)).toEqual(['step', 'tool', 'tool', 'tool']);
  expect(t.items[1]).toMatchObject({ kind: 'tool', output: '(image/png)' });
  expect(t.items[2]).toMatchObject({ kind: 'tool', summary: '/b.png', output: expect.stringMatching(/^\(Too long to show/) });
  expect(t.items[3]).toMatchObject({ kind: 'tool', name: 'Log line' });
});
