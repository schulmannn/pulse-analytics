import { useSyncExternalStore } from 'react';

/**
 * Tiny external store for the global ⌘K command palette. Any control (sidebar SearchBox,
 * future topbar triggers) opens it through openCommandPalette() — no synthetic KeyboardEvent
 * replay, no coupling to the palette's internal shortcut handler.
 */

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

export function setCommandPaletteOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  emit();
}

export function openCommandPalette(): void {
  setCommandPaletteOpen(true);
}

export function toggleCommandPalette(): void {
  setCommandPaletteOpen(!open);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getSnapshot = () => open;

/** Reactive palette open-state (shared store) + setter, for the palette component itself. */
export function useCommandPaletteOpen(): { open: boolean; setOpen: (next: boolean) => void } {
  const isOpen = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { open: isOpen, setOpen: setCommandPaletteOpen };
}
