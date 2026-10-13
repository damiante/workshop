import { one, run } from './db.ts';
import type { Settings } from './api-types.ts';

export const DEFAULT_SETTINGS: Settings = {
  // Nothing launches until you've configured Workshop and switched it on.
  mode: 'paused',
  timezone: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
  days: [0, 1, 2, 3, 4, 5, 6],
  start: '00:00',
  end: '00:00',
  fiveHourMax: 70,
  weeklyMax: 80,
  apiRunCapUsd: 5,
  apiDailyCapUsd: 20,
  pollMinutes: 3,
  authors: [],
  retentionDays: 30,
};

export function getSettings(): Settings {
  const row = one<{ value: string }>("SELECT value FROM settings WHERE key = 'settings'");
  return { ...DEFAULT_SETTINGS, ...(row ? JSON.parse(row.value) : {}) };
}

export function saveSettings(patch: Partial<Settings>): Settings {
  const next = { ...getSettings(), ...patch };
  setValue('settings', JSON.stringify(next));
  return next;
}

export function getValue(key: string): string | undefined {
  return one<{ value: string }>('SELECT value FROM settings WHERE key = ?', key)?.value;
}

export function setValue(key: string, value: string | null) {
  if (value === null) run('DELETE FROM settings WHERE key = ?', key);
  else run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
}
