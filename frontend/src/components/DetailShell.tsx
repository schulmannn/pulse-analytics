import { useEffect, useLayoutEffect, useRef } from 'react';
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
  /** The clicked card's viewport rect at open time (captured by ChartWidget before the URL changes).
   *  When present (and motion is allowed) the panel grows out of that footprint — a shared-element
   *  "card-to-detail" transition. Absent for URL / back-forward / shared-link opens → plain appear. */
  originRect?: DOMRect | null;
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
export function DetailShell({ ariaLabel, onClose, variant, originRect, children }: DetailShellProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef);

  // Shared-element grow: FLIP the panel from the clicked card's footprint to its natural position.
  // The panel is laid out at its FINAL size (so charts/text measure correctly from frame one — no
  // redraw), then transform-inverted to the card rect and played to identity, so the whole box scales
  // up out of the card. Transform-only (no opacity fade) keeps content contrast intact for any AT /
  // axe sampling mid-flight; the corner radius scales with the box, so it also reads as a radius morph.
  // useLayoutEffect (not useEffect): the invert MUST land before the browser paints, else the panel
  // flashes at full size for one frame before snapping down to the card.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel || !originRect) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
    const final = panel.getBoundingClientRect();
    if (!final.width || !final.height || !originRect.width || !originRect.height) return;
    const sx = originRect.width / final.width;
    const sy = originRect.height / final.height;
    const dx = originRect.left - final.left;
    const dy = originRect.top - final.top;
    panel.style.transformOrigin = 'top left';
    panel.style.willChange = 'transform';
    panel.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
    void panel.offsetHeight; // commit the inverted (card-sized) state before playing to identity
    const clear = () => {
      panel.style.transition = '';
      panel.style.transform = '';
      panel.style.transformOrigin = '';
      panel.style.willChange = '';
    };
    panel.style.transition = 'transform var(--motion-glide) var(--ease-standard)';
    panel.style.transform = 'none';
    panel.addEventListener('transitionend', clear, { once: true });
    const timer = window.setTimeout(clear, 500); // transitionend can be swallowed (tab switch) — belt & braces
    return () => {
      window.clearTimeout(timer);
      panel.removeEventListener('transitionend', clear);
    };
  }, [originRect]);

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
      // top uses max(1rem, safe-area) so the × clears a notch on the mobile edge-to-edge sheet
      // (env resolves to 0 on desktop / non-notched viewports → the original 1rem inset).
      className="absolute right-4 top-[max(1rem,env(safe-area-inset-top))] z-10 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
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
        className="fixed inset-0 z-modal flex flex-col bg-background focus:outline-none"
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

  // 'panel' — centered Card over a dimmed, click-to-close backdrop. On mobile (<sm) it drops the
  // outer inset so the Card is a full-height, edge-to-edge sheet (Mobile-nav card): no 16px paper
  // gutter to waste on a phone, square top/bottom corners, and a bottom safe-area pad so the stats
  // strip clears the home indicator. ≥sm restores the floating inset + panel radius.
  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true" aria-label={ariaLabel}>
      <div className="detail-backdrop-in absolute inset-0 bg-background/70 backdrop-blur-sm backdrop-grayscale" onClick={onClose} aria-hidden="true" />
      <Card
        ref={panelRef}
        tabIndex={-1}
        className="relative z-10 flex h-full w-full flex-col overflow-hidden rounded-none pb-[env(safe-area-inset-bottom)] focus:outline-none sm:rounded sm:pb-0"
      >
        {closeButton}
        {children}
      </Card>
    </div>,
    document.body,
  );
}
