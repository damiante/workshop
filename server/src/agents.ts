import type { AgentClassView, AgentName, Billing } from './api-types.ts';
import { all, one, run } from './db.ts';
import { publish } from './events.ts';
import { AGENT_INFO, AGENT_NAMES, DEFAULT_PROMPTS, protocolText } from './workflow/prompts.ts';

export interface AgentRow {
  name: AgentName;
  model: string | null;
  model_connection_id: number | null;
  effort: string | null;
  billing: Billing;
  prompt: string | null;
  max_turns: number;
  timeout_min: number;
}

// The split suggested in the requirements; applied when the first Claude connection is added.
const SUGGESTED_MODELS: Record<AgentName, string> = {
  classifier: 'claude-haiku-5-5',
  design: 'claude-opus-5-5',
  'design-review': 'claude-opus-5-5',
  implement: 'claude-sonnet-5-5',
  merge: 'claude-sonnet-5-5',
};

export function seedAgents() {
  for (const name of AGENT_NAMES) {
    run('INSERT OR IGNORE INTO agent_classes (name, max_turns, timeout_min) VALUES (?, ?, ?)', name, AGENT_INFO[name].maxTurns, AGENT_INFO[name].timeoutMin);
  }
}

export const getAgent = (name: AgentName) => one<AgentRow>('SELECT * FROM agent_classes WHERE name = ?', name)!;

export const promptFor = (row: AgentRow) => row.prompt ?? DEFAULT_PROMPTS[row.name];

export function agentViews(): AgentClassView[] {
  const rows = all<AgentRow>('SELECT * FROM agent_classes');
  return AGENT_NAMES.map((name) => {
    const row = rows.find((r) => r.name === name)!;
    return {
      name,
      label: AGENT_INFO[name].label,
      description: AGENT_INFO[name].description,
      model: row.model,
      modelConnectionId: row.model_connection_id,
      effort: row.effort,
      billing: row.billing,
      prompt: promptFor(row),
      defaultPrompt: DEFAULT_PROMPTS[name],
      customised: row.prompt !== null,
      protocol: protocolText({ branch: 'workshop/<number>-<title>', base: '<default branch>', docPath: 'docs/workshop/<number>-<title>.md' }),
      maxTurns: row.max_turns,
      timeoutMin: row.timeout_min,
    };
  });
}

export function updateAgent(name: AgentName, patch: Partial<Omit<AgentClassView, 'name'>>) {
  const row = getAgent(name);
  // A prompt identical to the default (or empty) means "use the default", so future default improvements apply.
  const prompt = patch.prompt === undefined ? row.prompt : !patch.prompt.trim() || patch.prompt === DEFAULT_PROMPTS[name] ? null : patch.prompt;
  run(
    'UPDATE agent_classes SET model = ?, model_connection_id = ?, effort = ?, billing = ?, prompt = ?, max_turns = ?, timeout_min = ? WHERE name = ?',
    patch.model !== undefined ? patch.model : row.model,
    patch.modelConnectionId !== undefined ? patch.modelConnectionId : row.model_connection_id,
    patch.effort !== undefined ? patch.effort : row.effort,
    patch.billing ?? row.billing,
    prompt,
    patch.maxTurns ?? row.max_turns,
    patch.timeoutMin ?? row.timeout_min,
    name,
  );
  publish('agents');
}

export function suggestModels(connectionId: number) {
  for (const name of AGENT_NAMES) {
    run('UPDATE agent_classes SET model = ?, model_connection_id = ? WHERE name = ? AND model IS NULL', SUGGESTED_MODELS[name], connectionId, name);
  }
  publish('agents');
}
