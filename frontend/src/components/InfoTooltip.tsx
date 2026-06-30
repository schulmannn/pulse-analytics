import { useEffect, useId, useState } from 'react';
import type { ReactNode } from 'react';
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
  /** Horizontal anchor of the popover relative to the trigger. Default 'left'. */
  align?: 'left' | 'right';
}

/**
 * Accessible "ⓘ" info affordance. Opens on hover, keyboard focus, or click (touch), and is
 * dismissible with Escape (WCAG 1.4.13). The popover sits inside the hover wrapper so moving
 * the pointer onto it keeps it open (hoverable). No portal — kept lightweight; callers near a
 * clipping `overflow-hidden` edge should pass align to keep it inside the box.
 */
export function InfoTooltip({ title, children, className, align = 'left' }: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <span
      className={cn('relative inline-flex align-middle', className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={`Что такое «${title}»`}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
      >
        <Icon name="info" className="h-3.5 w-3.5" />
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          className={cn(
            'absolute top-full z-30 mt-1.5 w-60 rounded-md border bg-popover p-2.5 text-left text-xs font-normal leading-relaxed text-popover-foreground shadow-md',
            align === 'left' ? 'left-0' : 'right-0',
          )}
        >
          <span className="mb-1 block font-semibold text-foreground">{title}</span>
          {children}
        </span>
      )}
    </span>
  );
}

/** Renders a metric's glossary entry (formula / included / source) inside an InfoTooltip. */
export function MetricInfo({ def, align }: { def: MetricDef; align?: 'left' | 'right' }) {
  return (
    <InfoTooltip title={def.term} align={align}>
      <span className="block space-y-1 text-muted-foreground">
        {def.formula && <span className="block">{def.formula}</span>}
        {def.included && <span className="block">{def.included}</span>}
        {def.source && <span className="block text-[11px] opacity-80">Источник: {def.source}</span>}
      </span>
    </InfoTooltip>
  );
}
