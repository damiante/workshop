import { useState } from 'react';
import { Link } from 'react-router';
import type { ConnectionView, Overview, RepoView, RunView, Settings, TicketView } from '../../../server/src/api-types.ts';
import { api, useApi, useNow } from '../api.ts';
import { ErrorNote, Panel, Status } from '../components/ui.tsx';
import { AGENT_LABEL, clock, duration, RUN_STATUS } from '../format.ts';

function RunLine({ run, now }: { run: RunView; now: number }) {
  const status = RUN_STATUS[run.status];
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="spread">
        <span>
          <Link to={`/runs/${run.id}`}>{AGENT_LABEL[run.agent]}</Link> on <Link to={`/tickets/${run.ticketId}`}>{run.ticket}</Link>
        </span>
        <Status tone={status.tone}>{status.label}</Status>
      </div>
      <span>{run.ticketTitle}</span>
      {run.activity && <span className="mono muted">{run.activity}</span>}
      <div className="row small muted">
        <span>{run.model}</span>
        <span>on {run.environment ?? 'a removed host'}</span>
        <span>for {duration(run.startedAt, now)}</span>
        {run.status === 'paused' && run.resetsAt && <span>resumes after {clock(run.resetsAt)}</span>}
      </div>
    </div>
  );
}

function NeedsYou({ ticket, dismissed }: { ticket: TicketView; dismissed?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, href] =
    ticket.attention === 'question'
      ? ['Answer the question on the ticket, then remove the workshop/needs-info label', ticket.url]
      : ticket.attention === 'failed'
        ? ['Stopped after failures. Read the comment, then remove workshop/failed to retry', ticket.url]
        : ['Review the pull request', ticket.prUrl ?? ticket.url];
  const toggle = () => {
    setBusy(true);
    setError(null);
    api(`/tickets/${ticket.id}/dismissed`, { method: 'PUT', body: { dismissed: !dismissed } })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  const name = `${ticket.repo}#${ticket.number}`;
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="spread">
        <a href={ticket.url} target="_blank" rel="noreferrer">
          {name}
        </a>
        <span className="row">
          <Status tone={ticket.attention === 'failed' ? 'error' : 'attention'}>
            {ticket.attention === 'failed' ? 'Stopped' : ticket.attention === 'question' ? 'Question' : 'Review'}
          </Status>
          <button
            className="link small"
            disabled={busy}
            onClick={toggle}
            aria-label={`${dismissed ? 'Bring back' : 'Dismiss'} ${name}`}
            title={dismissed ? undefined : 'Hide this until the ticket needs you for something new'}
          >
            {dismissed ? 'Bring back' : 'Dismiss'}
          </button>
        </span>
      </div>
      <Link to={`/tickets/${ticket.id}`}>{ticket.title}</Link>
      <a className="small" href={href} target="_blank" rel="noreferrer">
        {text}
      </a>
      {error && <span className="small error-text">{error}</span>}
    </div>
  );
}

function setupSteps(connections: ConnectionView[], repos: RepoView[], settings: Settings | undefined, overview: Overview) {
  const has = (kind: ConnectionView['kind']) => connections.some((c) => c.kind === kind);
  const steps: { text: string; to: string }[] = [];
  if (!has('vcs')) steps.push({ text: 'Connect GitHub', to: '/connections' });
  if (!has('environment')) steps.push({ text: 'Add an agent host (a machine with Docker)', to: '/connections' });
  if (!has('model')) steps.push({ text: 'Add Claude', to: '/connections' });
  if (has('vcs') && !repos.some((r) => r.enabled)) steps.push({ text: 'Choose the repositories Workshop works on', to: '/connections' });
  if (settings && !settings.authors.length) steps.push({ text: 'Add your GitHub username to ticket authors', to: '/settings' });
  if (!steps.length && overview.mode === 'paused') steps.push({ text: 'Workshop is paused. Switch it to Scheduled or Always on in the top bar when you’re ready.', to: '/settings' });
  return steps;
}

