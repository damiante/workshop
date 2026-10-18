import { Link } from 'react-router';
import type { ConnectionView, Overview, RepoView, RunView, Settings, TicketView } from '../../../server/src/api-types.ts';
import { useApi, useNow } from '../api.ts';
import { ErrorNote, Panel, Status } from '../components/ui.tsx';
import { AGENT_LABEL, clock, duration, RUN_STATUS } from '../format.ts';

function RunLine({ run, now }: { run: RunView; now: number }) {
  const status = RUN_STATUS[run.status];
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="spread">
        <Link to={`/runs/${run.id}`}>
          {AGENT_LABEL[run.agent]} on {run.ticket}
        </Link>
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

function NeedsYou({ ticket }: { ticket: TicketView }) {
  const [text, href] = ticket.needsInfo
    ? ['Answer the question on the ticket, then remove the workshop/needs-info label', ticket.url]
    : ticket.failed
      ? ['Stopped after failures. Read the comment, then remove workshop/failed to retry', ticket.url]
      : ['Review the pull request', ticket.prUrl ?? ticket.url];
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="spread">
        <a href={ticket.url} target="_blank" rel="noreferrer">
          {ticket.repo}#{ticket.number}
        </a>
        <Status tone={ticket.failed ? 'error' : 'attention'}>{ticket.failed ? 'Stopped' : ticket.needsInfo ? 'Question' : 'Review'}</Status>
      </div>
      <span>{ticket.title}</span>
      <a className="small" href={href} target="_blank" rel="noreferrer">
        {text}
      </a>
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
        </Panel>
        <Panel title="Up next" action={<Link to="/tickets">All tickets</Link>}>
          {data.queue.length ? (
            <ul className="list">
              {data.queue.slice(0, 8).map((q) => (
                <li key={q.ticketId} className="stack" style={{ gap: 4 }}>
                  <div className="spread">
                    <span>
                      {q.ticket}: {q.title}
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
