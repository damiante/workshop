import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import type { LogEntry, NewApiToken, RunView as Run } from '../../../server/src/api-types.ts';
import { claudeBrief } from '../access.ts';
import { api, useApi, useNow } from '../api.ts';
import { Markdown } from '../components/Markdown.tsx';
import { ErrorNote, Panel, Progress, Status } from '../components/ui.tsx';
import { AGENT_LABEL, clock, duration, money, runStatus, tokens } from '../format.ts';
import { LiveStream } from '../live.ts';
import { addEntry, emptyTranscript, type Item, type Transcript } from '../transcript.ts';

const ACTIVE = ['starting', 'running', 'publishing', 'paused'];

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case 'step':
      return <div className="step">{item.text}</div>;
    case 'log':
      return <pre className={`log mono${item.error ? ' error-text' : ''}`}>{item.text}</pre>;
    case 'say':
      return <Markdown className="say" text={item.text} />;
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

const TURN_HASH = /^#turn-(\d+)$/;
const turnOf = (hash: string) => Number(TURN_HASH.exec(hash)?.[1] ?? 0) || null;

/** Turns, time, to-dos and tool calls against the limits the session started with. */
function RunProgress({ run, t, now }: { run: Run; t: Transcript; now: number }) {
  const timing = run.status === 'running' && run.step === 'run' && run.stepStartedAt !== null && run.timeoutMin !== null;
  const done = t.todos.filter((todo) => todo.status === 'completed').length;
  const all = t.turns > t.segmentTurns ? `, ${t.turns} in all` : '';
  const minutes = timing ? Math.min(run.timeoutMin!, Math.max(0, Math.floor((now - run.stepStartedAt!) / 60_000))) : 0;
  return (
    <Panel title="Progress">
      <div className="progress panel-body small">
        {run.maxTurns !== null ? (
          <Progress label="Turns" value={t.segmentTurns} max={run.maxTurns} text={`${t.segmentTurns} of ${run.maxTurns}${all}`} />
        ) : (
          <Row label="Turns">
            {t.segmentTurns} turns{all}
          </Row>
        )}
        {timing && (
          <Progress label="Time limit" value={minutes} max={run.timeoutMin!} text={`${minutes} of ${run.timeoutMin} min`} />
        )}
        {t.todos.length > 0 && (
          <Row label="To-dos">
            {done} of {t.todos.length} done
          </Row>
        )}
        <Row label="Tool calls">
          {t.toolCalls}
          {t.toolErrors > 0 && `, ${t.toolErrors} failed`}
        </Row>
        {run.activity && (
          <Row label="Now">
            <span className="mono">{run.activity}</span>
          </Row>
        )}
      </div>
    </Panel>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span>{label}</span>
      <span className="progress-text muted">{children}</span>
    </>
  );
}