export function Dashboard() {
  const { data, error } = useApi<Overview>('/overview', ['runs', 'tickets', 'alerts', 'connections', 'settings', 'allowance', 'agents', 'repos']);
  const { data: connections } = useApi<ConnectionView[]>('/connections', ['connections']);
  const { data: repos } = useApi<RepoView[]>('/repos', ['repos']);
  const { data: settings } = useApi<Settings>('/settings', ['settings']);
  const now = useNow();
  const [showDismissed, setShowDismissed] = useState(false);
  if (!data) return <ErrorNote error={error} />;

  const steps = setupSteps(connections ?? [], repos ?? [], settings, data);
  const waiting = data.queue.find((q) => q.blockedBy);
  return (
    <div className="stack">
      <h1>Dashboard</h1>
      {steps.length > 0 && (
        <Panel title="Finish setting up">
          <ul className="list">
            {steps.map((s) => (
              <li key={s.text}>
                <Link to={s.to}>{s.text}</Link>
              </li>
            ))}
          </ul>
        </Panel>
      )}
      <div className="grid-2">
        <Panel title="Running">
          {data.running.length ? (
            <ul className="list">
              {data.running.map((r) => (
                <li key={r.id}>
                  <RunLine run={r} now={now} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">{waiting ? `Nothing running. Next up is waiting: ${waiting.blockedBy}.` : 'Nothing running, and nothing waiting.'}</p>
          )}
        </Panel>
        <Panel title="Needs you">
          {data.needsYou.length ? (
            <ul className="list">
              {data.needsYou.map((t) => (
                <li key={t.id}>
                  <NeedsYou ticket={t} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">Nothing is waiting on you.</p>
          )}
          {data.dismissed.length > 0 && (
            <>
              <button className="link small" style={{ padding: '8px 16px' }} onClick={() => setShowDismissed(!showDismissed)}>
                {showDismissed ? 'Hide dismissed' : `Show ${data.dismissed.length} dismissed`}
              </button>
              {showDismissed && (
                <ul className="list">
                  {data.dismissed.map((t) => (
                    <li key={t.id}>
                      <NeedsYou ticket={t} dismissed />
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Panel>
        <Panel title="Up next" action={<Link to="/tickets">All tickets</Link>}>
          {data.queue.length ? (
            <ul className="list">
              {data.queue.slice(0, 8).map((q) => (
                <li key={q.ticketId} className="stack" style={{ gap: 4 }}>
                  <div className="spread">
                    <span>
                      <Link to={`/tickets/${q.ticketId}`}>{q.ticket}</Link>: {q.title}
                    </span>
                    <span className="tag">{q.next}</span>
                  </div>
                  {q.push && <span className="small muted">Pushed by you</span>}
                  {q.blockedBy && <span className="small muted">Waiting: {q.blockedBy}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">No tickets are ready for an agent.</p>
          )}
        </Panel>
        <Panel title="Agent hosts" action={<Link to="/connections">Manage</Link>}>
          {data.hosts.length ? (
            <ul className="list">
              {data.hosts.map((h) => (
                <li key={h.id} className="stack" style={{ gap: 4 }}>
                  <div className="spread">
                    <span>{h.name}</span>
                    <Status tone={h.status === 'ok' ? 'ok' : h.status === 'error' ? 'error' : 'idle'}>
                      {h.status === 'ok' ? `${h.busy} of ${h.slots} in use` : h.status === 'error' ? 'Unreachable' : 'Not checked yet'}
                    </Status>
                  </div>
                  {!h.available && <span className="small muted">Switched off for new agents</span>}
                  {h.specs && <span className="small muted">{h.specs}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty">
              No agent hosts yet. <Link to="/connections">Add one</Link>.
            </p>
          )}
        </Panel>
      </div>
      {data.alerts.length > 0 && (
        <Panel title="Alerts" action={<Link to="/alerts">All alerts</Link>}>
          <ul className="list">
            {data.alerts.slice(0, 5).map((a) => (
              <li key={a.id} className="spread">
                <Status tone={a.level === 'error' ? 'error' : a.level === 'warning' ? 'attention' : 'idle'}>{a.message}</Status>
                <span className="small muted">
                  {a.runId && <Link to={`/runs/${a.runId}`}>View run</Link>} {clock(a.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
