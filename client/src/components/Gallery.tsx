import { useEffect, useRef } from 'react';
import type { MouseEvent } from 'react';
import { Link } from 'react-router';
import type { MediaItem } from '../../../server/src/api-types.ts';
import { Modal } from './ui.tsx';

export const sourceText = (m: MediaItem) => (m.source === 'issue' ? 'From the issue' : m.source === 'comment' ? 'From a comment' : `Added by ${m.source}`);

/** True for a plain left click; Ctrl/Cmd-click and middle-click keep opening a new tab. */
export const plainClick = (e: MouseEvent) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;

export function Gallery({ items, name, onSelect, onClose }: { items: MediaItem[]; name: string; onSelect: (name: string) => void; onClose: () => void }) {
  const i = items.findIndex((m) => m.name === name);
  const stripRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (i < 0) onClose();
  }, [i, onClose]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const next = e.key === 'ArrowLeft' ? items[i - 1] : e.key === 'ArrowRight' ? items[i + 1] : undefined;
      if (next) onSelect(next.name);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [items, i, onSelect]);

  useEffect(() => {
    stripRef.current?.querySelector('[aria-current]')?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [i]);

  if (i < 0) return null;
  const m = items[i];
  return (
    <Modal title={`Image ${i + 1} of ${items.length}`} className="gallery" onClose={onClose}>
      <div className="gallery-stage">
        <button className="gallery-nav" aria-label="Previous image" disabled={i === 0} onClick={() => onSelect(items[i - 1].name)}>
          ‹
        </button>
        <img src={m.url} alt={m.caption ?? m.name} />
        <button className="gallery-nav" aria-label="Next image" disabled={i === items.length - 1} onClick={() => onSelect(items[i + 1].name)}>
          ›
        </button>
      </div>
      <p className="gallery-caption">{m.caption ?? m.name}</p>
      <span className="small muted">
        {sourceText(m)}
        {m.runId && (
          <>
            {' · '}
            <Link to={`/runs/${m.runId}`}>View run</Link>
          </>
        )}
        {' · '}
        <a href={m.url} target="_blank" rel="noreferrer">
          Open full size
        </a>
      </span>
      {items.length > 1 && (
        <div className="gallery-strip" ref={stripRef}>
          {items.map((t, j) => (
            <button key={t.name} aria-label={t.caption ?? t.name} aria-current={j === i || undefined} onClick={() => onSelect(t.name)}>
              <img src={t.url} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
