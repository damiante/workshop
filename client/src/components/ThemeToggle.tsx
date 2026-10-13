import { useState } from 'react';

type Theme = 'system' | 'light' | 'dark';
const NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const LABEL: Record<Theme, string> = { system: 'Theme: system', light: 'Theme: light', dark: 'Theme: dark' };

function stored(): Theme {
  try {
    return (localStorage.getItem('workshop-theme') as Theme | null) ?? 'system';
  } catch {
    return 'system';
  }
}

function apply(theme: Theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

export const applyStoredTheme = () => apply(stored());

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(stored);
  const toggle = () => {
    const next = NEXT[theme];
    setTheme(next);
    apply(next);
    try {
      localStorage.setItem('workshop-theme', next);
    } catch {
      // Private mode: the choice lasts for this page only.
    }
  };
  return (
    <button className="link small" onClick={toggle}>
      {LABEL[theme]}
    </button>
  );
}
