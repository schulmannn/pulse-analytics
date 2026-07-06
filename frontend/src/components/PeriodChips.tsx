import { cn } from '@/lib/utils';
import type { PeriodDays } from '@/lib/period';

const PRESETS: { days: PeriodDays; label: string }[] = [
  { days: 7, label: '7д' },
  { days: 30, label: '30д' },
  { days: 90, label: '90д' },
  { days: 0, label: 'Всё' },
];

/**
 * Compact rounded-pill period selector for a feed header (7д / 30д / 90д / Всё). Presentational —
 * the caller owns the value + setter (a page-level period that re-windows every card without its
 * own override). Same visual language as the Instagram feed's period control, so TG ↔ IG match.
 */
export function PeriodChips({
  value,
  onChange,
  className,
}: {
  value: PeriodDays;
  onChange: (days: PeriodDays) => void;
  className?: string;
}) {
  return (
    <div role="group" aria-label="Период" className={cn('flex flex-wrap items-center gap-1.5', className)}>
      {PRESETS.map((chip) => (
        <button
          key={chip.days}
          type="button"
          onClick={() => onChange(chip.days)}
          aria-pressed={value === chip.days}
          className={cn(
            'rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
            value === chip.days
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border text-muted-foreground hover:text-foreground',
          )}
        >
          {chip.label}
        </button>
      ))}
    </div>
  );
}
