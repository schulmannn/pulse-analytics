import type { ReactNode } from 'react';
import { DeltaPill } from '@/components/DeltaPill';
import type { MetricDelta } from '@/lib/delta';

export interface ChartCardBodyProps {
  label?: ReactNode;
  value: string;
  delta?: MetricDelta | null;
  caption?: ReactNode;
  onValueClick?: () => void;
  /** Accessible metric name for the clickable headline value. */
  drillLabel?: string;
  hero?: boolean;
  children: ReactNode;
}

/** Headline, comparison, and chart layout shared by metric cards. */
export function ChartCardBody({
  label,
  value,
  delta,
  caption,
  onValueClick,
  drillLabel,
  hero = false,
  children,
}: ChartCardBodyProps) {
  const numberClass = `kpi-accent ${hero ? 'text-hero' : 'text-3xl'} font-medium leading-none tabular-nums tracking-tight`;
  return (
    <div className="flex h-full min-h-0 items-end gap-4">
      <div className="flex shrink-0 flex-col items-start gap-1.5 pb-0.5">
        {label != null && <div className="text-xs tracking-wide text-muted-foreground">{label}</div>}
        {onValueClick ? (
          <button
            type="button"
            aria-label={drillLabel ? `Разбор: ${drillLabel}` : undefined}
            title="Подробный разбор"
            onClick={onValueClick}
            className={`${numberClass} rounded text-left transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40`}
          >
            {value}
          </button>
        ) : (
          <div className={numberClass}>{value}</div>
        )}
        <DeltaPill delta={delta} />
        {caption != null && <div className="text-2xs text-muted-foreground">{caption}</div>}
      </div>
      <div className="min-h-0 min-w-0 flex-1 self-stretch">{children}</div>
    </div>
  );
}
