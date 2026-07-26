import { useEffect, useId, useRef, useState } from 'react';
import type { FocusEvent, KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { endOfLocalDay, shiftLocalDays, startOfLocalDay } from '@/lib/period';

/**
 * Custom date-range picker (replaces the raw native <input type=date>). Refined Technical styling:
 * white popover, hairlines, one blue accent. A month grid with prev/next nav + range highlighting,
 * a row of quick presets ("средство поиска" — fast selection), and a mono read-out of the range.
 * Days are Monday-first (ru). Endpoints render filled; the in-between span gets a blue tint.
 *
 * A11y — the month is a real labelled table, not a visual grid of 31 loose buttons:
 *   • ONE tab stop. A roving tabindex keeps exactly one day focusable; Tab enters and leaves the
 *     whole month instead of walking it cell by cell (it used to cost up to 31 presses to reach
 *     «Применить»).
 *   • The layout is two-dimensional and so is the navigation: ←/→ a day, ↑/↓ the SAME weekday a
 *     week away, Home/End the ends of that week, PageUp/PageDown a month, +Shift a year. Crossing a
 *     month boundary re-views the calendar, so the walk never dead-ends at the edge.
 *   • Focus and selection are separate acts: arrows only move the caret, Enter/Space commits an
 *     endpoint. Focus previews the pending span exactly like hover does, so the keyboard is no
 *     longer picking blind.
 *   • Future days use `aria-disabled`, NOT the native `disabled`: a natively disabled cell is
 *     unfocusable, so arrow navigation would hit a silent hole at the end of the month. This way
 *     the cell stays reachable and announces «недоступно»; the click/hover guards moved into JS.
 *   • Selection is announced, not merely tinted — `aria-pressed` on date buttons,
 *     `aria-current="date"` on today, and a polite status line carrying the pick state
 *     («Начало: … Выберите конец»).
 */

const WD: { short: string; full: string }[] = [
  { short: 'Пн', full: 'Понедельник' },
  { short: 'Вт', full: 'Вторник' },
  { short: 'Ср', full: 'Среда' },
  { short: 'Чт', full: 'Четверг' },
  { short: 'Пт', full: 'Пятница' },
  { short: 'Сб', full: 'Суббота' },
  { short: 'Вс', full: 'Воскресенье' },
];
const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];
function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
/** Spoken day name — genitive via Intl («5 июня 2026 г.»), so it reads as a date, not a list of words. */
function spokenDate(ms: number): string {
  return new Date(ms).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}
/* The three calendar-geometry helpers below are exported for unit tests only — they are the pure
   core the keyboard grid navigates on, and getting the Monday-first offset or the month-length
   clamp wrong is silent (the grid still renders, just off by a day). Not part of the public API. */

