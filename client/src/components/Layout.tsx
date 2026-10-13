import { useState } from 'react';
import { NavLink, Outlet } from 'react-router';
import type { Mode, Overview } from '../../../server/src/api-types.ts';
import { api, useApi } from '../api.ts';
import { ThemeToggle } from './ThemeToggle.tsx';
import { Meter } from './ui.tsx';

const MODES: { value: Mode; label: string }[] = [
  { value: 'paused', label: 'Paused' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'always', label: 'Always on' },
];

function ModeSwitch({ mode, withinHours }: { mode: Mode; withinHours: boolean }) {
  const [error, setError] = useState<string | null>(null);
  const set = (value: Mode) => api('/settings', { method: 'PUT', body: { mode: value } }).then(() => setError(null), (e: Error) => setError(e.message));
  const hint = mode === 'paused' ? 'No new agents start' : mode === 'scheduled' && !withinHours ? 'Outside operating hours' : null;
  return (
    <div className="row">
      <div className="segmented" role="group" aria-label="Operation mode">
        {MODES.map((m) => (
          <button key={m.value} aria-pressed={mode === m.value} onClick={() => set(m.value)}>
            {m.label}
          </button>
        ))}
      </div>
      {hint && <span className="muted small">{hint}</span>}
      {error && <span className="error-text small">{error}</span>}
    </div>
  );
}

export function Layout({ version }: { version: string }) {
  const { data } = useApi<Overview>('/overview', ['settings', 'allowance', 'alerts', 'runs', 'connections']);
  const signOut = () => api('/auth/logout', { body: {} }).finally(() => window.location.assign('/'));
  const openAlerts = data?.alerts.length ?? 0;
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">Workshop</div>
        <nav className="nav" aria-label="Main">
          <NavLink to="/" end>
            Dashboard
          </NavLink>
          <NavLink to="/tickets">Tickets</NavLink>
          <NavLink to="/runs">Runs</NavLink>
          <NavLink to="/connections">Connections</NavLink>
          <NavLink to="/agents">Agents</NavLink>
          <NavLink to="/settings">Settings</NavLink>
          <NavLink to="/alerts">
            Alerts
            {openAlerts > 0 && (
              <span className="badge" aria-label={`${openAlerts} open`}>
                {openAlerts}
              </span>
            )}
          </NavLink>
        </nav>
        <div className="sidebar-foot">
          <ThemeToggle />
          <button className="link small" onClick={signOut}>
            Sign out
          </button>
          <span className="muted small">Version {version}</span>
        </div>
      </aside>
      <div className="main">
        <header className="topbar">
          {data && <ModeSwitch mode={data.mode} withinHours={data.withinHours} />}
          {data?.allowance.map((a) => (
            <div key={a.connectionId} className="row">
              {data.allowance.length > 1 && <span className="small muted">{a.connectionName}</span>}
              {a.sampledAt ? (
                <>
                  <Meter label="5-hour" window={a.fiveHour} threshold={data.thresholds.fiveHour} />
                  <Meter label="Weekly" window={a.sevenDay} threshold={data.thresholds.weekly} />
                </>
              ) : (
                <span className="small muted">Allowance not checked yet</span>
              )}
            </div>
          ))}
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
