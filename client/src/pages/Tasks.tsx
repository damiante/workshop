import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { AgentName, TaskSummary, TasksView, TaskView } from '../../../server/src/api-types.ts';
import { api, useApi, useNow } from '../api.ts';
import { ErrorNote, Panel, Status } from '../components/ui.tsx';
import { AGENT_LABEL, ago, taskState } from '../format.ts';

const REPO_KEY = 'workshop-task-repo';

/** Choosing an agent for a task run: each uses its own settings from the Agents page. */
export function AgentSelect({ agents, value, onChange }: { agents: AgentName[]; value: AgentName; onChange: (a: AgentName) => void }) {
  return (
    <label className="field">
      <span>Agent</span>
      <select value={value} onChange={(e) => onChange(e.target.value as AgentName)}>
        {agents.map((a) => (
          <option key={a} value={a}>
            {AGENT_LABEL[a]}
          </option>
        ))}
      </select>
    </label>
  );
}

export function BrowserBox({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="row" style={{ gap: 6, flexWrap: 'nowrap', alignItems: 'baseline' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>Give it a browser (Playwright with Chromium)</span>
    </label>
  );
}

function TaskTable({ tasks, now }: { tasks: TaskSummary[]; now: number }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Latest agent</th>
            <th>Runs</th>
            <th>Status</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((t) => {
            const state = taskState(t);
            return (
              <tr key={t.id}>
                <td>
                  <Link to={`/tasks/${t.id}`}>{t.title}</Link>
                  <div className="small muted">
                    Task {t.id} in {t.repo}
                  </div>
                </td>
                <td className="small">
                  {t.latest ? (
                    <>
                      <Link to={`/runs/${t.latest.id}`}>{AGENT_LABEL[t.latest.agent]}</Link>
                      <div className="muted">{ago(t.latest.startedAt, now)}</div>
                    </>
                  ) : (
                    '–'
                  )}
                </td>
                <td className="small">{t.runs}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <Status tone={state.tone}>{state.label}</Status>
                </td>
                <td className="small muted">{ago(t.updatedAt, now)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Tasks() {
  const { data, error } = useApi<TasksView>('/tasks', ['tasks', 'runs', 'repos']);
  const now = useNow();
  const navigate = useNavigate();
  const [chosen, setChosen] = useState(() => localStorage.getItem(REPO_KEY) ?? '');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [agent, setAgent] = useState<AgentName>('task');
  const [browser, setBrowser] = useState(false);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!data) return <ErrorNote error={error} />;

  // The remembered repository, if it's still there; otherwise the first one.
  const repoId = data.repos.some((r) => String(r.id) === chosen) ? chosen : String(data.repos[0]?.id ?? '');
  const start = (e: FormEvent) => {
    e.preventDefault();
    setStarting(true);
    setProblem(null);
    localStorage.setItem(REPO_KEY, repoId);
    api<TaskView>('/tasks', { body: { repoId: Number(repoId), title: title.trim() || undefined, body, agent, browser } })
      .then((task) => navigate(`/tasks/${task.id}`), (err: Error) => setProblem(err.message))
      .finally(() => setStarting(false));
  };
  const open = data.tasks.filter((t) => !t.closed);
  const closed = data.tasks.filter((t) => t.closed);

  return (
    <div className="stack">
      <h1>Tasks</h1>
      <ErrorNote error={error} />
      <Panel title="New task">
        {data.repos.length ? (
          <form className="panel-body stack" onSubmit={start}>
            <label className="field">
              <span>Repository</span>
              <select value={repoId} onChange={(e) => setChosen(e.target.value)}>
                {data.repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.fullName}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Title (optional)</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="From the first line of the description" />
            </label>
            <label className="field">
              <span>What should the agent do?</span>
              <textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} maxLength={20_000} required />
            </label>
            <AgentSelect agents={data.agents} value={agent} onChange={setAgent} />
            <BrowserBox checked={browser} onChange={setBrowser} />
            <ErrorNote error={problem} />
            <div className="row">
              <button type="submit" className="primary" disabled={starting || !body.trim()}>
                {starting ? 'Starting…' : 'Start task'}
              </button>
            </div>
            <p className="small muted">
              Starts now on a free agent host with that agent's model and limits (<Link to="/agents">Agents</Link> page). Agents on a task share a new branch, which Workshop pushes
              when it has commits; no pull request is opened. Workshop keeps the description and instructions with the task, where read-only API tokens can see them, so don't
              paste long-lived secrets.
            </p>
          </form>
        ) : (
          <p className="empty">
            Workshop can't see any repositories yet. Add a code host on the <Link to="/connections">Connections</Link> page.
          </p>
        )}
      </Panel>
      <Panel title="Open tasks">{open.length ? <TaskTable tasks={open} now={now} /> : <p className="empty">No open tasks. Describe one above to start an agent.</p>}</Panel>
      {closed.length > 0 && (
        <Panel title="Closed tasks">
          <TaskTable tasks={closed} now={now} />
        </Panel>
      )}
    </div>
  );
}
