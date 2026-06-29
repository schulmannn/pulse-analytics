import { useCallback, useState } from 'react';

const STORAGE_KEY = 'pulse_sidebar_collapsed';

/**
 * Effective icon-rail mode: forced below the `lg` breakpoint (auto-rail), and driven by
 * the manual collapse flag at `lg` and above (where a full sidebar fits).
 */
export function railMode(isLg: boolean, collapsed: boolean): boolean {
  return !isLg || collapsed;
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
  } catch {
    /* localStorage may be unavailable */
  }
}

/** Manual sidebar collapse (full ↔ icon-rail), persisted across reloads. */
export function useSidebarCollapsed(): { collapsed: boolean; toggle: () => void } {
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsed(next);
      return next;
    });
  }, []);
  return { collapsed, toggle };
}