/** 0 = Monday — the grid is Monday-first, so weekday maths cannot use getDay() directly. */
export function weekdayIndex(ts: number): number {
  return (new Date(ts).getDay() + 6) % 7;
}
/** Same day-of-month `n` months away, clamped to the target month's length (31 Jan +1 → 28/29 Feb). */
export function shiftMonths(ts: number, n: number): number {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = d.getMonth() + n;
  const daysInTarget = new Date(y, m + 1, 0).getDate();
  return new Date(y, m, Math.min(d.getDate(), daysInTarget)).getTime();
}
/** Calendar cells for a month as WEEKS, Monday-first; leading/trailing blanks as null. */
export function monthWeeks(view: Date): (number | null)[][] {
  const y = view.getFullYear();
  const m = view.getMonth();
  const startWd = (new Date(y, m, 1).getDay() + 6) % 7; // 0 = Monday
  const days = new Date(y, m + 1, 0).getDate();
  const cells: (number | null)[] = Array(startWd).fill(null);
  for (let d = 1; d <= days; d++) cells.push(new Date(y, m, d).getTime());
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

function Chevron({ dir }: { dir: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4" aria-hidden="true">
      <path d={dir === 'left' ? 'M15 18l-6-6 6-6' : 'M9 6l6 6-6 6'} />
    </svg>
  );
}

interface Props {
  value: { from: number; to: number } | null;
  onApply: (range: { from: number; to: number }) => void;
  onReset: () => void;
}

export function DateRangePicker({ value, onApply, onReset }: Props) {
  const todayStart = startOfLocalDay(Date.now());
  const [from, setFrom] = useState<number | null>(value ? startOfLocalDay(value.from) : null);
  const [to, setTo] = useState<number | null>(value ? startOfLocalDay(value.to) : null);
  const [hover, setHover] = useState<number | null>(null);
  const [view, setView] = useState(() => {
    const base = new Date(value?.from ?? Date.now());
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  // Каретка сетки (roving tabindex). Стартует с того же основания, что и `view`, поэтому всегда
  // лежит внутри показанного месяца — иначе ни одна ячейка не получила бы tabIndex=0.
  const [focusedTs, setFocusedTs] = useState(() => startOfLocalDay(value?.from ?? Date.now()));
  const gridRef = useRef<HTMLTableElement>(null);
  // Переводить фокус в DOM нужно ТОЛЬКО после клавиатурного шага. Без флага эффект воровал бы
  // фокус на монтировании и при кликах по стрелкам месяца.
  const pendingFocus = useRef(false);
  const captionId = useId();
  const statusId = useId();

  // Дальше текущего месяца листать некуда: будущих данных не существует (аудит).
  const atCurrentMonth =
    view.getFullYear() === new Date(todayStart).getFullYear() && view.getMonth() === new Date(todayStart).getMonth();
  // Верхняя граница каретки — конец ТЕКУЩЕГО календарного месяца: дальше «Следующий месяц»
  // недоступен, и уводить туда фокус стрелками было бы тупиком.
  const focusMax = startOfLocalDay(
    new Date(new Date(todayStart).getFullYear(), new Date(todayStart).getMonth() + 1, 0).getTime(),
  );

  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${focusedTs}"]`)?.focus();
  }, [focusedTs]);

  // Pointer hover is only a preview; the table itself is passive semantic structure. A native
  // boundary listener clears that preview without assigning an interactive role to the table.
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const clearHover = () => setHover(null);
    grid.addEventListener('mouseleave', clearHover);
    return () => grid.removeEventListener('mouseleave', clearHover);
  }, []);

  const pickDay = (ts: number) => {
    if (from == null || to != null) {
      setFrom(ts);
      setTo(null);
    } else if (ts < from) {
      setTo(from);
      setFrom(ts);
    } else {
      setTo(ts);
    }
  };

  /** Клавиатурный шаг каретки: подтягивает `view`, если ушли в соседний месяц, и просит фокус. */
  const moveFocus = (nextTs: number) => {
    const clamped = Math.min(nextTs, focusMax);
    const d = new Date(clamped);
    if (d.getFullYear() !== view.getFullYear() || d.getMonth() !== view.getMonth()) {
      setView(new Date(d.getFullYear(), d.getMonth(), 1));
    }
    setFocusedTs(clamped);
    setHover(clamped);
    pendingFocus.current = true;
  };

  const shiftMonth = (delta: number) => {
    const next = new Date(view.getFullYear(), view.getMonth() + delta, 1);
    setView(next);
    // Каретка едет за месяцем (без кражи фокуса) — иначе возврат Tab'ом в сетку попадал бы в месяц,
    // которого на экране уже нет, и ни одна ячейка не была бы фокусируемой.
    setFocusedTs((prev) => {
      const p = new Date(prev);
      const daysInNext = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      return Math.min(
        new Date(next.getFullYear(), next.getMonth(), Math.min(p.getDate(), daysInNext)).getTime(),
        focusMax,
      );
    });
  };

  const preset = (f: number, t: number) => {
    setFrom(f);
    setTo(t);
    const d = new Date(f);
    setView(new Date(d.getFullYear(), d.getMonth(), 1));
    setFocusedTs(f);
  };
  const presets: { label: string; run: () => void }[] = [
    { label: 'Последние 14 дней', run: () => preset(shiftLocalDays(todayStart, -13), todayStart) },
    {
      label: 'Этот месяц',
      run: () => {
        const d = new Date();
        preset(new Date(d.getFullYear(), d.getMonth(), 1).getTime(), todayStart);
      },
    },
    {
      label: 'Прошлый месяц',
      run: () => {
        const d = new Date();
        const f = new Date(d.getFullYear(), d.getMonth() - 1, 1);
        const t = new Date(d.getFullYear(), d.getMonth(), 0);
        preset(f.getTime(), startOfLocalDay(t.getTime()));
      },
    },
    {
      label: 'Этот год',
      run: () => {
        const d = new Date();
        preset(new Date(d.getFullYear(), 0, 1).getTime(), todayStart);
      },
    },
  ];

  // While picking the end date, preview the span up to the hovered OR focused day (клавиатурный
  // паритет: раньше превью было только мышиным, и с клавиатуры второй конец выбирался вслепую).
  const rangeEnd = to ?? (from != null && hover != null && hover > from ? hover : null);
  const inPreview = (ts: number) => from != null && rangeEnd != null && ts > from && ts < rangeEnd;
  // Для ARIA берём ТОЛЬКО зафиксированный диапазон: иначе метки ячеек переписывались бы на каждом
  // наведении мыши, и скринридер тараторил бы про предпросмотр.
  const inCommitted = (ts: number) => from != null && to != null && ts > from && ts < to;

  const weeks = monthWeeks(view);
  const canApply = from != null && to != null;
  const status =
    from == null
      ? 'Период не выбран. Выберите начало периода.'
      : to == null
        ? `Начало: ${spokenDate(from)}. Выберите конец периода.`
        : `Период выбран: с ${spokenDate(from)} по ${spokenDate(to)}.`;

  const handleDayBlur = (event: FocusEvent<HTMLButtonElement>) => {
    const table = event.currentTarget.closest('table');
    // Фокус ушёл из календаря целиком → снимаем предпросмотр.
    if (!table?.contains(event.relatedTarget as Node | null)) setHover(null);
  };

  const handleDayKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowLeft': next = shiftLocalDays(focusedTs, -1); break;
      case 'ArrowRight': next = shiftLocalDays(focusedTs, 1); break;
      case 'ArrowUp': next = shiftLocalDays(focusedTs, -7); break;
      case 'ArrowDown': next = shiftLocalDays(focusedTs, 7); break;
      case 'Home': next = shiftLocalDays(focusedTs, -weekdayIndex(focusedTs)); break;
      case 'End': next = shiftLocalDays(focusedTs, 6 - weekdayIndex(focusedTs)); break;
      case 'PageUp': next = shiftMonths(focusedTs, event.shiftKey ? -12 : -1); break;
      case 'PageDown': next = shiftMonths(focusedTs, event.shiftKey ? 12 : 1); break;
      default: return;
    }
    event.preventDefault();
    moveFocus(next);
  };

  return (
    <div className="w-[300px]">
      <fieldset className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0 pb-3">
        <legend className="sr-only">Быстрый выбор периода</legend>
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={p.run}
            className="rounded-full border border-border px-2.5 py-1 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {p.label}
          </button>
        ))}
      </fieldset>

      <div className="flex items-center justify-between pb-2">
        <button
          type="button"
          onClick={() => shiftMonth(-1)}
          aria-label="Предыдущий месяц"
          className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Chevron dir="left" />
        </button>
        {/* Живой регион: смена месяца иначе проходит молча — заголовок меняется, но не объявляется. */}
        <div id={captionId} aria-live="polite" className="text-sm font-medium tabular-nums">
          {MONTHS[view.getMonth()]} {view.getFullYear()}
        </div>
        <button
          type="button"
          onClick={() => shiftMonth(1)}
          disabled={atCurrentMonth}
          aria-label="Следующий месяц"
          title={atCurrentMonth ? 'Данных за будущие даты не существует' : undefined}
          className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
        >
          <Chevron dir="right" />
        </button>
      </div>

      <table
        ref={gridRef}
        aria-labelledby={captionId}
        className="block w-full border-collapse"
      >
        <thead className="block">
          <tr className="grid grid-cols-7 gap-0.5 pb-1 text-center text-2xs text-muted-foreground">
            {WD.map((w) => (
              <th key={w.short} scope="col" aria-label={w.full} className="font-normal">
                {w.short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="block">
          {weeks.map((week, wi) => (
            // eslint-disable-next-line react/no-array-index-key -- недели позиционны внутри месяца
            <tr key={wi} className="grid grid-cols-7 gap-0.5">
              {week.map((ts, di) => {
                if (ts == null) return <td key={di} className="p-0" />;
                const isEdge = ts === from || ts === to;
                const isToday = ts === todayStart;
                // Будущий день не выбрать: диапазон в будущем давал пустые графики без объяснения (аудит).
                const isFuture = ts > todayStart;
                const selected = isEdge || inCommitted(ts);
                const stateLabel =
                  isFuture ? ', недоступно'
                  : ts === from ? ', начало периода'
                  : ts === to ? ', конец периода'
                  : inCommitted(ts) ? ', в выбранном периоде'
                  : '';
                return (
                  <td key={di} className="p-0">
                    <button
                      type="button"
                      data-day={ts}
                      // Roving tabindex: фокусируема ровно одна дата месяца.
                      tabIndex={ts === focusedTs ? 0 : -1}
                      aria-disabled={isFuture || undefined}
                      aria-current={isToday ? 'date' : undefined}
                      aria-pressed={selected}
                      aria-label={`${spokenDate(ts)}${stateLabel}`}
                      onClick={() => {
                        if (isFuture) return; // aria-disabled не блокирует клик — гасим здесь
                        setFocusedTs(ts);
                        pickDay(ts);
                      }}
                      onBlur={handleDayBlur}
                      onKeyDown={handleDayKeyDown}
                      onFocus={() => {
                        if (!isFuture) setHover(ts);
                      }}
                      onMouseEnter={() => {
                        if (!isFuture) setHover(ts);
                      }}
                      className={cn(
                        'flex h-8 w-full items-center justify-center rounded text-xs tabular-nums transition-colors',
                        isEdge
                          ? 'bg-primary font-medium text-primary-foreground'
                          : inPreview(ts)
                            ? 'bg-accent text-foreground'
                            : 'text-foreground hover:bg-muted',
                        // Никакого pointer-events-none: дата обязана оставаться фокусируемой, иначе
                        // стрелка упрётся в дыру в конце месяца. Гасим только курсор и подсветку.
                        isFuture && 'cursor-default opacity-35 hover:bg-transparent',
                        isToday && !isEdge && 'ring-1 ring-inset ring-primary/40',
                        'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40',
                      )}
                    >
                      {new Date(ts).getDate()}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Визуальный read-out скрыт от скринридера — «→» и «…» читаются мусором; смысл несёт
          статус-строка ниже, единственный источник объявления состояния выбора. */}
      <div aria-hidden="true" className="mt-3 font-mono text-2xs tabular-nums text-muted-foreground">
        {from != null ? fmtDate(from) : '—'} → {to != null ? fmtDate(to) : '…'}
      </div>
      <span id={statusId} role="status" aria-live="polite" className="sr-only">
        {status}
      </span>

      <div className="mt-2 flex gap-2">
        <Button
          type="button"
          disabled={!canApply}
          aria-describedby={statusId}
          title={canApply ? undefined : 'Выберите обе даты периода'}
          onClick={() => canApply && onApply({ from: startOfLocalDay(from), to: endOfLocalDay(to) })}
          size="xs"
          className="flex-1"
        >
          Применить
        </Button>
        <button
          type="button"
          onClick={onReset}
          className="btn-pill border border-border px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Сброс
        </button>
      </div>
    </div>
  );
}
