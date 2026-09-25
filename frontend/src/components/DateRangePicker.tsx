import { useEffect, useState } from 'react';
import { ru } from 'react-day-picker/locale';
import type { DateRange as DayPickerRange, Modifiers } from 'react-day-picker';

import { Button } from '@/components/ui/button';
import { Calendar } from '@/components/ui/calendar';
import { endOfLocalDay, shiftLocalDays, startOfLocalDay } from '@/lib/period';

interface Props {
  value: { from: number; to: number } | null;
  onApply: (range: { from: number; to: number }) => void;
  onReset: () => void;
}

interface Preset {
  label: string;
  range: DayPickerRange;
}

const localDate = (timestamp: number) => new Date(startOfLocalDay(timestamp));

function sameDay(left: Date | undefined, right: Date | undefined) {
  return left != null && right != null && startOfLocalDay(left.getTime()) === startOfLocalDay(right.getTime());
}

function sameRange(left: DayPickerRange | undefined, right: DayPickerRange) {
  return sameDay(left?.from, right.from) && sameDay(left?.to, right.to);
}

function capitalize(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatRange(range: DayPickerRange | undefined) {
  if (!range?.from) return 'Выберите начало и конец периода';
  if (!range.to) {
    return `Начало: ${range.from.toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })}`;
  }

  const from = range.from;
  const to = range.to;
  const sameMonth =
    from.getFullYear() === to.getFullYear() && from.getMonth() === to.getMonth();
  const sameYear = from.getFullYear() === to.getFullYear();

  if (sameMonth) {
    return `${from.getDate()}–${to.getDate()} ${to.toLocaleDateString('ru-RU', {
      month: 'long',
      year: 'numeric',
    })}`;
  }
  if (sameYear) {
    return `${from.toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
    })} — ${to.toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    })}`;
  }
  return `${from.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })} — ${to.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  })}`;
}

function dayLabel(date: Date, modifiers: Modifiers) {
  const suffix = [
    modifiers.today ? 'сегодня' : null,
    modifiers.range_start ? 'начало диапазона' : null,
    modifiers.range_middle ? 'в диапазоне' : null,
    modifiers.range_end ? 'конец диапазона' : null,
  ].filter(Boolean);
  const dateLabel = date.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
  return suffix.length > 0 ? `${dateLabel}, ${suffix.join(', ')}` : dateLabel;
}

/**
 * Product wrapper around the shared shadcn/React DayPicker calendar.
 * The primitive owns calendar semantics, keyboard navigation and range rendering; this layer keeps
 * Atlavue's local-day timestamps, analytics presets and explicit apply/reset contract.
 */
export function DateRangePicker({ value, onApply, onReset }: Props) {
  const todayStart = startOfLocalDay(Date.now());
  const today = new Date(todayStart);
  const initialRange: DayPickerRange | undefined = value
    ? { from: localDate(value.from), to: localDate(value.to) }
    : undefined;
  const [selected, setSelected] = useState<DayPickerRange | undefined>(initialRange);
  const [view, setView] = useState(() => {
    const base = localDate(value?.from ?? todayStart);
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });

  useEffect(() => {
    setSelected(
      value ? { from: localDate(value.from), to: localDate(value.to) } : undefined,
    );
    if (value) {
      const base = localDate(value.from);
      setView(new Date(base.getFullYear(), base.getMonth(), 1));
    }
  }, [value?.from, value?.to]);

  const current = new Date();
  const previousMonthStart = new Date(current.getFullYear(), current.getMonth() - 1, 1);
  const previousMonthEnd = new Date(current.getFullYear(), current.getMonth(), 0);
  const presets: Preset[] = [
    {
      label: 'Последние 14 дней',
      range: {
        from: localDate(shiftLocalDays(todayStart, -13)),
        to: today,
      },
    },
    {
      label: 'Этот месяц',
      range: {
        from: new Date(current.getFullYear(), current.getMonth(), 1),
        to: today,
      },
    },
    {
      label: 'Прошлый месяц',
      range: {
        from: previousMonthStart,
        to: previousMonthEnd,
      },
    },
    {
      label: 'Этот год',
      range: {
        from: new Date(current.getFullYear(), 0, 1),
        to: today,
      },
    },
  ];

  const canApply = selected?.from != null && selected.to != null;

  const choosePreset = (preset: Preset) => {
    setSelected(preset.range);
    const base = preset.range.from ?? today;
    setView(new Date(base.getFullYear(), base.getMonth(), 1));
  };

  return (
    <div className="w-[320px] max-w-[calc(100vw-2rem)]">
      <fieldset className="grid grid-cols-2 gap-1 border-b border-border p-3">
        <legend className="sr-only">Быстрый выбор периода</legend>
        {presets.map((preset) => {
          const active = sameRange(selected, preset.range);
          return (
            <Button
              key={preset.label}
              type="button"
              variant={active ? 'secondary' : 'ghost'}
              size="xs"
              shape="rounded"
              aria-pressed={active}
              onClick={() => choosePreset(preset)}
              className="justify-start px-2.5 font-normal"
            >
              {preset.label}
            </Button>
          );
        })}
      </fieldset>

      <Calendar
        mode="range"
        month={view}
        onMonthChange={setView}
        selected={selected}
        onSelect={setSelected}
        locale={ru}
        today={today}
        endMonth={today}
        disabled={{ after: today }}
        excludeDisabled
        resetOnSelect
        fixedWeeks
        className="w-full bg-transparent"
        formatters={{
          formatCaption: (date) =>
            capitalize(
              date.toLocaleDateString('ru-RU', {
                month: 'long',
                year: 'numeric',
              }).replace(/\sг\.$/, ''),
            ),
          formatWeekdayName: (date) =>
            capitalize(
              date
                .toLocaleDateString('ru-RU', { weekday: 'short' })
                .replace('.', ''),
            ),
        }}
        labels={{
          labelPrevious: () => 'Предыдущий месяц',
          labelNext: () => 'Следующий месяц',
          labelDayButton: dayLabel,
        }}
      />

      <div className="flex items-center gap-3 border-t border-border p-3">
        <p role="status" aria-live="polite" className="min-w-0 flex-1 text-xs text-muted-foreground">
          {formatRange(selected)}
        </p>
        <Button type="button" variant="ghost" size="xs" onClick={onReset}>
          Сбросить
        </Button>
        <Button
          type="button"
          size="xs"
          disabled={!canApply}
          onClick={() => {
            if (!selected?.from || !selected.to) return;
            onApply({
              from: startOfLocalDay(selected.from.getTime()),
              to: endOfLocalDay(selected.to.getTime()),
            });
          }}
        >
          Применить
        </Button>
      </div>
    </div>
  );
}
