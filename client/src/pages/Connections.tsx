import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import type { ConnectionKind, ConnectionView, FieldDef, Installation, ProviderInfo, RepoView, TestResult } from '../../../server/src/api-types.ts';
import { api, useApi } from '../api.ts';
import { ErrorNote, Modal, Panel, Status } from '../components/ui.tsx';

const SECTIONS: { kind: ConnectionKind; title: string; blurb: string }[] = [
  { kind: 'vcs', title: 'Code host', blurb: 'Where your code lives. Workshop acts through its own GitHub App.' },
  { kind: 'tickets', title: 'Tickets', blurb: 'Where Workshop finds work to do.' },
  { kind: 'environment', title: 'Agent hosts', blurb: 'Machines with Docker where agent containers run.' },
  { kind: 'model', title: 'AI models', blurb: 'Claude, through your subscription, an API key, or both.' },
];

const BANNERS: Record<string, { tone: string; text: string }> = {
  created: { tone: 'ok', text: 'GitHub App created. Next, install it on your account or organisations.' },
  installed: { tone: 'ok', text: 'Installation approved. Refresh the repository list to see its repositories.' },
  'review-installations': { tone: '', text: "GitHub reported an installation Workshop didn't start. Approve it below if it was you." },
};

const visible = (f: FieldDef, values: Record<string, unknown>) => !f.showIf || f.showIf.equals.includes(String(values[f.showIf.key] ?? ''));

function FieldInput(props: { field: FieldDef; value: unknown; saved?: string; connections: ConnectionView[]; onChange: (v: unknown) => void }) {
  const { field, value, saved, connections, onChange } = props;
  const common = {
    required: field.required && !saved,
    placeholder: saved ? `Saved (${saved}). Leave blank to keep it.` : field.placeholder,
    value: value === undefined || value === null ? '' : String(value),
  };
  let input: ReactNode;
  switch (field.type) {
    case 'select':
      input = (
        <select {...common} onChange={(e) => onChange(e.target.value)}>
          {field.options!.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      );
      break;
    case 'connection':
      input = (
        <select {...common} onChange={(e) => onChange(Number(e.target.value))}>
          <option value="">Choose…</option>
          {connections
            .filter((c) => c.provider === field.connectionProvider)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
        </select>
      );
      break;
    case 'textarea':
      input = <textarea {...common} className="mono" rows={5} onChange={(e) => onChange(e.target.value)} />;
      break;
    case 'number':
      input = <input {...common} type="number" min={0} step="any" onChange={(e) => onChange(e.target.value)} />;
      break;
    default:
      input = <input {...common} type={field.type === 'password' ? 'password' : 'text'} autoComplete="off" onChange={(e) => onChange(e.target.value)} />;
  }
  return (
    <label className="field">
      <span>{field.label}</span>
      {input}
      {field.help && <span className="help">{field.help}</span>}
    </label>
  );
}

function ConnectionModal(props: { provider: ProviderInfo; connection?: ConnectionView; connections: ConnectionView[]; onClose: () => void }) {
  const { provider, connections, onClose } = props;
  const [connection, setConnection] = useState(props.connection);
  const [name, setName] = useState(connection?.name ?? provider.name);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const initial: Record<string, unknown> = {};
    for (const f of provider.fields) initial[f.key] = connection ? connection.config[f.key] : f.defaultValue;
    if (!connection && provider.fields.some((f) => f.type === 'connection')) {
      const f = provider.fields.find((x) => x.type === 'connection')!;
      initial[f.key] = connections.find((c) => c.provider === f.connectionProvider)?.id;
    }
    return initial;
  });
  const [result, setResult] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ connection: ConnectionView; test: TestResult }>(connection ? `/connections/${connection.id}` : '/connections', {
        method: connection ? 'PUT' : 'POST',
        body: { provider: provider.id, name, values },
      });
      setConnection(res.connection); // a second save edits what the first created
      setResult(res.test);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={connection ? `Edit ${connection.name}` : `Add ${provider.name}`} onClose={onClose}>
      <p className="muted">{provider.description}</p>
      <form className="stack" onSubmit={save}>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required autoFocus />
        </label>
        {provider.fields
          .filter((f) => visible(f, values))
          .map((f) => (
            <FieldInput
              key={f.key}
              field={f}
              value={f.secret ? values[f.key] ?? '' : values[f.key]}
              saved={connection?.secrets[f.key]}
              connections={connections}
              onChange={(v) => setValues({ ...values, [f.key]: v })}
            />
          ))}
        <ErrorNote error={error} />
        {result && <p className={`notice ${result.ok ? 'ok' : 'error'}`}>{result.ok ? result.message : `Saved, but the check failed: ${result.message}`}</p>}
        <div className="row">
          <button className="primary" disabled={busy}>
            {busy ? 'Checking…' : result ? 'Save and check again' : 'Save and check'}
          </button>
          {result?.ok && (
            <button type="button" onClick={onClose}>
              Done
            </button>
          )}
        </div>
      </form>
    </Modal>
  );
}

