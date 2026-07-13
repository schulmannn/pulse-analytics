import { WIDGET_PERIODS } from '@/components/widgets/EditWidgetDialog';
import { usePagePeriod } from '@/lib/period';
import type { PeriodDays } from '@/lib/period';

interface WidgetPeriodPillsProps {
  days: PeriodDays;
  override: PeriodDays | undefined;
  onChange: (days: PeriodDays) => void;
  onFollow?: () => void;
  hidden?: boolean;
}

/** Compact period control scoped to one widget card. */
export function WidgetPeriodPills({ days, override, onChange, onFollow, hidden }: WidgetPeriodPillsProps) {
  const pagePeriod = usePagePeriod();
  if (hidden) return null;

  const following = override === undefined && pagePeriod != null;
  const pillClass = (active: boolean) =>
    `relative inline-flex min-h-8 min-w-8 items-center justify-center rounded px-2 text-2xs font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:min-h-0 sm:min-w-0 sm:justify-start sm:px-0.5 sm:pb-1 sm:pt-0.5 ${
      active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
    }`;

  return (
    <div role="group" aria-label="Период виджета" className="mt-2 flex items-center gap-3 print:hidden">
      {pagePeriod != null && onFollow && (
        <button
          type="button"
          aria-pressed={following}
          title="Следовать периоду страницы"
          onClick={onFollow}
          className={pillClass(following)}
        >
          Стр.
          {following && <span aria-hidden="true" className="absolute inset-x-0 bottom-1 h-px bg-primary sm:-bottom-px" />}
        </button>
      )}
      {WIDGET_PERIODS.map((period) => {
        const active = !following && days === period.days;
        const echoed = following && days === period.days;
        return (
          <button
            key={period.days}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(period.days)}
            className={pillClass(active)}
          >
            {period.label}
            {active && <span aria-hidden="true" className="absolute inset-x-0 bottom-1 h-px bg-primary sm:-bottom-px" />}
            {echoed && <span aria-hidden="true" className="absolute inset-x-0 bottom-1 h-px bg-border sm:-bottom-px" />}
          </button>
        );
      })}
    </div>
  );
}
