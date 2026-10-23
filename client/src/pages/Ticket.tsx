import { Link, useParams } from 'react-router';
import type { MediaItem, RunView, TicketLifecycle } from '../../../server/src/api-types.ts';
import { useApi, useNow } from '../api.ts';
import { ErrorNote, Panel, Status } from '../components/ui.tsx';
import { AGENT_LABEL, clock, duration, RUN_STATUS, STAGE_TEXT } from '../format.ts';
import { TicketStatus } from './Tickets.tsx';

const stageText = (r: RunView) => AGENT_LABEL[r.agent] + (r.mode === 'delta' ? ', requested changes' : '') + (r.attempt > 1 ? `, attempt ${r.attempt}` : '');

function Thumbs({ items }: { items: MediaItem[] }) {
  return (
    <div className="media-grid thumbs">
      {items.map((m) => (
        <figure key={m.name}>
          <a href={m.url} target="_blank" rel="noreferrer">
            <img src={m.url} alt={m.caption ?? m.name} loading="lazy" />
          </a>
          <figcaption className="small muted">{m.caption ?? m.name}</figcaption>
        </figure>
      ))}
    </div>
  );
}

export function Ticket() {
  const { id } = useParams();
  const { data, error } = useApi<TicketLifecycle>(`/tickets/${id}`, ['tickets', 'runs', 'media']);
  const now = useNow();
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;
  const { ticket: t, runs, media } = data;
  const runIds = new Set(runs.map((r) => r.id));
  const loose = media.filter((m) => !m.runId || !runIds.has(m.runId));
  return (
    <div className="stack">
      <div className="stack" style={{ gap: 4 }}>
        <h1>
          {t.repo}#{t.number}
        </h1>
        <a href={t.url} target="_blank" rel="noreferrer">
          {t.title}
        </a>
        <div className="row small">
          <span className="tag">{t.stage ? STAGE_TEXT[t.stage] : 'To classify'}</span>
          {t.size && <span className="tag">{t.size.toUpperCase()}</span>}
          {t.state === 'closed' && <span className="muted">Closed</span>}
          <TicketStatus t={t} />
          {t.prUrl && (
            <a href={t.prUrl} target="_blank" rel="noreferrer">
              Pull request #{t.prNumber}
            </a>
          )}
          {media.length > 0 && <Link to={`/tickets/${t.id}/media`}>Screenshots ({media.length})</Link>}
        </div>
      </div>
      <Panel title="Lifecycle">
        {runs.length || loose.length ? (
          <ol className="list lifecycle">
            {loose.length > 0 && (
              <li className="stack" style={{ gap: 4 }}>
                <strong>From the issue and earlier runs</strong>
                <Thumbs items={loose} />
              </li>
            )}
            {runs.map((r) => {
              const status = RUN_STATUS[r.status];
              const shots = media.filter((m) => m.runId === r.id);
              return (
                <li key={r.id} className="stack" style={{ gap: 4 }}>
                  <div className="spread">
                    <Link to={`/runs/${r.id}`}>{stageText(r)}</Link>
                    <Status tone={status.tone}>{status.label}</Status>
                  </div>
                  <div className="row small muted">
                    <span>{clock(r.startedAt)}</span>
                    <span>for {duration(r.startedAt, r.endedAt ?? now)}</span>
                    <span>{r.model}</span>
                    <span>on {r.environment ?? 'a removed host'}</span>
                  </div>
                  {r.activity && <span className="mono muted">{r.activity}</span>}
                  {r.summary && <span style={{ overflowWrap: 'anywhere' }}>{r.summary}</span>}
                  {r.error && <span style={{ color: 'var(--error-text)', overflowWrap: 'anywhere' }}>{r.error}</span>}
                  {shots.length > 0 && (
                    <>
                      <Thumbs items={shots} />
                      <Link className="small" to={`/tickets/${t.id}/media?run=${r.id}`}>
                        Open this run's screenshots
                      </Link>
                    </>
                  )}
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="empty">No agent has worked on this ticket yet. It starts when Workshop's mode and the queue allow it, or push it from the Tickets page.</p>
        )}
      </Panel>
      <p className="small muted">Finished runs are removed after the retention period in Settings, and screenshots when the ticket finishes.</p>
    </div>
  );
}
