import { WIDGET_PERIODS } from '@/components/widgets/EditWidgetDialog';
import { SegmentedControl } from '@/components/SegmentedControl';
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

  // Presets ride the shared sliding-glider primitive. When a custom range is active the glider
  // hides (value matches no preset) and the «Свой» indicator stands in — same custom-range display
  // semantics as before. Segments keep a ≥32px mobile hit area (compact desktop look returns at sm),
  // and this component owns the single public group so its dynamic label stays the sole labelled one.
  const touch = 'min-h-8 min-w-8 tabular-nums sm:min-h-0 sm:min-w-0';

  return (
    <div
      role="group"
      aria-label={pagePeriod ? 'Период страницы' : 'Период виджета'}
      className="mt-2 flex items-center gap-2 print:hidden"
    >
      {customRange && (
        <span
          className={`inline-flex ${touch} items-center justify-center rounded-full bg-secondary px-2.5 py-1 text-2xs font-medium text-foreground`}
          title="Выбранный период страницы"
        >
          Свой
        </span>
      )}
      <SegmentedControl
        groupless
        size="sm"
        segmentClassName={touch}
        value={customRange ? '' : String(activeDays)}
        onChange={(next) => changePeriod(Number(next) as PeriodDays)}
        options={WIDGET_PERIODS.map((period) => ({ value: String(period.days), content: period.label }))}
      />
    </div>
  );
}
