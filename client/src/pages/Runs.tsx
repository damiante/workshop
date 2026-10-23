import { Link } from 'react-router';
import type { RunView } from '../../../server/src/api-types.ts';
import { useApi, useNow } from '../api.ts';
import { ErrorNote, Status } from '../components/ui.tsx';
import { AGENT_LABEL, clock, duration, money, RUN_STATUS, tokens } from '../format.ts';

export function Runs() {
  const { data, error } = useApi<RunView[]>('/runs', ['runs']);
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
                <th>Usage</th>
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
                    <Status tone={RUN_STATUS[r.status].tone}>{RUN_STATUS[r.status].label}</Status>
                  </td>
                  <td className="small">{duration(r.startedAt, r.endedAt ?? now)}</td>
                  <td className="small muted">
                    {tokens((r.inputTokens ?? 0) + (r.outputTokens ?? 0) || null)}
                    {r.billing === 'api' && r.costUsd !== null && <div>{money(r.costUsd)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
