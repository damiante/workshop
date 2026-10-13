import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import type { LogEntry, RunView as Run } from '../../../server/src/api-types.ts';
import { api, useApi, useNow } from '../api.ts';
import { ErrorNote, Panel, Status } from '../components/ui.tsx';
import { AGENT_LABEL, clock, duration, money, RUN_STATUS, tokens } from '../format.ts';
import { addEntry, emptyTranscript, type Item } from '../transcript.ts';

const ACTIVE = ['starting', 'running', 'publishing', 'paused'];

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case 'step':
      return <div className="step">{item.text}</div>;
    case 'log':
      return <pre className={`log mono${item.error ? ' error-text' : ''}`}>{item.text}</pre>;
    case 'say':
      return <p className="say">{item.text}</p>;
    case 'tool':
      return (
        <details className={item.error ? 'tool-error' : undefined}>
          <summary>
            {item.name}
            {item.summary && `: ${item.summary}`}
            {item.output === undefined && ' …'}
          </summary>
          <pre className="mono">{item.input}</pre>
          {item.output !== undefined && <pre className="mono">{item.output || '(no output)'}</pre>}
        </details>
      );
    case 'result':
      return <p className={`notice ${item.ok ? 'ok' : 'error'}`}>{item.text}</p>;
  }
}

export function RunView() {
  const { id } = useParams();
  const { data: run, error } = useApi<Run>(`/runs/${id}`, ['runs']);
  const now = useNow(10_000);
  const transcript = useRef(emptyTranscript());
  const [, setVersion] = useState(0);
  const [following, setFollowing] = useState(true);
  const [stopError, setStopError] = useState<string | null>(null);

  useEffect(() => {
    transcript.current = emptyTranscript();
    setVersion((v) => v + 1);
    // EventSource resumes with Last-Event-ID after a dropped connection, so lines aren't repeated.
    const source = new EventSource(`/api/runs/${id}/log`);
    let queued = false;
    source.onmessage = (message) => {
      addEntry(transcript.current, JSON.parse(message.data) as LogEntry);
      if (!queued) {
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          setVersion((v) => v + 1);
        });
      }
    };
    return () => source.close();
  }, [id]);

  useEffect(() => {
    const onScroll = () => setFollowing(window.innerHeight + window.scrollY >= document.body.scrollHeight - 80);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (following) window.scrollTo({ top: document.body.scrollHeight });
  });

  if (!run) return <ErrorNote error={error} />;
  const active = ACTIVE.includes(run.status);
  const status = RUN_STATUS[run.status];
  const { items, todos } = transcript.current;

  const stop = () => {
    if (!confirm('Stop this run? The ticket gets the workshop/failed label, so it won’t start again until you remove it.')) return;
    api(`/runs/${run.id}/stop`, { body: {} }).then(() => setStopError(null), (e: Error) => setStopError(e.message));
  };

  return (
    <div className="stack">
      <div className="spread">
        <div className="stack" style={{ gap: 4 }}>
          <h1>
            {AGENT_LABEL[run.agent]} on {run.ticket}
          </h1>
          <a href={run.ticketUrl} target="_blank" rel="noreferrer">
            {run.ticketTitle}
          </a>
        </div>
        {active && (
          <button className="danger" onClick={stop}>
            Stop
          </button>
        )}
      </div>
      <div className="row small muted" style={{ columnGap: 16 }}>
        <Status tone={status.tone}>{status.label}</Status>
        <span>{run.model}</span>
        <span>{run.billing === 'api' ? 'API billing' : 'Subscription'}</span>
        <span>{run.environment ?? 'Removed host'}</span>
        <span>
          Started {clock(run.startedAt)}, {active ? `running ${duration(run.startedAt, now)}` : `took ${duration(run.startedAt, run.endedAt ?? now)}`}
        </span>
        {run.attempt > 1 && <span>Attempt {run.attempt}</span>}
        {tokens((run.inputTokens ?? 0) + (run.outputTokens ?? 0) || null) && <span>{tokens((run.inputTokens ?? 0) + (run.outputTokens ?? 0))}</span>}
        {run.billing === 'api' && money(run.costUsd) && <span>{money(run.costUsd)}</span>}
        {run.status === 'paused' && run.resetsAt && <span>Resumes after {clock(run.resetsAt)}</span>}
      </div>
      <ErrorNote error={stopError} />
      {run.error && <p className="notice error">{run.error}</p>}
      {run.summary && <p className="notice ok" style={{ whiteSpace: 'pre-wrap' }}>{run.summary}</p>}
      {todos.length > 0 && (
        <Panel title="The agent's to-do list">
          <ul className="todos panel-body">
            {todos.map((t, i) => (
              <li key={i} className={t.status}>
                {t.content}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <div className="transcript">
        {items.length ? items.map((item, i) => <ItemView key={i} item={item} />) : <p className="muted">{active ? 'Waiting for output…' : 'No log for this run.'}</p>}
      </div>
      {active && !following && (
        <button className="primary" style={{ position: 'fixed', right: 24, bottom: 24 }} onClick={() => window.scrollTo({ top: document.body.scrollHeight })}>
          Jump to live
        </button>
      )}
    </div>
  );
}
