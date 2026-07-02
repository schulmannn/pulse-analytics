import { useCallback, useState } from 'react';

export type SidebarMode = 'open' | 'rail';

const STORAGE_KEY = 'pulse_sidebar';
/** Pre-redesign boolean key ('1' = collapsed) — read once for migration, then removed. */
const LEGACY_KEY = 'pulse_sidebar_collapsed';

/**
 * Effective sidebar mode: an explicit persisted user choice wins at every breakpoint;
 * until the user chooses, the default is responsive — expanded at ≥lg, icon-rail on md–lg.
 */
export function effectiveSidebarMode(stored: SidebarMode | null, isLg: boolean): SidebarMode {
  return stored ?? (isLg ? 'open' : 'rail');
}

export function toggledSidebarMode(mode: SidebarMode): SidebarMode {
  return mode === 'open' ? 'rail' : 'open';
}

/** Narrow a raw persisted string to a valid mode (anything else → no explicit choice). */
export function parseSidebarMode(raw: string | null | undefined): SidebarMode | null {
  return raw === 'open' || raw === 'rail' ? raw : null;
}

function readStoredMode(): SidebarMode | null {
  try {
    const stored = parseSidebarMode(localStorage.getItem(STORAGE_KEY));
    if (stored) return stored;
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy === '1') return 'rail';
    if (legacy === '0') return 'open';
    return null;
  } catch {
    return null;
  }
}

function writeStoredMode(mode: SidebarMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
    localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* localStorage may be unavailable */
  }
}

/**
 * Sidebar mode (expanded column ↔ icon-rail), persisted under `pulse_sidebar` once the user
 * toggles explicitly (header button or Ctrl+B). Both modes push content — there is no overlay.
 */
export function useSidebarMode(isLg: boolean): { rail: boolean; toggle: () => void } {
  const [stored, setStored] = useState<SidebarMode | null>(readStoredMode);
  const rail = effectiveSidebarMode(stored, isLg) === 'rail';
  const toggle = useCallback(() => {
    setStored((prev) => {
      const next = toggledSidebarMode(effectiveSidebarMode(prev, isLg));
      writeStoredMode(next);
      return next;
    });
  }, [isLg]);
  return { rail, toggle };
}
