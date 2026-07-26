import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DateRangePicker } from '@/components/DateRangePicker';
import { SegmentedControl } from '@/components/SegmentedControl';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import type { DateRange, PeriodDays } from '@/lib/period';

const PRESETS: { days: PeriodDays; label: string }[] = [
  { days: 7, label: '7д' },
  { days: 30, label: '30д' },
  { days: 90, label: '90д' },
  { days: 0, label: 'Всё' },
];

/** Short «дд.мм» for the active custom-range chip label. */
// Канон дат приложения — «3 июн.», не «03.06» (регресс закрытого канона, проход №3).
const fmtRangeChip = (ms: number) =>
  new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

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
  return (
    <fieldset className={cn('relative m-0 flex min-w-0 flex-wrap items-center gap-1.5 border-0 p-0', className)}>
      <legend className="sr-only">{ariaLabel}</legend>
      {/* Presets ride the shared sliding-glider primitive; a picked custom range deselects every
          preset (value matches no segment → the glider hides). Rendered `groupless` so this one
          public «Период» group stays the sole labelled group (the «Свой период» pill lives in it). */}
      <SegmentedControl
        groupless
        value={range ? '' : String(value)}
        onChange={(days) => onChange(Number(days) as PeriodDays)}
        options={PRESETS.map((chip) => ({
          value: String(chip.days),
          content: chip.label,
        }))}
      />
      {onRangeChange && (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            {/* Part of the shared Button system rather than an ad-hoc pill; the active (picked-range)
                state tints the same outline chip so it still reads as pressed next to the presets.
                NO aria-pressed here: Radix already owns aria-expanded/aria-haspopup on a popover
                trigger, and a button cannot be a toggle and a disclosure at once (screen readers
                would announce both states). The picked range is carried by the accessible NAME —
                the label itself becomes «3 июн. – 12 июн.» — so the state stays announced. */}
            <Button
              type="button"
              variant="outline"
              size="xs"
              className={cn(
                'min-h-11 min-w-11 font-medium sm:min-h-7 sm:min-w-0',
                range
                  ? 'border-primary/40 bg-primary/10 text-accent-foreground hover:bg-primary/10 hover:text-accent-foreground'
                  : 'border-border bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground',
              )}
            >
              {range
                ? `${fmtRangeChip(range.from)} – ${fmtRangeChip(range.to)}`
                : 'Свой период'}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={8} className="w-auto p-3">
            <DateRangePicker
              value={range ?? null}
              onApply={(nextRange) => {
                onRangeChange(nextRange);
                setPickerOpen(false);
              }}
              onReset={() => {
                onRangeChange(null);
                setPickerOpen(false);
              }}
            />
          </PopoverContent>
        </Popover>
      )}
    </fieldset>
  );
}
