import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { ApiTokenView, Limits, NewApiToken, Settings, TicketOrder, Usage } from '../../../server/src/api-types.ts';
import { TOKEN_LIFETIMES } from '../access.ts';
import { api, useApi, useNow } from '../api.ts';
import { ErrorNote, Panel } from '../components/ui.tsx';
import { ago, clock, money, tokens } from '../format.ts';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ORDERS: { value: TicketOrder; label: string }[] = [
  { value: 'updated-asc', label: 'Least recently updated first' },
  { value: 'updated-desc', label: 'Most recently updated first' },
  { value: 'created-asc', label: 'Oldest first' },
  { value: 'created-desc', label: 'Newest first' },
];
const ZONES = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

function NumberField({ label, help, value, min, max, step = 1, onChange }: { label: string; help?: ReactNode; value: number; min: number; max: number; step?: number; onChange: (n: number) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input type="number" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} required />
      {help && <span className="help">{help}</span>}
    </label>
  );
}

/** A weekday is enough for the next few days; further out needs the date. */
const expiry = (ms: number, now: number) => (ms - now < 6 * 86400_000 ? clock(ms) : new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' }));

function ApiTokens() {
  const { data, error } = useApi<ApiTokenView[]>('/tokens', ['tokens']);
  const [name, setName] = useState('');
  const [lifetime, setLifetime] = useState('1 day');
  const [readOnly, setReadOnly] = useState(false);
  const [created, setCreated] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const now = useNow();

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    try {
      const made = await api<NewApiToken>('/tokens', {
        method: 'POST',
        body: { name, scope: readOnly ? 'read' : 'write', expiresInMinutes: TOKEN_LIFETIMES.find((l) => l.label === lifetime)?.minutes ?? null },
      });
      setCreated(made.token);
      setName('');
    } catch (err) {
      setProblem((err as Error).message);
    }
  };
  const revoke = async (t: ApiTokenView) => {
    if (!confirm(`Revoke "${t.name}"? Anything using it stops working.`)) return;
    setProblem(null);
    try {
      await api(`/tokens/${t.id}`, { method: 'DELETE' });
    } catch (err) {
      setProblem((err as Error).message);
    }
  };

  return (
    <Panel title="API tokens">
      <div className="panel-body stack">
        <p className="small muted">Scripts and agents can use Workshop's API with a token. See docs/api.md.</p>
        <p className="small">
          API schema (OpenAPI):{' '}
          <a href="/api/openapi.json" target="_blank" rel="noreferrer">View</a>
          {' · '}
          <a href="/api/openapi.json" download="workshop-openapi.json">Download</a>
        </p>
        <ErrorNote error={error} />
        {data && data.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Access</th>
                  <th>Created</th>
                  <th>Last used</th>
                  <th>Expires</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td>{t.scope === 'read' ? 'Read only' : 'Full'}</td>
                    <td>{ago(t.createdAt)}</td>
                    <td>{t.lastUsedAt ? ago(t.lastUsedAt) : 'Never'}</td>
                    <td className={t.expiresAt !== null && t.expiresAt <= now ? 'muted' : undefined}>{t.expiresAt === null ? 'Never' : t.expiresAt <= now ? 'Expired' : expiry(t.expiresAt, now)}</td>
                    <td>
                      <button type="button" className="danger" onClick={() => void revoke(t)}>
                        Revoke
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {created && (
          <div className="stack">
            <div className="row">
              <input readOnly value={created} aria-label="New API token" style={{ flex: 1 }} onFocus={(e) => e.target.select()} />
              <button type="button" onClick={() => void navigator.clipboard?.writeText(created)}>
                Copy
              </button>
            </div>
            <span className="small muted">Copy this token now. Workshop won't show it again.</span>
          </div>
        )}
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Token name, e.g. home automation" aria-label="Token name" maxLength={60} />
          <select value={lifetime} onChange={(e) => setLifetime(e.target.value)} aria-label="Token lifetime" style={{ width: 'auto' }}>
            {TOKEN_LIFETIMES.map((l) => (
              <option key={l.label} value={l.label}>
                {l.label === 'Never' ? 'Never expires' : `Expires in ${l.label}`}
              </option>
            ))}
          </select>
          <label className="row" style={{ gap: 4 }}>
            <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} />
            Read only
          </label>
          <button type="button" onClick={create}>
            Create token
          </button>
        </div>
        <ErrorNote error={problem} />
      </div>
    </Panel>
  );
}

