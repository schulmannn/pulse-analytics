import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { Card } from '@/components/ui/card';
import { useFocusTrap } from '@/lib/useFocusTrap';

interface DetailShellProps {
  /** Accessible dialog name (e.g. «График: Просмотры»). */
  ariaLabel: string;
  onClose: () => void;
  /** 'panel' — a centered Card over a dimmed backdrop (the read explorer). 'fullscreen' — an opaque
   *  edge-to-edge surface (the config sandbox). */
  variant: 'panel' | 'fullscreen';
  /** The detail body — header, controls, chart, rail, stats. Rendered inside the shared chrome. */
  children: ReactNode;
}

/**
 * The ONE dialog CHROME behind every widget detail surface — the read explorer (ChartExpandOverlay)
 * and the config sandbox (WidgetExplorer) plug their own body into it, so there is no per-widget
 * bespoke modal. It owns everything those two duplicated: the portal, role="dialog" + aria-modal, a
 * focus trap (restores opener focus on close), body-scroll lock, capture-phase Escape (so a nested
 * control / card menu can't double-handle it), and the × close. Everything visual — header, controls,
 * body, rail — is the caller's `children`, so each surface renders exactly as before.
 */
export function DetailShell({ ariaLabel, onClose, variant, children }: DetailShellProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);

  useEffect(() => {
    // Capture phase + stopPropagation: pre-empt any nested handler (a card menu, an inner dialog) so
    // Escape closes THIS shell exactly once.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const closeButton = (
    <button
      type="button"
      onClick={onClose}
      aria-label="Закрыть"
      className="absolute right-4 top-4 z-10 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
      </svg>
    </button>
  );

  if (variant === 'fullscreen') {
    return createPortal(
      <div
        ref={panelRef}
        tabIndex={-1}
        className="fixed inset-0 z-50 flex flex-col bg-background focus:outline-none"
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
      >
        {closeButton}
        {children}
      </div>,
      document.body,
    );
  }

  // 'panel' — centered Card over a dimmed, click-to-close backdrop.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={ariaLabel}>
      <div className="absolute inset-0 bg-background/70 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <Card ref={panelRef} tabIndex={-1} className="relative z-10 flex h-full w-full flex-col overflow-hidden focus:outline-none">
        {closeButton}
        {children}
      </Card>
    </div>,
    document.body,
  );
}
