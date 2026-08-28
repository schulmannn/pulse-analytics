import { useContext, useMemo, useRef, useState } from 'react';
import { ChartExpandedContext } from '@/components/ExpandableChart';
import { smoothSvgPath } from '@/lib/format';

/**
 * Мультисерийный линейный график — ОДИН на продукт.
 *
 * Вырос из приватного MsMultiLine внутри панели МойСклада: когда разбивку понадобилось дать и
 * СДЭКу, выбор был между вторым таким же графиком и вынесением этого. Второй разошёлся бы с
 * первым через пару правок — ровно та болезнь, которую в этом репо уже лечили у чисел, размеров и
 * разбора канала.
 *
 * Развязан от метрик МойСклада тремя пропами вместо зашитой логики: `format` (валюту знает
 * вызывающий), `bridgeGaps` (соединять ли разрывы) и `ariaLabel`. Всё остальное — геометрия,
 * ховер, читалка, моторика — общее.
 */
export function MultiLineChart({
  series,
  labels,
  height,
  format,
  legend,
  axisLabels,
  bridgeGaps = false,
  ariaLabel,
}: {
  series: { name: string; color: string; values: (number | null)[] }[];
  labels: string[];
  height: number;
  /** Число величины — валюта, штуки, проценты знает вызывающий, не график. */
  format: (n: number | null | undefined) => string;
  /** Хвост легенды: чем меряем и оговорки («только периоды с заказами», «ещё N не показаны»). */
  legend?: string;
  /** Каноническая ось времени (timeAxisFromDayKeys): буквы дней на коротком окне, месяцы на длинном. */
  axisLabels?: string[];
  /** Соединять разрывы: у среднего чека null значит «в этот день заказов не было», а не пропуск
   *  измерения, и рвать по нему линию было бы неправдой. Для счётных величин разрыв честен. */
  bridgeGaps?: boolean;
  ariaLabel: string;
}) {
  const expanded = useContext(ChartExpandedContext);
  const plotRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const n = labels.length;
  // Геометрия серий (max, экранные координаты, сегменты полилиний) от ховера не зависит — мемо по
  // данным, иначе каждый pointermove-рендер пересобирал бы до 6×CHART_MAX_POINTS точек заново.
  const geometry = useMemo(() => {
    const nums = series.flatMap((s) => s.values).filter((v): v is number => v != null);
    const max = nums.length ? Math.max(...nums, 0) : 1;
    const x = (i: number) => (n <= 1 ? 0 : (i / (n - 1)) * 100);
    const y = (v: number) => (max <= 0 ? 100 : 100 - (v / max) * 100);
    // Для среднего чека null означает не пропуск сбора, а отсутствие определённого значения в период
    // без заказов. Соединяем реальные наблюдения, сохраняя их календарные X-позиции; tooltip на пустом
    // периоде по-прежнему показывает «—». Для остальных метрик настоящий null остаётся разрывом.
    type Pt = { x: number; y: number };
    const segmentsOf = (values: (number | null)[]): { lines: string[]; lone: Pt[] } => {
      if (bridgeGaps) {
        const observed = values.flatMap((v, i) => (v == null ? [] : [{ x: x(i), y: y(v) }]));
        if (observed.length >= 2) {
          return { lines: [smoothSvgPath(observed, 2)], lone: [] };
        }
        return { lines: [], lone: observed };
      }
      const lines: string[] = [];
      const lone: Pt[] = [];
      let cur: Pt[] = [];
      const flush = () => {
        if (cur.length >= 2) lines.push(smoothSvgPath(cur, 2));
        else if (cur.length === 1) lone.push(cur[0]);
        cur = [];
      };
      values.forEach((v, i) => {
        if (v == null) flush();
        else cur.push({ x: x(i), y: y(v) });
      });
      flush();
      return { lines, lone };
    };
    return { max, x, segments: series.map((s) => segmentsOf(s.values)) };
  }, [series, n, bridgeGaps]);
  const { max, x } = geometry;
  const hoverAt = (clientX: number) => {
    const rect = plotRef.current?.getBoundingClientRect();
    if (!rect || n === 0) return;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(rect.width, 1)));
    setHovered(Math.round(ratio * Math.max(n - 1, 0)));
  };
  // Буквенная ось короткого окна метит КАЖДУЮ точку — буквы узкие и не сталкиваются, и только
  // полный ряд даёт ритм недели (канон одиночного графика). Даты остаются тройкой «первая,
  // середина, последняя»: больше в ширину не влезает без наложения.
  const letterAxis = axisLabels?.length === n && axisLabels.every((t) => t.length <= 2);
  const axisIndexes = letterAxis
    ? labels.map((_, i) => i)
    : [...new Set([0, Math.floor((n - 1) / 2), n - 1])].filter((i) => i >= 0);
  const hoverX = hovered == null ? null : x(hovered);
  // Stable data signature for the reveal (see index.css «Chart motion») — the up-to-6 series fade in
  // when the metric/period/selection changes, never on hover (separate state) or a container resize.
  const motionKey = series.map((s) => s.values.join(',')).join('|');
  const ariaSummary = `${ariaLabel}: ${series.map((item) => item.name).join(', ')}`;
  const activeIndex = n > 0 ? Math.max(0, Math.min(n - 1, hovered ?? n - 1)) : 0;
  const ariaValueText = n > 0
    ? `${labels[activeIndex]}. ${series
        .map((item) => `${item.name}: ${format(item.values[activeIndex])}`)
        .join('; ')}`
    : 'Нет данных';
  // ОСЬ И ЛЕГЕНДА — ПО ТОМУ ЖЕ КАНОНУ, что у одиночного ряда. Раньше этот график жил мимо обоих
  // правил: подписи оси брались из `labels` (даты) вместо канонической оси, а легенда рядов стояла
  // ПОД полотном. Из-за этого один клик по разбивке на семидневном окне переписывал язык оси
  // (буквы дней → даты) и переставлял легенду сверху вниз — человек решал, что смотрит на другой
  // график.
  const axisText = (index: number) => (axisLabels?.[index] ?? labels[index] ?? '');
  return (
    <div>
      <div className="mb-1.5 flex flex-wrap gap-x-4 gap-y-1">
        {series.map((s) => (
          <span key={s.name} className="inline-flex items-center gap-1.5 text-2xs text-muted-foreground">
            <span aria-hidden="true" className="h-1.5 w-3 rounded-full" style={{ backgroundColor: s.color }} />
            <span className="max-w-40 truncate">{s.name}</span>
          </span>
        ))}
        {legend && <span className="text-2xs text-muted-foreground">· {legend}</span>}
      </div>
      <div className={expanded ? 'relative pl-12' : undefined}>
        {expanded && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 w-11 text-right text-2xs text-muted-foreground">
            <span className="absolute right-2 top-0 -translate-y-1/2">{format(max)}</span>
            <span className="absolute right-2 top-1/2 -translate-y-1/2">{format(max / 2)}</span>
            <span className="absolute bottom-0 right-2 translate-y-1/2">{format(0)}</span>
          </div>
        )}
        <div
          ref={plotRef}
          role="slider"
          aria-label={ariaSummary}
          aria-orientation="horizontal"
          aria-valuemin={0}
          aria-valuemax={Math.max(n - 1, 0)}
          aria-valuenow={activeIndex}
          aria-valuetext={ariaValueText}
          tabIndex={0}
          className="relative rounded-sm outline-hidden focus-visible:ring-2 focus-visible:ring-primary/60"
          onPointerMove={(event) => hoverAt(event.clientX)}
          onPointerLeave={() => {
            if (!focused) setHovered(null);
          }}
          onFocus={() => {
            setFocused(true);
            setHovered((current) => current ?? Math.max(n - 1, 0));
          }}
          onBlur={() => {
            setFocused(false);
            setHovered(null);
          }}
          onKeyDown={(event) => {
            if (
              event.key !== 'ArrowLeft' &&
              event.key !== 'ArrowRight' &&
              event.key !== 'Home' &&
              event.key !== 'End'
            ) return;
            event.preventDefault();
            if (event.key === 'Home') {
              setHovered(0);
              return;
            }
            if (event.key === 'End') {
              setHovered(Math.max(n - 1, 0));
              return;
            }
            const step = event.key === 'ArrowLeft' ? -1 : 1;
            setHovered((current) => Math.max(0, Math.min(n - 1, (current ?? n - 1) + step)));
          }}
        >
          {expanded && (
            <div aria-hidden="true" className="pointer-events-none absolute inset-0">
              {[0, 50, 100].map((top) => (
                <span key={top} className="absolute left-0 right-0 border-t border-dashed border-border/50" style={{ top: `${top}%` }} />
              ))}
            </div>
          )}
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="relative w-full" style={{ height }} aria-hidden="true" data-chart-curve="smooth">
            {/* Series lines fade-reveal on a data change; the keyed group keeps the hover guide below
                it out of the motion so scrubbing never re-reveals the chart. */}
            <g key={motionKey} data-chart-motion="reveal">
              {series.map((s, si) => {
                const { lines, lone } = geometry.segments[si];
                return (
                  <g key={s.name}>
                    {lines.map((path, si) => (
                      <path
                        key={`l${si}`}
                        d={path}
                        fill="none"
                        stroke={s.color}
                        strokeWidth="1.5"
                        vectorEffect="non-scaling-stroke"
                        strokeLinejoin="round"
                        strokeLinecap="round"
                      />
                    ))}
                    {lone.map((p, pi) => (
                      <circle key={`p${pi}`} cx={p.x} cy={p.y} r="1.4" fill={s.color} />
                    ))}
                  </g>
                );
              })}
            </g>
            {hoverX != null && (
              <line x1={hoverX} x2={hoverX} y1="0" y2="100" stroke="hsl(var(--foreground) / 0.35)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
            )}
          </svg>
          {hovered != null && (
            <div
              className={`pointer-events-none absolute top-2 z-tooltip min-w-44 rounded-lg border border-border bg-popover/95 px-2.5 py-2 text-2xs shadow-lg backdrop-blur-xs ${hovered > n * 0.62 ? '-translate-x-full' : ''}`}
              style={{ left: `${hoverX ?? 0}%` }}
            >
              <p className="mb-1 font-medium text-foreground">{labels[hovered]}</p>
              {series.map((item) => (
                <p key={item.name} className="flex items-center justify-between gap-3 text-muted-foreground">
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: item.color }} />
                    <span className="max-w-32 truncate">{item.name}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-foreground">{format(item.values[hovered])}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      </div>
      {axisIndexes.length > 1 && (
        <div className={`mt-1 flex justify-between text-2xs text-muted-foreground ${expanded ? 'ml-12' : ''}`} aria-hidden="true">
          {axisIndexes.map((index) => <span key={index}>{axisText(index)}</span>)}
        </div>
      )}
    </div>
  );
}
