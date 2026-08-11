import { useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Icon } from '@/components/nav-icons';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  isTooltipSkipActive,
  openTooltipSkipWindow,
  subscribeTooltipSkip,
  tooltipDelayFor,
} from '@/lib/tooltipSkip';
import type { MetricDef } from '@/lib/widgetMetrics';

interface InfoTooltipProps {
  /** Accessible heading for the term. */
  title: string;
  /** Tooltip body. */
  children: ReactNode;
  /** Extra classes on the trigger wrapper. */
  className?: string;
}

/**
 * Accessible "ⓘ" info affordance. shadcn/Radix owns collision-aware positioning, portal,
 * focus/hover semantics and Escape dismissal; the controlled click keeps it usable on touch.
 *
 * Провайдер остаётся ПОСВОЙ у каждой ⓘ (общий в корне тянет @radix-ui/react-tooltip в статическое
 * замыкание каждого защищённого маршрута — замерено, +2.5KB gzip на каждый). Групповое поведение
 * «первая ждёт, соседние мгновенно» даёт общее окно пропуска из lib/tooltipSkip: оно уведомляет
 * подписчиков на ОБОИХ переходах, поэтому delayDuration не может протухнуть между рендерами.
 */
export function InfoTooltip({ title, children, className }: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const skip = useSyncExternalStore(subscribeTooltipSkip, isTooltipSkipActive, () => false);

  return (
    <TooltipProvider delayDuration={tooltipDelayFor(skip)}>
      <Tooltip
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // Закрытие — старт окна: следующая ⓘ под курсором откроется без задержки.
          if (!next) openTooltipSkipWindow();
        }}
      >
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`Что такое «${title}»`}
            aria-expanded={open}
            onClick={(event) => {
              event.stopPropagation();
              setOpen((value) => !value);
            }}
            className={cn(
              'inline-flex h-4 w-4 items-center justify-center rounded-full align-middle text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40',
              className,
            )}
          >
            <Icon name="info" className="h-3.5 w-3.5" />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="start"
          sideOffset={6}
          className="w-60 text-left font-normal"
        >
          <span className="mb-1 block font-medium text-foreground">
            {title}
          </span>
          {children}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Renders a metric's glossary entry (formula / included / source) inside an InfoTooltip. */
export function MetricInfo({ def }: { def: MetricDef }) {
  return (
    <InfoTooltip title={def.glossaryLabel ?? def.label}>
      <span className="block space-y-1 text-muted-foreground">
        {def.formula && <span className="block">{def.formula}</span>}
        {def.included && <span className="block">{def.included}</span>}
        {def.sourceNote && (
          <span className="block text-2xs opacity-80">
            Источник: {def.sourceNote}
          </span>
        )}
      </span>
    </InfoTooltip>
  );
}