function Installations({ connection }: { connection: ConnectionView }) {
  const { data, error, reload } = useApi<Installation[]>(`/github/${connection.id}/installations`, ['connections']);
  const [actionError, setActionError] = useState<string | null>(null);
  const toggle = (id: number, on: boolean) => {
    const approved = (data ?? []).filter((i) => (i.id === id ? on : i.approved)).map((i) => i.id);
    api(`/github/${connection.id}/installations`, { method: 'PUT', body: { approved } }).then(reload, (e: Error) => setActionError(e.message));
  };
  const install = () => api<{ url: string }>(`/github/${connection.id}/install`).then(({ url }) => window.location.assign(url), (e: Error) => setActionError(e.message));
  return (
    <div className="stack small" style={{ gap: 8 }}>
      <strong>Installations</strong>
      {data && !data.length && <span className="muted">Not installed anywhere yet.</span>}
      {data?.map((i) => (
        <label key={i.id} className="row">
          <input type="checkbox" checked={i.approved} onChange={(e) => toggle(i.id, e.target.checked)} />
          <span>
            {i.account} <span className="muted">({i.repositorySelection === 'all' ? 'all repositories' : 'selected repositories'})</span>
          </span>
        </label>
      ))}
      <ErrorNote error={error ?? actionError} />
      <div>
        <button onClick={install}>Install on an account or organisation</button>
      </div>
    </div>
  );
}

function ConnectionItem({ c, provider, onEdit, extra }: { c: ConnectionView; provider: ProviderInfo; onEdit: () => void; extra?: ReactNode }) {
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);
  const check = () => {
    setBusy(true);
    api<TestResult>(`/connections/${c.id}/test`, { body: {} })
      .then(setTest, (e: Error) => setTest({ ok: false, message: e.message }))
      .finally(() => setBusy(false));
  };
  const remove = () => {
    if (confirm(`Remove ${c.name}? Workshop forgets its settings and credentials.`)) {
      api(`/connections/${c.id}`, { method: 'DELETE' }).catch((e: Error) => setTest({ ok: false, message: e.message }));
    }
  };
  const specs = typeof c.config.specs === 'string' ? c.config.specs : null;
  const labelOf = (key: string) => provider.fields.find((f) => f.key === key)?.label ?? key;
  const saved = Object.entries(c.secrets).map(([key, hint]) => `${labelOf(key)} ${hint}`);
  const credentials = saved.length ? `Saved: ${saved.join(', ')}` : null;
  return (
    <li className="stack" style={{ gap: 8 }}>
      <div className="spread">
        <strong>{c.name}</strong>
        <Status tone={c.status === 'ok' ? 'ok' : c.status === 'error' ? 'error' : 'idle'}>{c.status === 'ok' ? 'Working' : c.status === 'error' ? 'Not working' : 'Not checked yet'}</Status>
      </div>
      {specs && <span className="small muted">{specs}</span>}
      {credentials && <span className="small muted">{credentials}</span>}
      {c.status === 'error' && c.error && <span className="small error-text">{c.error}</span>}
      {test && <span className={`small ${test.ok ? '' : 'error-text'}`}>{test.message}</span>}
      {extra}
      <div className="row">
        <button onClick={check} disabled={busy}>
          {busy ? 'Checking…' : 'Check connection'}
        </button>
        <button onClick={onEdit}>Edit</button>
        <button className="danger" onClick={remove}>
          Remove
        </button>
      </div>
    </li>
  );
}

function GitHubSetup({ onExisting }: { onExisting: () => void }) {
  const [error, setError] = useState<string | null>(null);
  // GitHub's App-manifest flow needs a form POST from the browser.
  const start = async () => {
    try {
      const { action, manifest } = await api<{ action: string; manifest: string }>('/github/manifest');
      const form = document.createElement('form');
      form.method = 'post';
      form.action = action;
      const input = Object.assign(document.createElement('input'), { type: 'hidden', name: 'manifest', value: manifest });
      form.append(input);
      document.body.append(form);
      form.submit();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <div className="panel-body stack">
      <p>Pull requests and comments come from Workshop's own bot, so you can review its work on GitHub and get notified when it asks a question.</p>
      <ol className="small" style={{ margin: 0, paddingLeft: 20 }}>
        <li>Create the App: GitHub shows a pre-filled page. Click Create GitHub App.</li>
        <li>Install it on your account and any organisations, choosing which repositories it can see.</li>
        <li>Turn on the repositories Workshop should work on, below.</li>
      </ol>
      <ErrorNote error={error} />
      <div className="row">
        <button className="primary" onClick={start}>
          Create the GitHub App
        </button>
        <button className="link" onClick={onExisting}>
          Use an existing App instead
        </button>
      </div>
    </div>
  );
}

function RepoRow({ repo, onChange }: { repo: RepoView; onChange: (id: number, body: object) => void }) {
  const [image, setImage] = useState(repo.image ?? '');
  return (
    <li className="spread">
      <label className="row">
        <input type="checkbox" checked={repo.enabled} onChange={(e) => onChange(repo.id, { enabled: e.target.checked })} />
        <span>{repo.fullName}</span>
        {repo.private && <span className="tag">Private</span>}
      </label>
      {repo.enabled && (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            onChange(repo.id, { image });
          }}
        >
          <input className="mono small" style={{ width: 300 }} aria-label={`Agent image for ${repo.fullName}`} placeholder="Agent image (default)" value={image} onChange={(e) => setImage(e.target.value)} />
          <button>Save image</button>
        </form>
      )}
    </li>
  );
}

