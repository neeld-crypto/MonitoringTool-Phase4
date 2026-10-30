import { useCallback, useEffect, useState } from 'react';
import { icons } from '../ui/icons';

const KEY = 'sap.theme.v1';
const ORDER = ['system', 'light', 'dark'];
const LABEL = { system: 'System', light: 'Light', dark: 'Dark' };
const ICON = { system: icons.auto, light: icons.sun, dark: icons.moon };

function readMode() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Theme cycling System → Light → Dark. "System" follows the OS (prefers-color-scheme); the choice is
 * remembered. index.html applies the saved value before first paint. `onChange` redraws canvas views.
 */
export function useTheme(onChange) {
  const [mode, setMode] = useState(readMode);
  const next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];

  useEffect(() => {
    if (mode === 'system') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = mode;
    onChange?.();
  }, [mode, onChange]);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-color-scheme: light)');
    const listener = () => mode === 'system' && onChange?.();
    query?.addEventListener('change', listener);
    return () => query?.removeEventListener('change', listener);
  }, [mode, onChange]);

  const cycle = useCallback(() => {
    setMode(next);
    try {
      if (next === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, next);
    } catch {
      /* storage unavailable */
    }
  }, [next]);

  return { icon: ICON[mode], label: LABEL[mode], title: `Theme: ${LABEL[mode]} (click for ${LABEL[next]})`, cycle };
}
