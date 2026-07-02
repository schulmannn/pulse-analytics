import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

export type Theme = 'light' | 'dark';
/** Stored preference: an explicit theme, or 'system' — follow the OS scheme live. */
export type ThemeMode = Theme | 'system';

interface ThemeContextValue {
  /** The RESOLVED theme actually applied to <html> — what consumers render against. */
  theme: Theme;
  /** The preference behind it. 'system' resolves through prefers-color-scheme. */
  mode: ThemeMode;
  setTheme: (theme: Theme) => void;
  setMode: (mode: ThemeMode) => void;
  /** Flip the resolved theme and persist it as an explicit choice (account-menu behaviour). */
  toggle: () => void;
}

const STORAGE_KEY = 'pulse_theme';
const ThemeContext = createContext<ThemeContextValue | null>(null);

const prefersDark = () => window.matchMedia('(prefers-color-scheme: dark)');

function initialMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    /* localStorage may be unavailable */
  }
  // Nothing stored = the historical default: follow the OS scheme. (It now also live-updates.)
  return 'system';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(initialMode);
  const [osTheme, setOsTheme] = useState<Theme>(() => (prefersDark().matches ? 'dark' : 'light'));

  // Track the OS scheme so 'system' mode follows it without a reload.
  useEffect(() => {
    const mq = prefersDark();
    const onChange = () => setOsTheme(mq.matches ? 'dark' : 'light');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const theme: Theme = mode === 'system' ? osTheme : mode;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
  }, [theme]);

  const setMode = useCallback((nextMode: ThemeMode) => {
    try {
      localStorage.setItem(STORAGE_KEY, nextMode);
    } catch {
      /* localStorage may be unavailable */
    }
    setModeState(nextMode);
  }, []);

  // Back-compat alias: an explicit theme is just an explicit mode.
  const setTheme = useCallback((nextTheme: Theme) => setMode(nextTheme), [setMode]);

  // The account-menu toggle flips whatever is currently RESOLVED (incl. under 'system')
  // into the opposite explicit theme — same observable behaviour as before 'system' existed.
  const toggle = useCallback(() => setMode(theme === 'dark' ? 'light' : 'dark'), [setMode, theme]);

  const value = useMemo(
    () => ({ theme, mode, setTheme, setMode, toggle }),
    [theme, mode, setTheme, setMode, toggle],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used within ThemeProvider');
  return value;
}