export function RunView() {
  const { id } = useParams();
  const { data: run, error } = useApi<Run>(`/runs/${id}`, ['runs', 'activity']);
  const now = useNow(10_000);
  const transcript = useRef(emptyTranscript());
  const [, setVersion] = useState(0);
  // A link to a turn (#turn-12) scrolls the page there once it has streamed in.
  const [target, setTarget] = useState(() => turnOf(location.hash));
  // The page opens at the top, on the run's summary; it follows the live log once scrolled to the bottom.
  const [following, setFollowing] = useState(false);
  const scrolledTo = useRef<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [brief, setBrief] = useState<string | null>(null);

  useEffect(() => {
    transcript.current = emptyTranscript();
    setVersion((v) => v + 1);
    // A new EventSource doesn't send Last-Event-ID, so a reconnect passes the last line it saw as ?after=.
    let last = -1;
    let ended = false; // the run finished and the server closed the log: don't reopen it
    let queued = false;
    const stream = new LiveStream({
      url: () => `/api/runs/${id}/log${last >= 0 ? `?after=${last}` : ''}`,
      onMessage: (data, lastEventId) => {
        last = Number(lastEventId);
        addEntry(transcript.current, JSON.parse(data) as LogEntry);
        if (!queued) {
          queued = true;
          requestAnimationFrame(() => {
            queued = false;
            setVersion((v) => v + 1);
          });
        }
      },
      onEnd: () => {
        ended = true;
      },
    });
    // Hidden tabs release their connection (browsers allow few per site) and pick up where they left off.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stream.stop();
      else if (!ended) stream.start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (document.visibilityState !== 'hidden') stream.start();
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stream.stop();
    };
  }, [id]);

  useEffect(() => {
    const onScroll = () => setFollowing(window.innerHeight + window.scrollY >= document.body.scrollHeight - 80);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const onHash = () => {
      const turn = turnOf(location.hash);
      setTarget(turn);
      if (turn !== null) {
        scrolledTo.current = turn; // the browser scrolls to it
        setFollowing(false);
      }
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    // Scroll to a linked turn once it has streamed in.
    if (target !== null && scrolledTo.current !== target) {
      const el = document.getElementById(`turn-${target}`);
      if (el) {
        scrolledTo.current = target;
        setFollowing(false);
        el.scrollIntoView({ block: 'start' });
        return;
      }
    }
    if (following) window.scrollTo({ top: document.body.scrollHeight });
  });

  if (!run) return <ErrorNote error={error} />;
  const active = ACTIVE.includes(run.status);
  const status = runStatus(run);
  const { items, todos } = transcript.current;
  const showProgress = transcript.current.turns > 0 || run.step === 'run';

  const act = (action: 'stop' | 'pause' | 'resume') => {
    setBusy(true);
    api(`/runs/${run.id}/${action}`, { body: {} })
      .then(() => setActionError(null), (e: Error) => setActionError(e.message))
      .finally(() => setBusy(false));
  };
  const giveClaudeAccess = () => {
    setBusy(true);
    api<NewApiToken>('/tokens', { method: 'POST', body: { name: `Claude: run ${run.id.slice(0, 8)}`, scope: 'read', expiresInMinutes: 480 } })
      .then(
        (made) => {
          setActionError(null);
          setBrief(claudeBrief({ origin: location.origin, token: made.token, expiresAt: made.view.expiresAt!, run }));
        },
        (e: Error) => setActionError(e.message),
      )
      .finally(() => setBusy(false));
  };
  const stop = () => {
    if (!confirm('Stop this run? The ticket gets the workshop/failed label, so it won’t start again until you remove it.')) return;
    act('stop');
  };
  const working = run.status === 'starting' || run.status === 'running';
  const pausedByYou = run.status === 'paused' && run.pauseReason === 'manual';

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
        <div className="row">
          <Link className="button" to={`/tickets/${run.ticketId}`}>
            Ticket lifecycle
          </Link>
          {run.mediaCount > 0 && (
            <Link className="button" to={`/tickets/${run.ticketId}/media?run=${run.id}`}>
              View screenshots ({run.mediaCount})
            </Link>
          )}
          <a className="button" href={`/api/runs/${run.id}/export`} download>
            Export log
          </a>
          <button disabled={busy} onClick={giveClaudeAccess} title="Create a read-only API token and a brief to paste into Claude Code">
            Give Claude access
          </button>
          {working && !run.pauseRequested && (
            <button disabled={busy} onClick={() => act('pause')} title="Stop after the current step and free the host until you resume it">
              Pause
            </button>
          )}
          {working && run.pauseRequested && (
            <button disabled={busy} onClick={() => act('resume')}>
              Keep working
            </button>
          )}
          {run.status === 'paused' && !pausedByYou && (
            <button disabled={busy} onClick={() => act('pause')} title="Stay paused after the limit resets, until you resume it">
              Keep paused
            </button>
          )}
          {pausedByYou && (
            <button className="primary" disabled={busy} onClick={() => act('resume')}>
              Resume
            </button>
          )}
          {active && (
            <button className="danger" onClick={stop}>
              Stop
            </button>
          )}
        </div>
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
        {run.status === 'paused' && run.pauseReason === 'threshold' && <span>Resumes when usage is under your limit{run.resetsAt ? `, by ${clock(run.resetsAt)}` : ''}</span>}
        {run.status === 'paused' && (run.pauseReason ?? 'limit') === 'limit' && run.resetsAt && <span>Resumes after {clock(run.resetsAt)}</span>}
        {run.status === 'paused' && run.pauseReason === 'connection' && <span>Moving to another Claude subscription</span>}
        {working && run.pauseRequested && <span>Pauses after the current step</span>}
      </div>
      {pausedByYou && (
        <p className="small muted">Resuming continues the same conversation; its first step re-reads the conversation so far, which uses some extra usage.</p>
      )}
      {brief && (
        <Panel title="Brief for Claude Code">
          <div className="panel-body stack">
            <textarea readOnly rows={14} className="mono" value={brief} aria-label="Brief for Claude Code" onFocus={(e) => e.target.select()} />
            <div className="row">
              <button type="button" className="primary" onClick={() => void navigator.clipboard?.writeText(brief)}>
                Copy
              </button>
              <button type="button" onClick={() => setBrief(null)}>
                Close
              </button>
              <span className="small muted">Read-only, expires in 8 hours. Revoke it in Settings → API tokens. Workshop won't show this token again.</span>
            </div>
          </div>
        </Panel>
      )}
      <ErrorNote error={actionError} />
      {run.error && <p className="notice error">{run.error}</p>}
      {run.summary && <Markdown className="notice ok" text={run.summary} />}
      {showProgress && <RunProgress run={run} t={transcript.current} now={now} />}
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
        {items.length ? (
          items.map((item, i) => (
            <div key={i} className={`line${item.turn && item.turn === target ? ' target' : ''}`} id={item.turn ? `turn-${item.turn}` : undefined}>
              {/* The number is drawn by CSS from data-turn, so it never ends up in copied text. */}
              {item.turn ? <a className="turn-no" href={`#turn-${item.turn}`} data-turn={item.turn} aria-label={`Turn ${item.turn}`} /> : <span className="turn-no" />}
              <ItemView item={item} />
            </div>
          ))
        ) : (
          <p className="muted">{active ? 'Waiting for output…' : 'No log for this run.'}</p>
        )}
      </div>
      {active && !following && (
        <button className="primary" style={{ position: 'fixed', right: 24, bottom: 24 }} onClick={() => window.scrollTo({ top: document.body.scrollHeight })}>
          Jump to live
        </button>
      )}
    </div>
  );
}
