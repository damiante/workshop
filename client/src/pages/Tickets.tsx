import { useState } from 'react';
import { Link } from 'react-router';
import type { Push, TicketView } from '../../../server/src/api-types.ts';
import { api, useApi } from '../api.ts';
import { ErrorNote, Status } from '../components/ui.tsx';

const COLUMNS: { title: string; match: (t: TicketView) => boolean }[] = [
  { title: 'To classify', match: (t) => t.stage === null || t.stage === 'reclassify' },
  { title: 'Design', match: (t) => t.stage === 'design' },
  { title: 'Design review', match: (t) => t.stage === 'design-review' },
  { title: 'Implementation', match: (t) => t.stage === 'implement' },
  { title: 'Your review', match: (t) => t.stage === 'pr-review' },
  { title: 'Merge', match: (t) => t.stage === 'merge' },
];

const FILTERS: { label: string; match: (t: TicketView) => boolean }[] = [
  { label: 'All', match: () => true },
  { label: 'Needs you', match: (t) => t.needsInfo || t.stage === 'pr-review' },
  { label: 'Running', match: (t) => Boolean(t.activeRunId) },
  { label: 'Failed', match: (t) => t.failed },
  { label: 'Skipped', match: (t) => t.skipped },
];

function TicketStatus({ t }: { t: TicketView }) {
  if (t.activeRunId) {
    return (
      <Link to={`/runs/${t.activeRunId}`}>
        <Status tone="running">Agent working</Status>
      </Link>
    );
  }
  if (t.failed) return <Status tone="error">Stopped after failures</Status>;
  if (t.needsInfo) return <Status tone="attention">Waiting for your answer</Status>;
  if (t.skipped) return <Status tone="idle">Skipped</Status>;
  return null;
}

function PushControls({ t }: { t: TicketView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = (init: { method?: string; body?: unknown }) => {
    setBusy(true);
    setError(null);
    api(`/tickets/${t.id}/push`, init)
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const push = (scope: Push) => send({ body: { scope } });
  return (
    <>
      {t.push ? (
        <div className="row small">
          <span className="muted">Pushed: {t.push === 'stage' ? 'next stage only' : 'until it needs you'}</span>
          <button onClick={() => send({ method: 'DELETE' })} disabled={busy}>
            Cancel push
          </button>
        </div>
      ) : (
        t.next &&
        t.stage !== 'pr-review' && (
          <div className="row small">
            {!t.activeRunId && (
              <button onClick={() => push('stage')} disabled={busy}>
                Run next stage
              </button>
            )}
            <button onClick={() => push('lifecycle')} disabled={busy}>
              Run until it needs you
            </button>
          </div>
        )
      )}
      <ErrorNote error={error} />
    </>
  );
}

function Card({ t }: { t: TicketView }) {
  return (
    <article className="card">
      <div className="spread small muted">
        <span>
          {t.repo}#{t.number}
        </span>
        {t.size && <span className="tag">{t.size.toUpperCase()}</span>}
      </div>
      <a href={t.url} target="_blank" rel="noreferrer">
        {t.title}
      </a>
      <TicketStatus t={t} />
      {t.prUrl && (
        <a className="small" href={t.prUrl} target="_blank" rel="noreferrer">
          Pull request #{t.prNumber}
          {t.prStatus === 'conflict' ? ' (conflicts)' : t.prStatus === 'blocked' ? ' (waiting for checks)' : ''}
        </a>
      )}
      {t.next && !t.activeRunId && <span className="small muted">Next: {t.next}</span>}
      <PushControls t={t} />
    </article>
  );
}

export function Tickets() {
  const { data, error } = useApi<TicketView[]>('/tickets', ['tickets', 'runs']);
  const [repo, setRepo] = useState('');
  const [filter, setFilter] = useState(FILTERS[0]);
  const [syncing, setSyncing] = useState(false);
  const repos = [...new Set((data ?? []).map((t) => t.repo))].sort();
  const shown = (data ?? []).filter((t) => (!repo || t.repo === repo) && filter.match(t));

  const sync = () => {
    setSyncing(true);
    api('/sync', { body: {} }).finally(() => setTimeout(() => setSyncing(false), 1500));
  };

  return (
    <div className="stack">
      <div className="spread">
        <h1>Tickets</h1>
        <button onClick={sync} disabled={syncing}>
          {syncing ? 'Syncing…' : 'Sync now'}
        </button>
      </div>
      <div className="row">
        <select value={repo} onChange={(e) => setRepo(e.target.value)} style={{ width: 'auto' }} aria-label="Repository">
          <option value="">All repositories</option>
          {repos.map((r) => (
            <option key={r}>{r}</option>
          ))}
        </select>
        <div className="segmented" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button key={f.label} aria-pressed={f === filter} onClick={() => setFilter(f)}>
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <ErrorNote error={error} />
      {data && !data.length && (
        <p className="notice">
          No open tickets from your ticket authors in enabled repositories yet. Check <Link to="/connections">Connections</Link> and{' '}
          <Link to="/settings">Settings</Link>, or open an issue on GitHub.
        </p>
      )}
      <div className="board">
        {COLUMNS.map((col) => {
          const tickets = shown.filter(col.match);
          return (
            <section key={col.title} className="column" aria-label={col.title}>
              <h3>
                {col.title} <span className="muted">{tickets.length}</span>
              </h3>
              {tickets.map((t) => (
                <Card key={t.id} t={t} />
              ))}
            </section>
          );
        })}
      </div>
    </div>
  );
}
