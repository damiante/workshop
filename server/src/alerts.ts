import { one, run } from './db.ts';
import { publish } from './events.ts';

/** Records an alert unless an identical one (same kind and ref) is still unacknowledged. */
export function raiseAlert(level: 'error' | 'warning' | 'info', kind: string, message: string, ref?: string) {
  const open = one('SELECT id FROM alerts WHERE kind = ? AND ref IS ? AND ack_at IS NULL', kind, ref ?? null);
  if (open) return;
  run('INSERT INTO alerts (level, kind, message, ref, created_at) VALUES (?, ?, ?, ?, ?)', level, kind, message, ref ?? null, Date.now());
  console.log(`[alert] ${level} ${kind}: ${message}`);
  publish('alerts');
}

/** Acknowledges open alerts of a kind/ref once the condition has cleared (e.g. a host came back). */
export function clearAlert(kind: string, ref?: string) {
  const result = run('UPDATE alerts SET ack_at = ? WHERE kind = ? AND ref IS ? AND ack_at IS NULL', Date.now(), kind, ref ?? null);
  if (result.changes) publish('alerts');
}
