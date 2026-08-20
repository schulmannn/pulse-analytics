import { useContext } from 'react';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { EmptyState } from '@/components/EmptyState';
import { displayWithShare } from '@/lib/breakdownShare';

interface BreakdownItem {
  label: string;
  value: number;
  display?: string;
  color?: string; // optional HSL color for the bar fill + a leading dot
  /** Доля от полной суммы разбивки (0..1) — печатается как «значение · 54.3%». Проставляется на
      слое данных ДО среза топ-N (см. lib/breakdownShare); части целого получают её, средние и
      коэффициенты — нет. */
  share?: number;
}

interface BreakdownProps {
  items: BreakdownItem[];
  /** Сколько пикселей тела тайла уже занято соседом (переключателем метрики над списком). Без
      этого разбивка считает высоту по ВСЕМУ телу и рисует на строку больше, чем влезает —
      лишняя обрезается нижней кромкой. */
  reserve?: number;
}

// One row's vertical pitch: p-2 row (36px) + space-y-2 gap.
const ROW_GAP = 8;
const ROW_PITCH = 44;
/** Высота строки «+N ещё» (text-2xs). Она НЕ строка списка: раньше под неё резервировалась целая
    строка в 44px, и разбивка с переключателем показывала два источника из четырёх вместо трёх. */
const HINT_H = 15;

export function Breakdown({ items, reserve = 0 }: BreakdownProps) {
  // Inside a fixed-height tile the card feeds its body height here — show only the rows that
  // FIT plus a «+N ещё» line, so a widget never scrolls (steep). The expand overlay
  // (ChartExpandedContext) and free-height surfaces keep the full list.
  const expanded = useContext(ChartExpandedContext);
  const ctxHeight = useContext(ExpandedChartHeightContext);

  if (!items || items.length === 0) {
    return <EmptyState compact size="chart" title="Нет данных" />;
  }

  // Внутри фикс-тайла строки ДЕЛЯТ высоту тела поровну, а не жмутся к верхней кромке: у разбивки
  // из трёх строк (например «Тональность реакций») нижняя треть карточки пустовала, тогда как
  // соседние разбивки из четырёх строк заполняли тайл. Потолок строки (max-h-14) не даёт двум
  // строкам разъехаться в толстые полосы. Оверлей «Развернуть» и страничные поверхности живут
  // свободной высотой — там прежний естественный ритм.
  const fillSlot = !expanded && ctxHeight != null;
  const avail = ctxHeight != null ? ctxHeight - reserve : null;
  // Сколько строк влезает БЕЗ подсказки (n строк занимают n*pitch − gap) и сколько С подсказкой.
  const fitAll = !expanded && avail != null ? Math.max(2, Math.floor((avail + ROW_GAP) / ROW_PITCH)) : items.length;
  const fitWithHint = avail != null ? Math.max(1, Math.floor((avail - HINT_H) / ROW_PITCH)) : items.length;
  const shown = items.length > fitAll ? items.slice(0, fitWithHint) : items;
  const extra = items.length - shown.length;

  const maxValue = Math.max(...items.map((item) => item.value), 1);

  return (
    <div className={fillSlot ? 'flex h-full flex-col gap-2' : 'space-y-2'}>
      {shown.map((item, i) => {
        const percentage = (item.value / maxValue) * 100;
        // Fill alpha is a theme token (--row-tint-*): the light-theme 0.15 pastel turns muddy
        // olive-brown on the dark canvas, so dark ships lower alphas; the coloured dot next to
        // the label stays the category signal in both themes.
        const bgStyle = item.color
          ? { backgroundColor: item.color, opacity: 'var(--row-tint-colored, 0.15)' }
          : { backgroundColor: 'hsl(var(--chart-role-primary))', opacity: 'var(--row-tint-neutral, 0.08)' };

        return (
          <div
            key={i}
            className={`relative flex items-center justify-between overflow-hidden rounded p-2${
              fillSlot ? ' min-h-9 max-h-12 flex-1' : ''
            }`}
          >
            <div
              className="absolute bottom-0 left-0 top-0 rounded-sm transition-[width] dur-base ease-house"
              style={{ width: `${percentage}%`, ...bgStyle }}
            />
            <span className="relative z-10 flex max-w-[65%] items-center gap-1.5 truncate text-sm font-medium text-foreground">
              {item.color && (
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: item.color }}
                  aria-hidden="true"
                />
              )}
              <span className="truncate">{item.label}</span>
            </span>
            <span className="relative z-10 ml-2 shrink-0 text-sm tabular-nums text-muted-foreground">
              {displayWithShare(String(item.display ?? item.value), item.share)}
            </span>
          </div>
        );
      })}
      {extra > 0 && (
        <div className="shrink-0 px-2 text-2xs text-muted-foreground">+{extra} ещё — полный список в «Развернуть»</div>
      )}
    </div>
  );
}