function Repos() {
  const { data, error, reload } = useApi<RepoView[]>('/repos', ['repos']);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const fetchedOnce = useRef(false);

  const refresh = () => {
    setBusy(true);
    setActionError(null);
    api('/repos/refresh', { body: {} })
      .then(reload, (e: Error) => setActionError(e.message))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    if (data && !data.length && !fetchedOnce.current) {
      fetchedOnce.current = true;
      refresh();
    }
  });
  const update = (id: number, body: object) => api(`/repos/${id}`, { method: 'PUT', body }).then(reload, (e: Error) => setActionError(e.message));
  const shown = (data ?? []).filter((r) => r.fullName.toLowerCase().includes(query.toLowerCase()));

  return (
    <Panel
      title="Repositories"
      action={
        <button onClick={refresh} disabled={busy}>
          {busy ? 'Refreshing…' : 'Refresh list'}
        </button>
      }
    >
      <div className="panel-body stack">
        <p className="small muted">Workshop only works on repositories you turn on. Turning one on creates its workshop/ labels on GitHub.</p>
        <input type="search" placeholder="Search repositories" aria-label="Search repositories" value={query} onChange={(e) => setQuery(e.target.value)} />
        <ErrorNote error={actionError ?? error} />
      </div>
      {shown.length ? (
        <ul className="list">
          {shown.map((r) => (
            <RepoRow key={r.id} repo={r} onChange={update} />
          ))}
        </ul>
      ) : (
        <p className="empty">{data?.length ? 'No repositories match.' : 'No repositories yet. Install the GitHub App, then refresh the list.'}</p>
      )}
    </Panel>
  );
}

export function Connections() {
  const { data: providers } = useApi<ProviderInfo[]>('/providers');
  const { data: connections, error } = useApi<ConnectionView[]>('/connections', ['connections']);
  const [params, setParams] = useSearchParams();
  const [editing, setEditing] = useState<{ provider: ProviderInfo; connection?: ConnectionView } | null>(null);
  if (!providers || !connections) return <ErrorNote error={error} />;

  const banner = params.get('error') ? { tone: 'error', text: params.get('error')! } : BANNERS[params.get('github') ?? ''];
  const providerFor = (id: string) => providers.find((p) => p.id === id)!;

  return (
    <div className="stack">
      <h1>Connections</h1>
      {banner && (
        <p className={`notice ${banner.tone}`}>
          {banner.text}{' '}
          <button className="link" onClick={() => setParams({})}>
            Dismiss
          </button>
        </p>
      )}
      {SECTIONS.map((section) => {
        const items = connections.filter((c) => c.kind === section.kind);
        const addable = providers.filter((p) => p.kind === section.kind && !p.setup);
        return (
          <Panel
            key={section.kind}
            title={section.title}
            action={
              addable.length > 0 && (section.kind !== 'vcs' || items.length > 0) ? (
                <button onClick={() => setEditing({ provider: addable[0] })}>Add</button>
              ) : undefined
            }
          >
            <p className="panel-body small muted" style={{ paddingBottom: 0 }}>
              {section.blurb}
            </p>
            {section.kind === 'vcs' && !items.length ? (
              <GitHubSetup onExisting={() => setEditing({ provider: providerFor('github') })} />
            ) : items.length ? (
              <ul className="list">
                {items.map((c) => (
                  <ConnectionItem
                    key={c.id}
                    c={c}
                    provider={providerFor(c.provider)}
                    onEdit={() => setEditing({ provider: providerFor(c.provider), connection: c })}
                    extra={c.provider === 'github' ? <Installations connection={c} /> : undefined}
                  />
                ))}
              </ul>
            ) : (
              <p className="empty">None yet.</p>
            )}
          </Panel>
        );
      })}
      {connections.some((c) => c.kind === 'vcs') && <Repos />}
      {editing && <ConnectionModal provider={editing.provider} connection={editing.connection} connections={connections} onClose={() => setEditing(null)} />}
    </div>
  );
}
