import { useEffect, type ReactNode } from 'react';
import type { UsageWindow } from '../../../server/src/api-types.ts';
import { clock, type Tone } from '../format.ts';

export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`status ${tone}`}>{children}</span>;
}

export function Meter({ label, window, threshold }: { label: string; window: UsageWindow | null; threshold: number }) {
  const pct = window && (!window.resetsAt || window.resetsAt > Date.now()) ? window.pct : 0;
  return (
    <div className="meter" title={`Workshop starts no new agents above ${threshold}%`}>
      <span>{label}</span>
      <div className="meter-track" role="meter" aria-label={`${label} allowance used`} aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
        <div className={`meter-fill${pct > threshold ? ' over' : ''}`} style={{ width: `${Math.min(100, pct)}%` }} />
        <div className="meter-mark" style={{ left: `${threshold}%` }} />
      </div>
      <span className="muted">
        {Math.round(pct)}%{window?.resetsAt ? `, resets ${clock(window.resetsAt)}` : ''}
      </span>
    </div>
  );
}

export function Modal({ title, onClose, className, children }: { title: string; onClose: () => void; className?: string; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={className ? `modal ${className}` : 'modal'} role="dialog" aria-modal="true" aria-label={title}>
        <div className="spread">
          <h2>{title}</h2>
          <button className="link" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Panel({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="panel">
      <div className="panel-head spread">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

export function ErrorNote({ error }: { error: string | null | undefined }) {
  return error ? (
    <p className="notice error" role="alert">
      {error}
    </p>
  ) : null;
}
