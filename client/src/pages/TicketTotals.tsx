import { useState } from 'react';
import { Link } from 'react-router';
import type { DiffStats, TicketTotals } from '../../../server/src/api-types.ts';
import { useApi } from '../api.ts';
import { ErrorNote, Panel, Status } from '../components/ui.tsx';
import { money, STAGE_TEXT, tokens, when } from '../format.ts';

const FILTERS: { label: string; match: (t: TicketTotals) => boolean }[] = [
  { label: 'Completed', match: (t) => t.state === 'closed' },
  { label: 'In progress', match: (t) => t.state === 'open' },
  { label: 'All', match: () => true },
];

const hours = (ms: number) => (ms < 3600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3600_000).toFixed(1)} h`);

/** Lines added and removed, and how many files, e.g. "+120 −14, 3 files". Non-breaking, so it stays on one line. */
export const diffText = (d: DiffStats | null) => (d ? `+${d.additions}\u00a0−${d.deletions},\u00a0${d.files}\u00a0${d.files === 1 ? 'file' : 'files'}` : '–');

function State({ t }: { t: TicketTotals }) {
  if (t.working) return <Status tone="running">Agent working</Status>;
  if (t.state === 'closed') return <Status tone={t.skipped ? 'idle' : 'ok'}>{t.skipped ? 'Closed, skipped' : 'Done'}</Status>;
  if (t.failed) return <Status tone="error">Stopped after failures</Status>;
  if (t.skipped) return <Status tone="idle">Skipped</Status>;
  return <Status tone="idle">{t.stage ? STAGE_TEXT[t.stage] : 'To classify'}</Status>;
}

/** Every ticket agents have worked on, finished ones included, with what its runs added up to. */
export function TicketTotalsPage() {
  const { data, error } = useApi<TicketTotals[]>('/ticket-totals', ['tickets', 'runs']);
  const [filter, setFilter] = useState(FILTERS[0]);
  const shown = (data ?? []).filter(filter.match);
  const sum = (pick: (t: TicketTotals) => number) => shown.reduce((n, t) => n + pick(t), 0);
  const total: DiffStats = { files: sum((t) => t.diff?.files ?? 0), additions: sum((t) => t.diff?.additions ?? 0), deletions: sum((t) => t.diff?.deletions ?? 0) };
  return (
    <div className="stack">
      <div className="row">
        <h1>Ticket totals</h1>
        <Link to="/tickets">Board</Link>
      </div>
      <div className="segmented" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.label} aria-pressed={f === filter} onClick={() => setFilter(f)}>
            {f.label}
          </button>
        ))}
      </div>
      <ErrorNote error={error} />
      {data && !shown.length && <p className="notice">{data.length ? 'No tickets here.' : 'No agent has worked on a ticket yet.'}</p>}
      {shown.length > 0 && (
        <Panel title={`${shown.length} ${shown.length === 1 ? 'ticket' : 'tickets'}`}>
          <p className="panel-body small muted" style={{ paddingBottom: 0 }}>
            {sum((t) => t.runs)} runs, {hours(sum((t) => t.agentMs))} of agent time, {sum((t) => t.turns ?? 0).toLocaleString()} turns, {money(sum((t) => t.costUsd ?? 0))} at API prices, {diffText(total)}.
            Finished runs are removed after the retention period, so an old ticket's totals cover the runs that are left.
          </p>
          <div className="table-wrap">
            <table className="spend-table" style={{ tableLayout: 'auto' }}>
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>State</th>
                  <th>Finished</th>
                  <th className="num">Runs</th>
                  <th className="num">Agent time</th>
                  <th className="num">Turns</th>
                  <th className="num">Tokens</th>
                  <th className="num">Cost</th>
                  <th className="num" title="The ticket's branch against the default branch after its last push">
                    Final diff
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((t) => (
                  <tr key={t.ticketId}>
                    <td>
                      <Link to={`/tickets/${t.ticketId}`}>{t.ticket}</Link>
                      {t.size && <span className="muted"> {t.size.toUpperCase()}</span>}
                      <div className="small muted">{t.title}</div>
                    </td>
                    <td>
                      <State t={t} />
                    </td>
                    <td className="small">{t.lastEndedAt ? when(t.lastEndedAt) : '–'}</td>
                    <td className="num">
                      {t.runs}
                      {t.failedRuns > 0 && <span className="cell-sub small muted">{t.failedRuns} failed</span>}
                    </td>
                    <td className="num">{hours(t.agentMs)}</td>
                    <td className="num">{t.turns ?? '–'}</td>
                    <td className="num">{tokens(t.tokens || null)?.replace(' tokens', '') ?? '–'}</td>
                    <td className="num">{t.costUsd ? money(t.costUsd) : '–'}</td>
                    <td className="num">{diffText(t.diff)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
