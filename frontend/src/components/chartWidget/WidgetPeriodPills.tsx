import { WIDGET_PERIODS } from '@/components/chartWidget/constants';
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

  // Presets ride the shared shadcn/Radix ToggleGroup. When a custom range is active every preset is
  // off and the «Свой» indicator stands in — same custom-range display
  // semantics as before. Segments keep a ≥44px mobile hit area (compact desktop look returns at sm),
  // and this component owns the single public group so its dynamic label stays the sole labelled one.
  const touch = 'min-h-11 min-w-11 tabular-nums sm:min-h-0 sm:min-w-0';
  const groupLabel = pagePeriod ? 'Период страницы' : 'Период виджета';

  return (
    <fieldset className="m-0 mt-2 flex min-w-0 items-center gap-2 border-0 p-0 print:hidden">
      <legend className="sr-only">{groupLabel}</legend>
      {customRange && (
        <span
          className={`inline-flex h-8 ${touch} items-center justify-center rounded-full border border-input bg-accent px-2.5 text-2xs font-medium text-accent-foreground`}
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
    </fieldset>
  );
}
