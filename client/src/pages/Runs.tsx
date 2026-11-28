import { Link } from 'react-router';
import type { RunView } from '../../../server/src/api-types.ts';
import { useApi, useNow } from '../api.ts';
import { ErrorNote, Status } from '../components/ui.tsx';
import { AGENT_LABEL, clock, duration, money, runStatus, tokens } from '../format.ts';
import { diffText } from './TicketTotals.tsx';

export function Runs() {
  const { data, error } = useApi<RunView[]>('/runs', ['runs', 'activity']);
  const now = useNow();
  return (
    <div className="stack">
      <h1>Runs</h1>
      <ErrorNote error={error} />
      {data && !data.length && <p className="notice">No agent has run yet.</p>}
      {data && data.length > 0 && (
        <div className="panel table-wrap">
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Ticket</th>
                <th>Agent</th>
                <th>Model</th>
                <th>Host</th>
                <th>Status</th>
                <th>Took</th>
                <th>Turns</th>
                <th>Usage</th>
                <th title="The ticket's branch against the default branch after this run's push">Changes</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/runs/${r.id}`}>{clock(r.startedAt)}</Link>
                  </td>
                  <td>
                    <Link to={`/tickets/${r.ticketId}`}>{r.ticket}</Link>
                    <div className="small muted">{r.ticketTitle}</div>
                  </td>
                  <td>
                    {AGENT_LABEL[r.agent]}
                    {r.attempt > 1 && <div className="small muted">attempt {r.attempt}</div>}
                  </td>
                  <td className="small">{r.model}</td>
                  <td className="small">{r.environment ?? '–'}</td>
                  <td>
                    <Status tone={runStatus(r).tone}>{runStatus(r).label}</Status>
                  </td>
                  <td className="small">{duration(r.startedAt, r.endedAt ?? now)}</td>
                  <td className="small">{r.turns ?? '–'}</td>
                  <td className="small muted">
                    {tokens((r.inputTokens ?? 0) + (r.outputTokens ?? 0) || null)}
                    {r.costUsd ? <div title={r.billing === 'api' ? undefined : 'At API prices'}>{money(r.costUsd)}</div> : null}
                  </td>
                  <td className="small">{diffText(r.diff)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