export function SettingsPage() {
  const { data, error } = useApi<Settings>('/settings', ['settings']);
  const usage = useApi<Usage>('/usage', ['allowance', 'connections']);
  const [draft, setDraft] = useState<Settings | null>(null);
  // Limits you've edited, by connection; the rest show what's saved.
  const [limits, setLimits] = useState<Record<number, Limits>>({});
  const [authors, setAuthors] = useState('');
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) return;
    setDraft(data);
    setAuthors(data.authors.join(', '));
  }, [data]);

  if (!draft) return <ErrorNote error={error} />;
  const set = (patch: Partial<Settings>) => {
    setDraft({ ...draft, ...patch });
    setSaved(false);
  };
  const setLimit = (connectionId: number, current: Limits, patch: Partial<Limits>) => {
    setLimits({ ...limits, [connectionId]: { ...current, ...patch } });
    setSaved(false);
  };
  const toggleDay = (d: number) => set({ days: draft.days.includes(d) ? draft.days.filter((x) => x !== d) : [...draft.days, d].sort() });

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setSaveError(null);
    try {
      const { mode: _mode, ...rest } = draft; // the mode switch lives in the top bar
      await api('/settings', { method: 'PUT', body: { ...rest, authors: authors.split(/[\s,]+/).filter(Boolean) } });
      for (const a of usage.data?.allowance ?? []) {
        const edit = limits[a.connectionId];
        if (edit && (edit.fiveHour !== a.limits.fiveHour || edit.weekly !== a.limits.weekly)) {
          await api(`/usage/limits/${a.connectionId}`, { method: 'PUT', body: edit });
        }
      }
      setLimits({});
      setSaved(true);
    } catch (err) {
      setSaveError((err as Error).message);
    }
  };

  return (
    <div className="stack">
    <form className="stack" onSubmit={save}>
      <h1>Settings</h1>
      <Panel title="Operating hours">
        <div className="panel-body stack">
          <p className="small muted">
            When the top bar is set to Scheduled, agents only start inside these hours. Agents already running always finish. Same start and end time means all day.
          </p>
          <div className="row" role="group" aria-label="Days">
            {DAYS.map((name, d) => (
              <label key={name} className="row" style={{ gap: 4 }}>
                <input type="checkbox" checked={draft.days.includes(d)} onChange={() => toggleDay(d)} />
                {name}
              </label>
            ))}
          </div>
          <div className="fields">
            <label className="field">
              <span>Start</span>
              <input type="time" value={draft.start} onChange={(e) => set({ start: e.target.value })} required />
            </label>
            <label className="field">
              <span>End</span>
              <input type="time" value={draft.end} onChange={(e) => set({ end: e.target.value })} required />
              <span className="help">An end before the start runs overnight.</span>
            </label>
            <label className="field">
              <span>Time zone</span>
              <input list="zones" value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })} required />
              <datalist id="zones">
                {ZONES.map((z) => (
                  <option key={z} value={z} />
                ))}
              </datalist>
            </label>
          </div>
        </div>
      </Panel>
      <Panel title="Claude subscription allowance">
        <div className="panel-body stack">
          <ErrorNote error={usage.error} />
          {usage.data && usage.data.allowance.length === 0 && <p className="small muted">No Claude subscription connected yet. Add one on the Connections page.</p>}
          {usage.data && usage.data.allowance.length > 0 && (
            <p className="small muted">Each subscription has its own limits. Subscription agents use the first one in your order (Connections) that's under them.</p>
          )}
          {usage.data?.allowance.map((a) => {
            const current = limits[a.connectionId] ?? a.limits;
            return (
              <div key={a.connectionId} className="stack">
                <strong>{a.connectionName}</strong>
                <div className="fields">
                  <NumberField
                    label="5-hour limit (%)"
                    help="No new agents start on this subscription above this, and its running agents pause after their current step until usage drops back under it. Claude's own warning at 90% also holds them, so higher values have no effect."
                    value={current.fiveHour}
                    min={0}
                    max={100}
                    onChange={(n) => setLimit(a.connectionId, current, { fiveHour: n })}
                  />
                  <NumberField
                    label="Weekly limit (%)"
                    help="No new agents start on this subscription above this, and its running agents pause after their current step until usage drops back under it."
                    value={current.weekly}
                    min={0}
                    max={100}
                    onChange={(n) => setLimit(a.connectionId, current, { weekly: n })}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </Panel>
      <Panel title="API billing">
        <div className="panel-body fields">
          <NumberField label="Limit per run (USD)" value={draft.apiRunCapUsd} min={0} max={1000} step={0.5} onChange={(n) => set({ apiRunCapUsd: n })} />
          <NumberField label="Limit per day (USD)" help="Agents on API billing stop starting once today's runs reach this." value={draft.apiDailyCapUsd} min={0} max={10000} step={1} onChange={(n) => set({ apiDailyCapUsd: n })} />
        </div>
        <p className="panel-body small muted" style={{ paddingTop: 0 }}>
          See usage and projections on the <Link to="/usage">Usage page</Link>.
        </p>
      </Panel>
      <Panel title="Tickets">
        <div className="panel-body fields">
          <label className="field">
            <span>Ticket authors</span>
            <input value={authors} onChange={(e) => {
                setAuthors(e.target.value);
                setSaved(false);
              }} placeholder="your-github-username" />
            <span className="help">Workshop only works on tickets opened by these GitHub users, and leaves other people's comments out of what agents read.</span>
          </label>
          <label className="field">
            <span>Work on tickets in this order</span>
            <select value={draft.ticketOrder} onChange={(e) => set({ ticketOrder: e.target.value as TicketOrder })}>
              {ORDERS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <span className="help">Pushed and prioritised tickets, higher-priority repositories and work already in progress still go first. This decides the order among the rest.</span>
          </label>
          <NumberField label="Check for changes every (minutes)" value={draft.pollMinutes} min={1} max={60} onChange={(n) => set({ pollMinutes: n })} />
          <NumberField label="Keep run history for (days)" value={draft.retentionDays} min={1} max={365} onChange={(n) => set({ retentionDays: n })} />
        </div>
      </Panel>
      <ErrorNote error={saveError} />
      <div className="row">
        <button className="primary">Save settings</button>
        {saved && <span className="small muted">Saved.</span>}
      </div>
    </form>
    <ApiTokens />
    </div>
  );
}
