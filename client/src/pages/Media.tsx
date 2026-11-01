import { useCallback, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type { TicketMedia } from '../../../server/src/api-types.ts';
import { useApi } from '../api.ts';
import { Gallery, plainClick, sourceText } from '../components/Gallery.tsx';
import { ErrorNote, Panel } from '../components/ui.tsx';

export function Media() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const runId = params.get('run');
  const [open, setOpen] = useState<string | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const { data, error } = useApi<TicketMedia>(`/tickets/${id}/media`, ['media']);
  if (error) return <ErrorNote error={error} />;
  if (!data) return null;
  const items = runId ? data.items.filter((m) => m.runId === runId) : data.items;
  return (
    <div className="stack">
      <div className="stack" style={{ gap: 4 }}>
        <h1>
          Screenshots for <Link to={`/tickets/${data.ticketId}`}>{data.ticket}</Link>
        </h1>
        <span className="muted">{data.title}</span>
      </div>
      <Panel
        title={runId ? 'Images from this run' : 'Images'}
        action={
          runId && (
            <Link className="small" to={`/tickets/${data.ticketId}/media`}>
              Show all
            </Link>
          )
        }
      >
        {items.length ? (
          <div className="media-grid">
            {items.map((m) => (
              <figure key={m.name}>
                <a
                  href={m.url}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(e) => {
                    if (plainClick(e)) {
                      e.preventDefault();
                      setOpen(m.name);
                    }
                  }}
                >
                  <img src={m.url} alt={m.caption ?? m.name} loading="lazy" />
                </a>
                <figcaption>
                  <span className="clamp">{m.caption ?? m.name}</span>
                  <span className="small muted">
                    {sourceText(m)}
                    {m.runId && (
                      <>
                        {' · '}
                        <Link to={`/runs/${m.runId}`}>View run</Link>
                      </>
                    )}
                  </span>
                </figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <p className="muted">No images yet. Agents add screenshots here, and images in the issue are copied in when an agent next runs.</p>
        )}
      </Panel>
      {open && <Gallery items={items} name={open} onSelect={setOpen} onClose={close} />}
    </div>
  );
}
