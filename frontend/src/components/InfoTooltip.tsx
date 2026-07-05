import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/nav-icons';
import { cn } from '@/lib/utils';
import type { MetricDef } from '@/lib/metricDefs';

interface InfoTooltipProps {
  /** Accessible heading for the term. */
  title: string;
  /** Tooltip body. */
  children: ReactNode;
  /** Extra classes on the trigger wrapper. */
  className?: string;
}

const POP_WIDTH = 240;
const MARGIN = 8;

/**
 * Accessible "ⓘ" info affordance. Opens on hover, keyboard focus, or click (touch), and is
 * dismissible with Escape (WCAG 1.4.13). The popover is portaled to <body> with fixed
 * positioning + viewport clamping, so it's never clipped by a card's `overflow-hidden` nor
 * pushed off-screen by a narrow tile. A short close delay bridges the trigger→popover gap so
 * the popover stays hoverable.
 */
export function InfoTooltip({ title, children, className }: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = () => {
    if (closeTimer.current) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const openNow = () => {
    cancelClose();
    setOpen(true);
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 90);
  };

  // Place the popover just below the trigger, clamped horizontally into the viewport.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - POP_WIDTH - MARGIN));
    setPos({ top: r.bottom + 6, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    // A transient tooltip detaches from its anchor on scroll/resize — just close it.
    const onShift = () => setOpen(false);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onShift, true);
    window.addEventListener('resize', onShift);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onShift, true);
      window.removeEventListener('resize', onShift);
    };
  }, [open]);

  useEffect(() => () => cancelClose(), []);

  return (
    <span
      className={cn('relative inline-flex align-middle', className)}
      onMouseEnter={openNow}
      onMouseLeave={scheduleClose}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Что такое «${title}»`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onFocus={openNow}
        onBlur={() => setOpen(false)}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <Icon name="info" className="h-3.5 w-3.5" />
      </button>
      {open &&
        pos &&
        createPortal(
          <span
            id={id}
            role="tooltip"
            onMouseEnter={openNow}
            onMouseLeave={scheduleClose}
            style={{ position: 'fixed', top: pos.top, left: pos.left, width: POP_WIDTH }}
            className="z-tooltip rounded border bg-popover p-2.5 text-left text-xs font-normal leading-relaxed text-popover-foreground"
          >
            <span className="mb-1 block font-medium text-foreground">{title}</span>
            {children}
          </span>,
          document.body,
        )}
    </span>
  );
}

/** Renders a metric's glossary entry (formula / included / source) inside an InfoTooltip. */
export function MetricInfo({ def }: { def: MetricDef }) {
  return (
    <InfoTooltip title={def.term}>
      <span className="block space-y-1 text-muted-foreground">
        {def.formula && <span className="block">{def.formula}</span>}
        {def.included && <span className="block">{def.included}</span>}
        {def.source && <span className="block text-2xs opacity-80">Источник: {def.source}</span>}
      </span>
    </InfoTooltip>
  );
}
