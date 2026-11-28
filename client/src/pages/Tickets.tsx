import { useState } from 'react';
import { Link } from 'react-router';
import type { Push, Size, Stage, TicketStatePatch, TicketView } from '../../../server/src/api-types.ts';
import { api, useApi } from '../api.ts';
import { SyncButton } from '../components/SyncButton.tsx';
import { ErrorNote, Modal, Status } from '../components/ui.tsx';
import { STAGE_TEXT, ticketStatus } from '../format.ts';

export const COLUMNS: { title: string; match: (t: TicketView) => boolean }[] = [
  { title: 'To classify', match: (t) => t.stage === null || t.stage === 'reclassify' },
  { title: 'Design', match: (t) => t.stage === 'design' },
  { title: 'Design review', match: (t) => t.stage === 'design-review' },
  { title: 'Implementation', match: (t) => t.stage === 'implement' },
  { title: 'Code review', match: (t) => t.stage === 'code-review' },
  { title: 'Your review', match: (t) => t.stage === 'pr-review' },
  // Reconcile is rare and the Merge agent works it, so it shares the Merge column.
  { title: 'Merge', match: (t) => t.stage === 'merge' || t.stage === 'reconcile' },
];

const FILTERS: { label: string; match: (t: TicketView) => boolean }[] = [
  { label: 'All', match: (t) => !t.skipped },
  { label: 'Needs you', match: (t) => !t.skipped && (t.needsInfo || (t.stage === 'pr-review' && t.prStatus !== 'changes_requested')) },
  { label: 'Running', match: (t) => !t.skipped && Boolean(t.activeRunId) },
  { label: 'Failed', match: (t) => !t.skipped && t.failed },
  { label: 'Skipped', match: (t) => t.skipped },
];

