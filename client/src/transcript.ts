import type { LogEntry } from '../../server/src/api-types.ts';

export type Item =
  | { kind: 'step'; text: string }
  | { kind: 'log'; text: string; error: boolean }
  | { kind: 'say'; text: string }
  | { kind: 'tool'; name: string; summary: string; input: string; output?: string; error?: boolean }
  | { kind: 'result'; ok: boolean; text: string };

export interface Todo {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface Transcript {
  items: Item[];
  todos: Todo[];
  /** tool_use id → index in items, to attach results. */
  tools: Map<string, number>;
  step: LogEntry['step'] | null;
}

export const emptyTranscript = (): Transcript => ({ items: [], todos: [], tools: new Map(), step: null });

const STEP_TEXT: Record<LogEntry['step'], string> = {
  prepare: 'Preparing the repository',
  run: 'Agent',
  publish: 'Pushing the work',
  workshop: 'Workshop',
};

/** One readable line for a tool call. */
export function summarizeTool(name: string, input: Record<string, unknown> = {}): string {
  const first = (v: unknown) => String(v).split('\n')[0];
  if (input.command) return first(input.command);
  if (input.file_path) return first(input.file_path);
  if (input.pattern) return `${input.pattern}${input.path ? ` in ${input.path}` : ''}`;
  if (input.url) return first(input.url);
  if (input.description) return first(input.description);
  if (name === 'StructuredOutput') return 'Returned the result to Workshop';
  return '';
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : (c as { text?: string }).text ?? '')).join('\n');
  return JSON.stringify(content, null, 2);
}

/** Folds one log line into the transcript (mutates it, for speed on long runs). */
export function addEntry(t: Transcript, entry: LogEntry): void {
  if (entry.step !== t.step) {
    t.step = entry.step;
    t.items.push({ kind: 'step', text: STEP_TEXT[entry.step] });
  }
  if (entry.step === 'publish' && entry.text.startsWith('{"before"')) {
    // The publish step's machine-readable last line: what was pushed.
    const { before, after } = JSON.parse(entry.text) as { before: string; after: string };
    t.items.push({ kind: 'log', text: before === after ? 'Nothing new to push.' : `Pushed ${after.slice(0, 7)}.`, error: false });
    return;
  }
  if (entry.step !== 'run' || entry.stream === 'stderr') {
    t.items.push({ kind: 'log', text: entry.text, error: entry.step === 'run' });
    return;
  }
  let event: Record<string, any>;
  try {
    event = JSON.parse(entry.text);
  } catch {
    t.items.push({ kind: 'log', text: entry.text, error: false });
    return;
  }
  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') t.items.push({ kind: 'log', text: `Claude Code ${event.claude_code_version ?? ''} started (${event.model}).`, error: false });
      return;
    case 'assistant':
      for (const block of event.message?.content ?? []) {
        if (block.type === 'text' && block.text?.trim()) t.items.push({ kind: 'say', text: block.text.trim() });
        if (block.type !== 'tool_use') continue;
        if (block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) {
          t.todos = block.input.todos;
          continue;
        }
        t.tools.set(block.id, t.items.length);
        t.items.push({ kind: 'tool', name: block.name, summary: summarizeTool(block.name, block.input), input: JSON.stringify(block.input, null, 2) });
      }
      return;
    case 'user':
      for (const block of event.message?.content ?? []) {
        if (block.type !== 'tool_result') continue;
        const item = t.items[t.tools.get(block.tool_use_id) ?? -1];
        if (item?.kind === 'tool') {
          item.output = textOf(block.content);
          item.error = block.is_error === true;
        }
      }
      return;
    case 'result':
      t.items.push({
        kind: 'result',
        ok: !event.is_error,
        text: event.is_error ? event.errors?.join('; ') || event.result || event.subtype : 'The agent finished.',
      });
      return;
  }
}
