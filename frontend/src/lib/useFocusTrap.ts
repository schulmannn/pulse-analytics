import { useEffect } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * Modal focus management (WCAG 2.4.3 + APG dialog): on open, move focus into the dialog panel;
 * trap Tab/Shift+Tab within it; on close, restore focus to the element that opened it. The
 * panel must have tabIndex={-1} so it can receive focus. Safe to nest — an inner dialog's
 * panel lives outside the outer panel (portaled), so the outer trap ignores Tabs while the
 * inner is focused, and each restores its own opener on unmount.
 */
export function useFocusTrap(panelRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      const active = document.activeElement;
      // Only act when focus is inside this panel (lets a nested dialog own its own Tab).
      if (active !== panel && !panel.contains(active)) return;
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [panelRef]);
}
