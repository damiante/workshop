import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import type { AgentName, Finding, RunView, TaskView } from '../../../server/src/api-types.ts';
import { api, useApi, useNow } from '../api.ts';
import { Markdown } from '../components/Markdown.tsx';
import { ErrorNote, Panel, Status } from '../components/ui.tsx';
import { AGENT_LABEL, clock, duration, isActive, taskState } from '../format.ts';
import { AgentSelect, BrowserBox } from './Tasks.tsx';

const SEVERITY: Record<Finding['severity'], string> = { severe: 'Severe', moderate: 'Moderate', minor: 'Minor' };

function Findings({ findings }: { findings: Finding[] }) {
  return (
    <ul className="findings">
      {findings.map((f, i) => (
        <li key={i}>
          <strong>
            {SEVERITY[f.severity]}: {f.title}
          </strong>
          <div>{f.detail}</div>
          <div className="small">Fix: {f.fix}</div>
          {f.file && (
            <div className="small muted mono">
              {f.file}
              {f.line ? `:${f.line}` : ''}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function RunBlock({ run, n, now }: { run: RunView; n: number; now: number }) {
  // The agent's reported outcome, once it has one: "Needs your answer" says more than the run's "Done".
  const status = taskState({ closed: false, latest: run });
  const r = run.result;
  return (
    <li className="stack" style={{ gap: 6 }}>
      <div className="spread">
        <strong>
          Run {n}: {AGENT_LABEL[run.agent]}
        </strong>
        <Status tone={status.tone}>{status.label}</Status>
      </div>
      <div className="row small muted">
        <Link to={`/runs/${run.id}`}>{clock(run.startedAt)}</Link>
        <span>
          {isActive(run) ? 'running' : 'took'} {duration(run.startedAt, run.endedAt ?? now)}
        </span>
        <span>{run.model}</span>
      </div>
      {run.prompt && <p className="prompt">{run.prompt}</p>}
      {r ? (
        <>
          {r.summary && <Markdown text={r.summary} />}
          {r.questions.length > 0 && (
            <div className="stack" style={{ gap: 4 }}>
              <strong>Questions</strong>
              <ul>
                {r.questions.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ul>
            </div>
          )}
          {r.tests && <span className="small muted">Tests: {r.tests}</span>}
          {r.findings.length > 0 && <Findings findings={r.findings} />}
          {run.error && run.error !== r.summary && <span style={{ color: 'var(--error-text)', overflowWrap: 'anywhere' }}>{run.error}</span>}
        </>
      ) : (
        <>
          {run.activity && <span className="mono muted">{run.activity}</span>}
          {run.error && <span style={{ color: 'var(--error-text)', overflowWrap: 'anywhere' }}>{run.error}</span>}
        </>
      )}
    </li>
  );
}

function StartAgent({ task, agents }: { task: TaskView; agents: AgentName[] }) {
  const [agent, setAgent] = useState<AgentName | null>(null);
  const [prompt, setPrompt] = useState('');
  const [browser, setBrowser] = useState(false);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const chosen = agent ?? task.latest?.agent ?? 'task';
  if (task.closed) return <p className="empty">This task is closed. Reopen it to start another agent.</p>;
  if (task.latest && isActive(task.latest)) return <p className="empty">An agent is working on this task. You can start another when it finishes.</p>;
  const start = (e: FormEvent) => {
    e.preventDefault();
    setStarting(true);
    setProblem(null);
    api<RunView>(`/tasks/${task.id}/runs`, { body: { agent: chosen, prompt, browser } })
      .then(() => setPrompt(''), (err: Error) => setProblem(err.message))
      .finally(() => setStarting(false));
  };
  return (
    <form className="panel-body stack" onSubmit={start}>
      <AgentSelect agents={agents} value={chosen} onChange={setAgent} />
      <label className="field">
        <span>Instructions (optional)</span>
        <textarea rows={5} value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={20_000} placeholder="Answer the questions above, or say what to do next" />
      </label>
      <BrowserBox checked={browser} onChange={setBrowser} />
      <ErrorNote error={problem} />
      <div className="row">
        <button type="submit" className="primary" disabled={starting}>
          {starting ? 'Starting…' : 'Start agent'}
        </button>
        <span className="small muted">The agent reads the task and every earlier run's instructions and report.</span>
      </div>
    </form>
  );
}

export function Task() {
  const { id } = useParams();
  const { data, error } = useApi<TaskView>(`/tasks/${id}`, ['tasks', 'runs']);
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (error && !data) return <ErrorNote error={error} />;
  if (!data) return null;
  const t = data;
  const state = taskState(t);
  const working = Boolean(t.latest && isActive(t.latest));
  const setClosed = (closed: boolean) => {
    setBusy(true);
    api<TaskView>(`/tasks/${t.id}/closed`, { method: 'PUT', body: { closed } })
      .then(() => setProblem(null), (err: Error) => setProblem(err.message))
      .finally(() => setBusy(false));
  };

  return (
    <div className="stack">
      <div className="spread">
        <div className="stack" style={{ gap: 4 }}>
          <h1>{t.title}</h1>
          <div className="row small">
            <span className="muted">
              Task {t.id} in {t.repo}
            </span>
            <span className="muted mono">{t.branch}</span>
            <Status tone={state.tone}>{state.label}</Status>
          </div>
        </div>
        <div className="row">
          {t.branchUrl && (
            <a className="button" href={t.branchUrl} target="_blank" rel="noreferrer">
              View branch
            </a>
          )}
          {t.closed ? (
            <button disabled={busy} onClick={() => setClosed(false)}>
              Reopen task
            </button>
          ) : (
            <button disabled={busy || working} onClick={() => setClosed(true)} title={working ? 'Stop the running agent first' : undefined}>
              Close task
            </button>
          )}
        </div>
      </div>
      <ErrorNote error={problem} />
      <Panel title="Description">
        <p className="prompt panel-body">{t.body}</p>
      </Panel>
      <Panel title="Runs">
        {t.runs.length ? (
          <ol className="list lifecycle">
            {t.runs.map((r, i) => (
              <RunBlock key={r.id} run={r} n={i + 1} now={now} />
            ))}
          </ol>
        ) : (
          <p className="empty">No agent has worked on this task yet.</p>
        )}
      </Panel>
      <Panel title="Start another agent">
        <StartAgent task={t} agents={t.agents} />
      </Panel>
    </div>
  );
}
