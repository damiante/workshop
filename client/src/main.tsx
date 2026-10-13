import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import './theme.css';
import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import type { AuthState } from '../../server/src/api-types.ts';
import { api } from './api.ts';
import { Layout } from './components/Layout.tsx';
import { applyStoredTheme } from './components/ThemeToggle.tsx';
import { Agents } from './pages/Agents.tsx';
import { Alerts } from './pages/Alerts.tsx';
import { Connections } from './pages/Connections.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Login } from './pages/Login.tsx';
import { RunView } from './pages/RunView.tsx';
import { Runs } from './pages/Runs.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { Tickets } from './pages/Tickets.tsx';

applyStoredTheme();

function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);

  useEffect(() => {
    api<AuthState>('/auth/state').then(setAuth, () => setAuth({ authenticated: false, enrolled: true, version: '' }));
    const signedOut = () => setAuth((a) => (a ? { ...a, authenticated: false } : a));
    window.addEventListener('workshop:signed-out', signedOut);
    return () => window.removeEventListener('workshop:signed-out', signedOut);
  }, []);

  if (!auth) return null;
  if (!auth.authenticated) return <Login enrolled={auth.enrolled} onSignedIn={() => setAuth({ ...auth, authenticated: true, enrolled: true })} />;
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout version={auth.version} />}>
          <Route index element={<Dashboard />} />
          <Route path="tickets" element={<Tickets />} />
          <Route path="runs" element={<Runs />} />
          <Route path="runs/:id" element={<RunView />} />
          <Route path="connections" element={<Connections />} />
          <Route path="agents" element={<Agents />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="alerts" element={<Alerts />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
