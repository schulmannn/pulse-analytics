import { WIDGET_PERIODS } from '@/components/widgets/EditWidgetDialog';
import { usePagePeriod } from '@/lib/period';
import type { PeriodDays } from '@/lib/period';

interface WidgetPeriodPillsProps {
  days: PeriodDays;
  onChange: (days: PeriodDays) => void;
  hidden?: boolean;
}

/**
 * Compact per-card period control. Rendered ONLY outside a feed (Home / standalone cards), where it
 * updates the current widget's saved period — a feed page hides it entirely because the top-bar page
 * period is authoritative (ChartSection passes `hidden` when pageControlled). It still reads
 * usePagePeriod defensively so a stray in-feed render mirrors the page period rather than diverging.
 */
export function WidgetPeriodPills({ days, onChange, hidden }: WidgetPeriodPillsProps) {
  const pagePeriod = usePagePeriod();
  if (hidden) return null;

  const activeDays = pagePeriod?.days ?? days;
  const customRange = pagePeriod?.range ?? null;
  const changePeriod = pagePeriod?.setDays ?? onChange;
  const pillClass = (active: boolean) =>
    `relative inline-flex min-h-8 min-w-8 items-center justify-center rounded px-2 text-2xs font-medium tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:min-h-0 sm:min-w-0 sm:justify-start sm:px-0.5 sm:pb-1 sm:pt-0.5 ${
      active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
    }`;

  return (
    <div
      role="group"
      aria-label={pagePeriod ? 'Период страницы' : 'Период виджета'}
      className="mt-2 flex items-center gap-3 print:hidden"
    >
      {customRange && (
        <span className={pillClass(true)} title="Выбранный период страницы">
          Свой
          <span aria-hidden="true" className="absolute inset-x-0 bottom-1 h-px bg-primary sm:-bottom-px" />
        </span>
      )}
      {WIDGET_PERIODS.map((period) => {
        const active = !customRange && activeDays === period.days;
        return (
          <button
            key={period.days}
            type="button"
            aria-pressed={active}
            onClick={() => changePeriod(period.days)}
            className={pillClass(active)}
          >
            {period.label}
            {active && <span aria-hidden="true" className="absolute inset-x-0 bottom-1 h-px bg-primary sm:-bottom-px" />}
          </button>
        );
      })}
    </div>
  );
}