export function TicketStatus({ t }: { t: TicketView }) {
  const status = ticketStatus(t);
  if (!status) return null;
  const shown = <Status tone={status.tone}>{status.text}</Status>;
  return t.activeRunId ? <Link to={`/runs/${t.activeRunId}`}>{shown}</Link> : shown;
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

const STAGE_OPTIONS: { value: Stage | ''; text: string }[] = [
  { value: '', text: 'To classify' },
  ...(Object.entries(STAGE_TEXT) as [Stage, string][]).map(([value, text]) => ({ value, text })),
];
const SIZE_OPTIONS: Size[] = ['xs', 's', 'm', 'l', 'xl'];

function StatusEditor({ t, onClose }: { t: TicketView; onClose: () => void }) {
  const [stage, setStage] = useState<Stage | ''>(t.stage ?? '');
  const [size, setSize] = useState<Size | ''>(t.size ?? '');
  const [needsInfo, setNeedsInfo] = useState(t.needsInfo);
  const [skip, setSkip] = useState(t.skipped);
  const [failed, setFailed] = useState(t.failed);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch: TicketStatePatch = {};
  if (stage !== (t.stage ?? '')) patch.stage = stage || null;
  if (size !== (t.size ?? '')) patch.size = size || null;
  if (needsInfo !== t.needsInfo) patch.needsInfo = needsInfo;
  if (skip !== t.skipped) patch.skip = skip;
  if (failed !== t.failed) patch.failed = failed;
  const changed = Object.keys(patch).length > 0;
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    api(`/tickets/${t.id}/state`, { method: 'PUT', body: patch })
      .then(onClose)
      .catch((err: Error) => {
        setError(err.message);
        setBusy(false);
      });
  };
  return (
    <Modal title={`Change status of #${t.number}`} onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <label className="field">
          <span>Stage</span>
          <select value={stage} onChange={(e) => setStage(e.target.value as Stage | '')}>
            {STAGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.text}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Size</span>
          <select value={size} onChange={(e) => setSize(e.target.value as Size | '')}>
            <option value="">Not sized</option>
            {SIZE_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {s.toUpperCase()}
              </option>
            ))}
          </select>
        </label>
        <label className="row">
          <input type="checkbox" checked={needsInfo} onChange={(e) => setNeedsInfo(e.target.checked)} />
          <span>Waiting for your answer (needs-info)</span>
        </label>
        <label className="row">
          <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
          <span>Skipped</span>
        </label>
        <label className="row">
          <input type="checkbox" checked={failed} onChange={(e) => setFailed(e.target.checked)} />
          <span>Stopped after failures</span>
        </label>
        <p className="small muted">Workshop changes the issue's workshop labels. The next stage starts when Workshop's mode allows it.</p>
        <ErrorNote error={error} />
        <div className="row">
          <button className="primary" disabled={busy || !changed}>
            {busy ? 'Saving…' : 'Save labels on GitHub'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function NominateControls({ t }: { t: TicketView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (t.nominated === null || (t.nominated === false && t.state !== 'open')) return null;
  const send = (nominated: boolean) => {
    setBusy(true);
    setError(null);
    api(`/tickets/${t.id}/nominated`, { method: 'PUT', body: { nominated } })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <div className="row small">
        {t.nominated ? (
          <>
            <span className="muted">Nominated</span>
            <button onClick={() => send(false)} disabled={busy}>
              Withdraw nomination
            </button>
          </>
        ) : (
          <button onClick={() => send(true)} disabled={busy}>
            Nominate
          </button>
        )}
      </div>
      <ErrorNote error={error} />
    </>
  );
}

function PriorityControls({ t }: { t: TicketView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (t.state !== 'open' && !t.prioritised) return null;
  const send = (prioritised: boolean) => {
    setBusy(true);
    setError(null);
    api(`/tickets/${t.id}/prioritised`, { method: 'PUT', body: { prioritised } })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <div className="row small">
        {t.prioritised ? (
          <>
            <span className="muted">Prioritised</span>
            <button onClick={() => send(false)} disabled={busy}>
              Remove priority
            </button>
          </>
        ) : (
          <button onClick={() => send(true)} disabled={busy}>
            Prioritise
          </button>
        )}
      </div>
      <ErrorNote error={error} />
    </>
  );
}

function BypassControls({ t }: { t: TicketView }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (t.state !== 'open' && !t.bypassLimits) return null;
  const send = (bypassLimits: boolean) => {
    setBusy(true);
    setError(null);
    api(`/tickets/${t.id}/bypass-limits`, { method: 'PUT', body: { bypassLimits } })
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };
  const title = 'Agents on this ticket keep going past your 5-hour and weekly limits. Limits Claude reports still stop them.';
  return (
    <>
      <div className="row small">
        {t.bypassLimits ? (
          <>
            <span className="muted">Ignores usage limits</span>
            <button onClick={() => send(false)} disabled={busy}>
              Respect usage limits
            </button>
          </>
        ) : (
          <button onClick={() => send(true)} disabled={busy} title={title}>
            Ignore usage limits
          </button>
        )}
      </div>
      <ErrorNote error={error} />
    </>
  );
}

/** Explicit priority first, then tickets prioritised tickets wait on, then the rest. */
const priorityRank = (t: TicketView) => (t.prioritised ? 2 : t.prioritisedFor.length ? 1 : 0);

/** The tag a ticket gets when prioritised tickets wait on it; explicit priority has its own tag. */
export function PrioritisedForTag({ t }: { t: TicketView }) {
  if (t.prioritised || !t.prioritisedFor.length) return null;
  const refs = t.prioritisedFor.map((r) => r.ref).join(', ');
  const verb = t.prioritisedFor.length > 1 ? 'are' : 'is';
  return (
    <span className="tag" title={`${refs} ${verb} prioritised and depend${verb === 'is' ? 's' : ''} on this ticket`}>
      Prioritised for {refs}
    </span>
  );
}

function Card({ t }: { t: TicketView }) {
  const [editing, setEditing] = useState(false);
  return (
    <article className={t.prioritised ? 'card prioritised' : 'card'}>
      <div className="spread small muted">
        <Link to={`/tickets/${t.id}`}>
          {t.repo}#{t.number}
        </Link>
        <span className="row">
          {t.prioritised && <span className="tag">Prioritised</span>}
          <PrioritisedForTag t={t} />
          {t.bypassLimits && <span className="tag">Ignores limits</span>}
          {t.size && <span className="tag">{t.size.toUpperCase()}</span>}
        </span>
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
      {t.mediaCount > 0 && (
        <Link className="small" to={`/tickets/${t.id}/media`}>
          Screenshots ({t.mediaCount})
        </Link>
      )}
      {t.next && !t.activeRunId && <span className="small muted">Next: {t.next}</span>}
      {!t.activeRunId && (
        <div className="row small">
          <button onClick={() => setEditing(true)}>Change status</button>
        </div>
      )}
      {editing && <StatusEditor t={t} onClose={() => setEditing(false)} />}
      <NominateControls t={t} />
      {t.nominated !== false && (
        <>
          <PriorityControls t={t} />
          <BypassControls t={t} />
          <PushControls t={t} />
        </>
      )}
    </article>
  );
}

export function Tickets() {
  const { data, error } = useApi<TicketView[]>('/tickets', ['tickets', 'runs']);
  const [repo, setRepo] = useState('');
  const [filter, setFilter] = useState(FILTERS[0]);
  const repos = [...new Set((data ?? []).map((t) => t.repo))].sort();
  const shown = (data ?? []).filter((t) => (!repo || t.repo === repo) && filter.match(t));

  return (
    <div className="stack">
      <div className="spread">
        <div className="row">
          <h1>Tickets</h1>
          <Link to="/dependencies">Dependencies</Link>
        </div>
        <SyncButton action="/sync" label="Sync now" title="Sync tickets from GitHub now" />
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
      {filter.label === 'Skipped' && (
        <p className="muted small">Workshop leaves skipped tickets alone. To bring one back, remove the workshop/skip label or use Change status.</p>
      )}
      <ErrorNote error={error} />
      {data && !data.length && (
        <p className="notice">
          No open tickets from your ticket authors in enabled repositories yet. Check <Link to="/connections">Connections</Link> and{' '}
          <Link to="/settings">Settings</Link>, or open an issue on GitHub.
        </p>
      )}
      <div className="board">
        {COLUMNS.map((col) => {
          const tickets = shown.filter(col.match).sort((a, b) => priorityRank(b) - priorityRank(a));
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
