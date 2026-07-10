import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { DateRangePicker } from '@/components/DateRangePicker';
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
 * the caller owns the value + setter (a page-level period that re-windows every card without its
 * own override). One component for both networks, so TG ↔ IG match by construction.
 *
 * Pass `onRangeChange` to grow the «Свой период» chip + calendar popover (the IG header does;
 * the TG header stays presets-only until its card bodies learn ranges). A picked range makes the
 * presets read inactive — the range owns the window until a preset click clears it (caller's
 * setDays is expected to reset the range, as both period providers do).
 */
export function PeriodChips({
  value,
  onChange,
  range,
  onRangeChange,
  className,
}: {
  value: PeriodDays;
  onChange: (days: PeriodDays) => void;
  range?: DateRange | null;
  onRangeChange?: (range: DateRange | null) => void;
  className?: string;
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
    <div role="group" aria-label="Период" className={cn('relative flex flex-wrap items-center gap-1.5', className)}>
      {PRESETS.map((chip) => (
        <button
          key={chip.days}
          type="button"
          onClick={() => onChange(chip.days)}
          aria-pressed={!range && value === chip.days}
          className={cn(
            'rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
            !range && value === chip.days
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border text-muted-foreground hover:text-foreground',
          )}
        >
          {chip.label}
        </button>
      ))}
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
              <div className="absolute right-0 top-full z-popover mt-2 rounded-lg border border-border bg-popover p-3">
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
