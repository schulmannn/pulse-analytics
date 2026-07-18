import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { DateRangePicker } from '@/components/DateRangePicker';
import { SegmentedControl } from '@/components/SegmentedControl';
import type { DateRange, PeriodDays } from '@/lib/period';

const PRESETS: { days: PeriodDays; label: string }[] = [
  { days: 7, label: '7д' },
  { days: 30, label: '30д' },
  { days: 90, label: '90д' },
  { days: 0, label: 'Всё' },
];

/** Short «дд.мм» for the active custom-range chip label. */
// Канон дат приложения — «3 июн.», не «03.06» (регресс закрытого канона, проход №3).
const fmtRangeChip = (ms: number) => new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

/**
 * Compact rounded-pill period selector for a feed header (7д / 30д / 90д / Всё). Presentational —
 * the caller owns the value + setter (the page-level period that re-windows every feed card).
 * One component for both networks, so TG ↔ IG match by construction.
 *
 * Pass `onRangeChange` to add the «Свой период» chip + calendar popover. Both source feeds do this,
 * so Telegram and Instagram share one range contract. A picked range makes the presets inactive
 * until a preset click clears it (both period providers reset the range in `setDays`).
 */
export function PeriodChips({
  value,
  onChange,
  range,
  onRangeChange,
  className,
  ariaLabel = 'Период',
}: {
  value: PeriodDays;
  onChange: (days: PeriodDays) => void;
  range?: DateRange | null;
  onRangeChange?: (range: DateRange | null) => void;
  className?: string;
  /** Accessible group name; metric explorers call the same control «Окно». */
  ariaLabel?: string;
}) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Esc закрывает поповер и возвращает фокус на чип — как все остальные дропдауны (аудит:
  // это был единственный Esc-less дропдаун приложения).
  useEffect(() => {
    if (!pickerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPickerOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [pickerOpen]);
  return (
    <div role="group" aria-label={ariaLabel} className={cn('relative flex flex-wrap items-center gap-1.5', className)}>
      {/* Presets ride the shared sliding-glider primitive; a picked custom range deselects every
          preset (value matches no segment → the glider hides). Rendered `groupless` so this one
          public «Период» group stays the sole labelled group (the «Свой период» pill lives in it). */}
      <SegmentedControl
        groupless
        value={range ? '' : String(value)}
        onChange={(days) => onChange(Number(days) as PeriodDays)}
        options={PRESETS.map((chip) => ({ value: String(chip.days), content: chip.label }))}
      />
      {onRangeChange && (
        <>
          <button
            ref={triggerRef}
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            aria-pressed={!!range}
            className={cn(
              'rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
              range
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {range ? `${fmtRangeChip(range.from)} – ${fmtRangeChip(range.to)}` : 'Свой период'}
          </button>
          {pickerOpen && (
            <>
              {/* Scrim = клик мимо; Esc обрабатывает keydown-эффект выше. */}
              <div className="fixed inset-0 z-popover" aria-hidden="true" onClick={() => setPickerOpen(false)} />
              <div className="absolute right-0 top-full z-popover mt-2 rounded-xl border border-border bg-popover p-3">
                <DateRangePicker
                  value={range ?? null}
                  onApply={(r) => {
                    onRangeChange(r);
                    setPickerOpen(false);
                  }}
                  onReset={() => {
                    onRangeChange(null);
                    setPickerOpen(false);
                  }}
                />
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
