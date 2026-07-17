import { useState } from 'react';
import { cn } from '@/lib/utils';
import { endOfLocalDay, shiftLocalDays, startOfLocalDay } from '@/lib/period';

/**
 * Custom date-range picker (replaces the raw native <input type=date>). Refined Technical styling:
 * white popover, hairlines, one blue accent. A month grid with prev/next nav + range highlighting,
 * a row of quick presets ("средство поиска" — fast selection), and a mono read-out of the range.
 * Days are Monday-first (ru). Endpoints render filled; the in-between span gets a blue tint.
 */

const WD = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];
function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
/** Calendar cells for a month, Monday-first; leading/trailing blanks as null. */
function monthGrid(view: Date): (number | null)[] {
  const y = view.getFullYear();
  const m = view.getMonth();
  const startWd = (new Date(y, m, 1).getDay() + 6) % 7; // 0 = Monday
  const days = new Date(y, m + 1, 0).getDate();
  const cells: (number | null)[] = Array(startWd).fill(null);
  for (let d = 1; d <= days; d++) cells.push(new Date(y, m, d).getTime());
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
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
  // Дальше текущего месяца листать некуда: будущих данных не существует (аудит).
  const atCurrentMonth =
    view.getFullYear() === new Date(todayStart).getFullYear() && view.getMonth() === new Date(todayStart).getMonth();

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

  const shiftMonth = (delta: number) => setView((v) => new Date(v.getFullYear(), v.getMonth() + delta, 1));

  const preset = (f: number, t: number) => {
    setFrom(f);
    setTo(t);
    const d = new Date(f);
    setView(new Date(d.getFullYear(), d.getMonth(), 1));
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

  // While picking the end date, preview the span up to the hovered day.
  const rangeEnd = to ?? (from != null && hover != null && hover > from ? hover : null);
  const inRange = (ts: number) => from != null && rangeEnd != null && ts > from && ts < rangeEnd;

  const cells = monthGrid(view);
  const canApply = from != null && to != null;

  return (
    <div className="w-[300px]">
      <div className="flex flex-wrap gap-1.5 pb-3">
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
      </div>

      <div className="flex items-center justify-between pb-2">
        <button
          type="button"
          onClick={() => shiftMonth(-1)}
          aria-label="Предыдущий месяц"
          className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Chevron dir="left" />
        </button>
        <div className="text-sm font-medium tabular-nums">
          {MONTHS[view.getMonth()]} {view.getFullYear()}
        </div>
        <button
          type="button"
          onClick={() => shiftMonth(1)}
          disabled={atCurrentMonth}
          aria-label="Следующий месяц"
          className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35"
        >
          <Chevron dir="right" />
        </button>
      </div>

      <div className="grid grid-cols-7 gap-0.5 pb-1 text-center text-2xs text-muted-foreground">
        {WD.map((w) => (
          <div key={w}>{w}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-0.5" onMouseLeave={() => setHover(null)}>
        {cells.map((ts, i) => {
          if (ts == null) return <div key={i} />;
          const isEdge = ts === from || ts === to;
          const isToday = ts === todayStart;
          // Будущий день не выбрать: диапазон в будущем давал пустые графики без объяснения (аудит).
          const isFuture = ts > todayStart;
          return (
            <button
              key={i}
              type="button"
              disabled={isFuture}
              aria-label={`${new Date(ts).getDate()} ${MONTHS[view.getMonth()]} ${view.getFullYear()}`}
              onClick={() => pickDay(ts)}
              onMouseEnter={() => setHover(ts)}
              className={cn(
                'flex h-8 items-center justify-center rounded text-xs tabular-nums transition-colors',
                isEdge
                  ? 'bg-primary font-medium text-primary-foreground'
                  : inRange(ts)
                    ? 'bg-accent text-foreground'
                    : 'text-foreground hover:bg-muted',
                // pointer-events-none: гасит и красный not-allowed-курсор, и hover-подсветку, и
                // mouseenter-предпросмотр диапазона на невыбираемом будущем дне.
                isFuture && 'pointer-events-none opacity-35',
                isToday && !isEdge && 'ring-1 ring-inset ring-primary/40',
              )}
            >
              {new Date(ts).getDate()}
            </button>
          );
        })}
      </div>

      <div className="mt-3 font-mono text-2xs tabular-nums text-muted-foreground">
        {from != null ? fmtDate(from) : '—'} → {to != null ? fmtDate(to) : '…'}
      </div>

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={!canApply}
          onClick={() => canApply && onApply({ from: startOfLocalDay(from), to: endOfLocalDay(to) })}
          className="btn-pill flex-1 bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          Применить
        </button>
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
