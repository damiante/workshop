import { Link } from 'react-router';
import type { AlertView } from '../../../server/src/api-types.ts';
import { api, useApi } from '../api.ts';
import { ErrorNote, Panel, Status } from '../components/ui.tsx';
import { clock } from '../format.ts';

export function Alerts() {
  const { data, error, reload } = useApi<AlertView[]>('/alerts', ['alerts']);
  const open = (data ?? []).filter((a) => !a.ackAt);
  const done = (data ?? []).filter((a) => a.ackAt);
  const ack = (path: string) => api(path, { body: {} }).then(reload);

  const list = (alerts: AlertView[], acknowledgeable: boolean) => (
    <ul className="list">
      {alerts.map((a) => (
        <li key={a.id} className="spread">
          <div className="stack grow" style={{ gap: 2 }}>
            <Status tone={a.level === 'error' ? 'error' : a.level === 'warning' ? 'attention' : 'idle'}>{a.message}</Status>
            <span className="small muted">{clock(a.createdAt)}</span>
            {a.runId && <Link to={`/runs/${a.runId}`}>View run</Link>}
          </div>
          {acknowledgeable && <button onClick={() => ack(`/alerts/${a.id}/ack`)}>Acknowledge</button>}
        </li>
      ))}
    </ul>
  );

  return (
    <div className="stack">
      <h1>Alerts</h1>
      <ErrorNote error={error} />
      <Panel title="Open" action={open.length > 1 && <button onClick={() => ack('/alerts/ack-all')}>Acknowledge all</button>}>
        {open.length ? list(open, true) : <p className="empty">No open alerts.</p>}
      </Panel>
      {done.length > 0 && <Panel title="Earlier">{list(done, false)}</Panel>}
    </div>
  );
}
