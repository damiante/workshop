import { useEffect, type ReactNode } from 'react';
import type { UsageWindow } from '../../../server/src/api-types.ts';
import { clock, type Tone } from '../format.ts';

export function Status({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`status ${tone}`}>{children}</span>;
}

/** A usage bar with your limit as a solid line and, when the weekly burndown is on, its line dotted. */
export function Meter({ label, window, threshold, burndown = null, target }: { label: string; window: UsageWindow | null; threshold: number; burndown?: number | null; target?: number }) {
  const pct = window && (!window.resetsAt || window.resetsAt > Date.now()) ? window.pct : 0;
  const line = burndown === null ? threshold : Math.min(threshold, burndown);
  const title =
    burndown === null
      ? `Workshop starts no new agents above ${threshold}%`
      : `Solid line: your limit, ${threshold}%. Dotted line: the burndown, ${Math.round(burndown)}% now${target === undefined ? '' : `, rising to ${target}% by the reset`}. No new agents start above the lower one.`;
  return (
    <div className="meter" title={title}>
      <span>{label}</span>
      <div
        className="meter-track"
        role="meter"
        aria-label={burndown === null ? `${label} allowance used, limit ${threshold}%` : `${label} allowance used, limit ${threshold}%, burndown ${Math.round(burndown)}%`}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div className={`meter-fill${pct > line ? ' over' : ''}`} style={{ width: `${Math.min(100, pct)}%` }} />
        <div className="meter-mark" style={{ left: `${threshold}%` }} />
        {burndown !== null && <div className="meter-mark burndown" style={{ left: `${Math.min(100, burndown)}%` }} />}
      </div>
      <span className="muted">
        {Math.round(pct)}%{window?.resetsAt ? `, resets ${clock(window.resetsAt)}` : ''}
      </span>
    </div>
  );
}

/** A bar for how much of a run's limit is used, e.g. turns of max turns. */
/** `over` (a full bar turns the error colour) defaults to the bar being full; pass false for a progress count. */
export function Progress({ label, value, max, text, over = value >= max }: { label: string; value: number; max: number; text: string; over?: boolean }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 100;
  return (
    <div className="meter">
      <span>{label}</span>
      <div className="meter-track" role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
        <div className={`meter-fill${over ? ' over' : ''}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="muted">{text}</span>
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
