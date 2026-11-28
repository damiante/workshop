import type { SyncStatus } from '../sync.ts';
import { ErrorNote, Progress } from './ui.tsx';

/** The button and a line saying what the sync is doing. */
export function SyncControl({ status, lastError, sending, error, label, title, onClick }: { status: SyncStatus; lastError: string | null; sending: boolean; error: string | null; label: string; title?: string; onClick: () => void }) {
  return (
    <div className="sync-control">
      <div className="sync-row">
        {status.bar ? (
          <Progress label={status.text} value={status.bar.value} max={status.bar.max} text="" over={false} />
        ) : (
          status.text && <span className="muted small">{status.text}</span>
        )}
        <button onClick={onClick} disabled={sending || status.busy} title={title}>
          {sending ? 'Sending…' : label}
        </button>
      </div>
      <ErrorNote error={error} />
      {!status.busy && <ErrorNote error={lastError} />}
    </div>
  );
}
