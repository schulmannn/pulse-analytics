/**
 * Легенда серий сравнения — ОДИН компонент на полотно графика и на рейл «Сравнение».
 *
 * До этого легенда жила только над полотном, а рейл печатал «прошлый период — 9.9k» строкой
 * классов на месте: две подачи одной сущности, и ни одна из них не называла ДАТЫ окон. Читатель
 * видел «Пред. период» и не знал, какой именно период с каким сравнивается (референс Square:
 * легенда отвечает на «что с чем» одним взглядом — маркер, диапазон дат, значение).
 *
 * МОДУЛЬ ИМПОРТИРУЕТ ТОЛЬКО React — как соседний comparisonDelta и по той же причине: его тянет
 * LineChart/BarChart, то есть чанк КАЖДОЙ вертикали. Импорт из `metric/shared` притащил бы туда
 * роутер и весь каркас страницы метрики, а `cn` — tailwind-merge; бюджетный гейт ловил ровно это
 * (маршрут «TG обзор» перебирал потолок на 92 байта). Поэтому здесь шаблонные строки классов
 * вместо cn(), а цвет свотча столбцов приходит пропом (его альфа объявлена в BarChart, откуда её
 * читает scripts/contrast-tokens.mjs — переносить константу сюда значит сломать тот гейт).
 */
import type { ReactNode } from 'react';

/** Цвет пунктира/свотча сравнения по умолчанию — тот же токен, которым нарисован призрак линии. */
const COMPARISON_INK = 'hsl(var(--chart-role-comparison))';
const PRIMARY_INK = 'hsl(var(--chart-role-primary))';

export interface SeriesLegendItem {
  role: 'primary' | 'comparison';
  /** «Текущий период» / «Пред. период» / «Год назад» — дословно как в легенде графика. */
  label: string;
  /** Диапазон окна («29 мая – 4 июн.») — печатается только в rail-layout. */
  dates?: string;
  /** Итог окна, уже отформатированный (fmt.*) — печатается только в rail-layout. */
  value?: string;
  /** Сравнение выключено страницей: место за чипом остаётся, текст невидим (chart-layout). */
  hidden?: boolean;
}

/** Маркер серии. Форма повторяет ЯЗЫК ПОЛОТНА: линия рисует сплошной штрих и пунктир, столбцы —
    два свотча (квадрат-заливка у линии врал бы про несуществующую area прошлого периода).
    `none` — для рейлов, где сравнение живёт ТОЛЬКО в колонке: у воронки, разрезов и таблиц второй
    серии на полотне нет, и штрих обещал бы линию, которой не существует. */
function Marker({
  // `series`, а не `role`: `role` в JSX-атрибуте biome читает как ARIA-роль и валит a11y-правило,
  // хотя это обычный проп. Поле `role` у SeriesLegendItem при этом остаётся — там оно не атрибут.
  series,
  marker,
  comparisonColor,
}: {
  series: 'primary' | 'comparison';
  marker: 'line' | 'bar' | 'none';
  comparisonColor: string;
}): ReactNode {
  if (marker === 'none') return null;
  if (marker === 'bar') {
    return (
      <span
        aria-hidden="true"
        className="h-2 w-3 rounded-sm"
        style={{ backgroundColor: series === 'primary' ? PRIMARY_INK : comparisonColor }}
      />
    );
  }
  return series === 'primary' ? (
    <span aria-hidden="true" className="h-0.5 w-4 rounded-full" style={{ backgroundColor: PRIMARY_INK }} />
  ) : (
    <span aria-hidden="true" className="w-4 border-t-2 border-dashed" style={{ borderColor: comparisonColor }} />
  );
}

export function SeriesLegend({
  items,
  layout,
  marker = 'line',
  comparisonColor = COMPARISON_INK,
  onToggleComparison,
  comparisonPressed = true,
}: {
  items: SeriesLegendItem[];
  layout: 'chart' | 'rail';
  /** Форма маркера = вид полотна, рядом с которым стоит легенда. */
  marker?: 'line' | 'bar' | 'none';
  /** Столбцы рисуют призрак приглушённой альфой — свотч обязан повторить ИМЕННО её. */
  comparisonColor?: string;
  /** chart-layout: чип сравнения — кнопка show/hide (LineChart/BarChart legendToggle). */
  onToggleComparison?: () => void;
  comparisonPressed?: boolean;
}) {
  if (layout === 'rail') {
    return (
      <div data-series-legend="rail" className="space-y-2">
        {items.map((item) => (
          <div
            key={item.role}
            data-series-role={item.role}
            className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-2"
          >
            {/* Коробка высотой в строку: у флекса без текста базовая линия — его нижний край,
                поэтому маркер садится на базовую линию подписи, а не под неё. */}
            <span className="flex h-4 items-center">
              <Marker series={item.role} marker={marker} comparisonColor={comparisonColor} />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs text-muted-foreground">{item.label}</span>
              {item.dates && (
                <span data-series-dates="" className="block text-2xs tabular-nums text-muted-foreground">
                  {item.dates}
                </span>
              )}
            </span>
            <span className="text-sm font-medium tabular-nums text-foreground">{item.value}</span>
          </div>
        ))}
      </div>
    );
  }
  // chart-layout — РАЗМЕТКА ДОСЛОВНО ТА, что стояла в LineChart/BarChart до переноса (её равенство
  // до/после сторожит LineChart.legend.test.tsx): у этой строки выверены отступ до полотна и
  // поведение при выключенном сравнении, и «заодно причесать» её здесь нельзя.
  return (
    <div className="mb-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-2xs font-medium text-muted-foreground">
      {items.map((item) =>
        item.role === 'primary' ? (
          <span key={item.role} className="flex select-none items-center gap-1.5">
            <Marker series="primary" marker={marker} comparisonColor={comparisonColor} />
            {item.label}
          </span>
        ) : onToggleComparison ? (
          <button
            key={item.role}
            type="button"
            aria-pressed={comparisonPressed}
            onClick={onToggleComparison}
            title={comparisonPressed ? 'Скрыть сравнение' : 'Показать сравнение'}
            className={`flex select-none items-center gap-1.5 rounded transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40 ${comparisonPressed ? '' : 'opacity-40 line-through'}`}
          >
            <Marker series="comparison" marker={marker} comparisonColor={comparisonColor} />
            {item.label}
          </button>
        ) : (
          // Выключенное сравнение НЕ уносит чип из потока: место остаётся за ним, иначе строка
          // легенды пропадает целиком и всё, что под графиком, дёргается вверх. Но и утверждать
          // «пред. период» он не должен — поэтому становится невидим, а не приглушён.
          <span
            key={item.role}
            className={`flex select-none items-center gap-1.5${item.hidden ? ' invisible' : ''}`}
            aria-hidden={!!item.hidden}
          >
            <Marker series="comparison" marker={marker} comparisonColor={comparisonColor} />
            {item.label}
          </span>
        ),
      )}
    </div>
  );
}
