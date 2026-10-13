import { useEffect, useState, type FormEvent } from 'react';
import type { AgentClassView, Billing, ModelOption } from '../../../server/src/api-types.ts';
import { api, useApi } from '../api.ts';
import { ErrorNote, Panel } from '../components/ui.tsx';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const BILLING: { value: Billing; label: string }[] = [
  { value: 'subscription', label: 'Subscription' },
  { value: 'api', label: 'API key' },
];

function AgentForm({ agent, models }: { agent: AgentClassView; models: ModelOption[] }) {
  const [draft, setDraft] = useState(agent);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setDraft(agent), [agent]);

  const key = (m: { connectionId: number | null; id: string | null }) => `${m.connectionId}:${m.id}`;
  const selected = models.find((m) => key(m) === key({ connectionId: draft.modelConnectionId, id: draft.model }));
  const connections = [...new Map(models.map((m) => [m.connectionId, m.connectionName])).entries()];
  const set = (patch: Partial<AgentClassView>) => {
    setDraft({ ...draft, ...patch });
    setSaved(false);
  };

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const { model, modelConnectionId, effort, billing, prompt, maxTurns, timeoutMin } = draft;
      await api(`/agents/${agent.name}`, { method: 'PUT', body: { model, modelConnectionId, effort, billing, prompt, maxTurns, timeoutMin } });
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Panel title={agent.label} action={<span className="small muted">{agent.description}</span>}>
      <form className="panel-body stack" onSubmit={save}>
        <div className="fields">
          <label className="field">
            <span>Model</span>
            <select
              value={selected ? key(selected) : ''}
              onChange={(e) => {
                const m = models.find((x) => key(x) === e.target.value);
                set({ model: m?.id ?? null, modelConnectionId: m?.connectionId ?? null });
              }}
            >
              <option value="">Choose a model</option>
              {connections.map(([id, name]) => (
                <optgroup key={id} label={name}>
                  {models
                    .filter((m) => m.connectionId === id)
                    .map((m) => (
                      <option key={key(m)} value={key(m)}>
                        {m.label}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
            {!models.length && <span className="help">Add Claude under Connections first.</span>}
          </label>
          <label className="field">
            <span>Effort</span>
            <select value={draft.effort ?? ''} onChange={(e) => set({ effort: e.target.value || null })}>
              <option value="">Model default</option>
              {EFFORTS.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
          <div className="field">
            <span>Billing</span>
            <div className="segmented" role="group" aria-label={`${agent.label} billing`}>
              {BILLING.map((b) => (
                <button key={b.value} type="button" aria-pressed={draft.billing === b.value} onClick={() => set({ billing: b.value })}>
                  {b.label}
                </button>
              ))}
            </div>
            {selected && !selected.billing.includes(draft.billing) && (
              <span className="help error-text">
                {selected.connectionName} has no {draft.billing === 'api' ? 'API key' : 'subscription token'}.
              </span>
            )}
          </div>
          <label className="field">
            <span>Max turns</span>
            <input type="number" min={1} max={2000} value={draft.maxTurns} onChange={(e) => set({ maxTurns: Number(e.target.value) })} />
          </label>
          <label className="field">
            <span>Time limit (minutes)</span>
            <input type="number" min={5} max={1440} value={draft.timeoutMin} onChange={(e) => set({ timeoutMin: Number(e.target.value) })} />
          </label>
        </div>
        <label className="field">
          <span>Instructions</span>
          <textarea rows={12} value={draft.prompt} onChange={(e) => set({ prompt: e.target.value })} />
          <span className="help">
            {draft.prompt === agent.defaultPrompt ? 'These are the default instructions. ' : 'Customised. '}
            {draft.prompt !== agent.defaultPrompt && (
              <button type="button" className="link small" onClick={() => set({ prompt: agent.defaultPrompt })}>
                Reset to default
              </button>
            )}
          </span>
        </label>
        <details>
          <summary className="small">What Workshop adds after these instructions</summary>
          <pre className="mono small" style={{ whiteSpace: 'pre-wrap' }}>
            {agent.protocol}
          </pre>
        </details>
        <ErrorNote error={error} />
        <div className="row">
          <button className="primary">Save {agent.label}</button>
          {saved && <span className="small muted">Saved.</span>}
        </div>
      </form>
    </Panel>
  );
}

export function Agents() {
  const { data: agents, error } = useApi<AgentClassView[]>('/agents', ['agents']);
  const { data: models } = useApi<ModelOption[]>('/models', ['connections']);
  return (
    <div className="stack">
      <h1>Agents</h1>
      <p className="muted">Each agent runs Claude Code with its own model, billing and instructions. Workshop adds the ticket and its fixed instructions to every run.</p>
      <ErrorNote error={error} />
      {agents?.map((a) => (
        <AgentForm key={a.name} agent={a} models={models ?? []} />
      ))}
    </div>
  );
}
