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
        <div className="brand">
          Workshop
          {/* Traced from workshop-logo.png; colours follow the theme tokens. */}
          <svg viewBox="30 50 740 660" width="26" height="23" aria-hidden="true">
            <clipPath id="logo-walls">
              <path d="M85 310 225 262V685L85 640ZM225 262 458 120 700 268V665L225 685Z" />
            </clipPath>
            <path d="M85 310 225 262V685L85 640ZM225 262 458 120 700 268V665L225 685Z" fill="var(--muted)" />
            <g stroke="var(--text)" strokeOpacity="0.3" clipPath="url(#logo-walls)">
              <path d="M163 0V800M300 0V800M375 0V800M450 0V800M520 0V800M582 0V800M640 0V800" strokeWidth="10" />
              <path d="M100 0V800M692 0V800" strokeWidth="26" />
            </g>
            <path d="M35 270 210 160 460 55 762 245 748 282 458 100 45 302Z" fill="var(--text)" />
            <path d="M45 302 458 100 748 282M225 262V685M318 278H588V668" fill="none" stroke="var(--bg)" strokeWidth="22" strokeLinejoin="round" />
            <rect x="329" y="289" width="248" height="380" fill="var(--text)" />
            <path d="M488 355 578 305V698L488 655Z" fill="var(--text)" stroke="var(--bg)" strokeWidth="14" strokeLinejoin="round" />
            <circle cx="516" cy="510" r="11" fill="var(--bg)" />
            <path d="M365 318H475L458 343H350Z" fill="var(--attention)" />
          </svg>
        </div>
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
