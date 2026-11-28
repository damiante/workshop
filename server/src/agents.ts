import type { AgentClassView, AgentName, Billing } from './api-types.ts';
import { clearAlert, raiseAlert } from './alerts.ts';
import { sha256 } from './crypto.ts';
import { all, one, run } from './db.ts';
import { publish } from './events.ts';
import { AGENT_INFO, AGENT_NAMES, DEFAULT_PROMPTS, protocolText, publishes } from './workflow/prompts.ts';

export interface AgentRow {
  name: AgentName;
  model: string | null;
  model_connection_id: number | null;
  effort: string | null;
  billing: Billing;
  prompt: string | null;
  /** The default a customised prompt was based on; null when not customised or customised before Workshop kept it. */
  prompt_base: string | null;
  /** sha256 of the default last raised as a prompt-default alert. */
  prompt_alerted: string | null;
  max_turns: number;
  timeout_min: number;
}

// The split suggested in the requirements; applied when the first Claude connection is added.
const SUGGESTED_MODELS: Record<AgentName, string> = {
  classifier: 'claude-haiku-5-5',
  design: 'claude-opus-5-5',
  'design-review': 'claude-opus-5-5',
  implement: 'claude-sonnet-5-5',
  'code-review': 'claude-opus-5-5',
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
      defaultBefore: row.prompt !== null && row.prompt_base !== null && row.prompt_base !== DEFAULT_PROMPTS[name] ? row.prompt_base : null,
      defaultUnknown: row.prompt !== null && row.prompt_base === null,
      protocol: protocolText({ branch: 'workshop/<number>-<title>', base: '<default branch>', publishes: publishes(name) }),
      maxTurns: row.max_turns,
      timeoutMin: row.timeout_min,
    };
  });
}

export function updateAgent(name: AgentName, patch: Partial<Omit<AgentClassView, 'name'>>) {
  const row = getAgent(name);
  // A prompt identical to the default (or empty) means "use the default", so future default improvements apply.
  const prompt = patch.prompt === undefined ? row.prompt : !patch.prompt.trim() || patch.prompt === DEFAULT_PROMPTS[name] ? null : patch.prompt;
  // Editing the prompt records the default it now starts from. A save that only changes other fields
  // (the form always sends the prompt) keeps the base, so it can't hide an out-of-date flag.
  const base = prompt === null ? null : prompt !== row.prompt ? DEFAULT_PROMPTS[name] : row.prompt_base;
  if (base !== row.prompt_base) clearAlert('prompt-default', name);
  run(
    'UPDATE agent_classes SET model = ?, model_connection_id = ?, effort = ?, billing = ?, prompt = ?, prompt_base = ?, max_turns = ?, timeout_min = ? WHERE name = ?',
    patch.model !== undefined ? patch.model : row.model,
    patch.modelConnectionId !== undefined ? patch.modelConnectionId : row.model_connection_id,
    patch.effort !== undefined ? patch.effort : row.effort,
    patch.billing ?? row.billing,
    prompt,
    base,
    patch.maxTurns ?? row.max_turns,
    patch.timeoutMin ?? row.timeout_min,
    name,
  );
  publish('agents');
}

/** Records that a customised prompt was checked against today's default, without changing it. */
export function acceptDefault(name: AgentName) {
  run('UPDATE agent_classes SET prompt_base = ? WHERE name = ? AND prompt IS NOT NULL', DEFAULT_PROMPTS[name], name);
  clearAlert('prompt-default', name);
  publish('agents');
}

/** Raises one alert per default change for customised prompts based on an older default. Defaults only change on upgrade, so boot is enough. */
export function checkPromptDefaults() {
  for (const row of all<AgentRow>('SELECT * FROM agent_classes WHERE prompt IS NOT NULL AND prompt_base IS NOT NULL')) {
    const current = DEFAULT_PROMPTS[row.name];
    if (!current || row.prompt_base === current || row.prompt_alerted === sha256(current)) continue;
    raiseAlert('warning', 'prompt-default', `Workshop's default instructions for ${AGENT_INFO[row.name].label} have changed since you customised them. Compare them on the Agents page.`, row.name);
    run('UPDATE agent_classes SET prompt_alerted = ? WHERE name = ?', sha256(current), row.name);
  }
}

export function suggestModels(connectionId: number) {
  for (const name of AGENT_NAMES) {
    run('UPDATE agent_classes SET model = ?, model_connection_id = ? WHERE name = ? AND model IS NULL', SUGGESTED_MODELS[name], connectionId, name);
  }
  publish('agents');
}
