import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { fmt } from '@/lib/format';
import { ChartTooltip, type TooltipRow, type TooltipState } from '@/components/ChartTooltip';
import { axisLabel, niceScale } from '@/components/LineChart';
import { ChartExpandedContext, ExpandedChartHeightContext, WidgetTargetContext } from '@/components/ExpandableChart';

interface BarChartProps {
  values: number[];
  labels?: string[];
  titles?: string[];
  height?: number;
  /** Comparison series (previous period / baseline), drawn as a dashed --chart-2 overlay
      line across the bar tops, with a legend row — the visual delta for bar charts. */
  ghost?: number[];
  /** Legend name for the ghost series (default «Прошлый период»). */
  ghostLabel?: string;
  /** When set, bars become clickable (a drilldown gesture): the per-column hit area fires this
      with the column index and shows a pointer cursor. Hover behaviour is unchanged. */
  onPointClick?: (index: number) => void;
  /** Whether the comparison legend chip is an interactive show/hide toggle (default). Pass false
      where a page-level compare control already owns the on/off (the metric page). */
  legendToggle?: boolean;
}

interface Hover {
  i: number;
}

// Bars never grow wider than this — sparse series (n=2) must not render giant slabs.
const MAX_BAR_W = 48;
// Bar takes 70% of its column; the rest is gap.
const BAR_RATIO = 0.7;
// Approximate glyph width of the 11px tabular numerals used for tick/value labels.
const CHAR_W = 6.6;

export function BarChart({ values, labels, titles, height = 200, ghost, ghostLabel = 'Прошлый период', onPointClick, legendToggle = true }: BarChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  // The comparison overlay can be toggled off via its legend chip (steep #9) — hidden, it also
  // drops out of the bar y-domain so the bars rescale to the current series.
  const [ghostHidden, setGhostHidden] = useState(false);
  // A freshly-enabled or changed comparison always starts SHOWN: reset the manual hide when the
  // ghost's content changes, keyed on a content signature (not identity) so a referentially-
  // unstable-but-equal re-render never resets it (which would make the chip un-clickable).
  const ghostKey = ghost && ghost.length >= 2 ? ghost.join(',') : '';
  const prevGhostKey = useRef(ghostKey);
  useEffect(() => {
    if (ghostKey === prevGhostKey.current) return;
    prevGhostKey.current = ghostKey;
    if (ghostKey) setGhostHidden(false);
  }, [ghostKey]);
  // Measure render width so the viewBox is 1:1 with CSS pixels — a fixed 600-wide viewBox
  // scaled to fit would render labels/bars at inconsistent, fuzzy sizes.
  const [width, setWidth] = useState(600);
  // Expanded (modal) rendering opts into value labels + y ticks.
  const expanded = useContext(ChartExpandedContext);
  // The overlay dictates its explorer height; inline renders keep the caller's `height`.
  const ctxHeight = useContext(ExpandedChartHeightContext);
  // Per-widget goal line — same source LineChart reads, so the target survives the
  // line↔bar variant switch. null everywhere outside a widget with a set target.
  const targetCtx = useContext(WidgetTargetContext);
  const target = targetCtx != null && Number.isFinite(targetCtx) ? targetCtx : null;

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth || 600);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The readout must not linger once the chart scrolls under the sticky header or the
  // window loses focus — mouseleave alone does not fire during wheel scrolling.
  const hasHover = hover !== null;
  useEffect(() => {
    if (!hasHover) return;
    const clear = () => setHover(null);
    window.addEventListener('scroll', clear, true);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('blur', clear);
    };
  }, [hasHover]);

  if (!values || values.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Нет данных
      </div>
    );
  }

  const hasGhost = !!ghost && ghost.length === values.length && ghost.length >= 2;
  // Toggled off, the comparison drops out of every draw/measure below; the legend chip stays
  // visible so it can be toggled back on.
  const showGhost = hasGhost && !ghostHidden;
  // Expanded view: bars scale against a NICE domain top (1/2/5×10ⁿ) so the y ticks land on
  // round values, like LineChart — the old max/mid pair printed «262» next to «2.5k».
  // The domain also covers the target and the (shown) comparison line — both must stay visible.
  const rawMax = Math.max(...values, 1, target ?? 0, ...(showGhost ? ghost! : []));
  const scale = expanded ? niceScale(0, rawMax) : null;
  const max = scale ? scale.hi : rawMax;
  const n = values.length;
  const chartWidth = Math.max(width, 1);
  const chartHeight = ctxHeight ?? height;
  const paddingBottom = labels && labels.length > 0 ? 24 : 0;
  const graphHeight = chartHeight - paddingBottom;
  // Expanded view: headroom for the value labels above full-height bars.
  const padTop = expanded ? 18 : 0;
  const usable = Math.max(graphHeight - padTop, 1);

  // Expanded view: nice-tick labels right-aligned in a reserved left gutter (0 = baseline).
  const yTicks = scale ? scale.ticks.filter((t) => t > 0) : [];
  const tickLabels = yTicks.map((v) => axisLabel(v, scale ? scale.step : 1));
  const gutterW = expanded
    ? Math.max(28, Math.round(Math.max(...tickLabels.map((l) => l.length)) * CHAR_W) + 14)
    : 0;

  // Cap the column width and center the group when there are few bars.
  const plotW = Math.max(chartWidth - gutterW, 10);
  const itemWidth = Math.min(plotW / n, MAX_BAR_W / BAR_RATIO);
  const barWidth = itemWidth * BAR_RATIO;
  const offsetX = gutterW + (plotW - itemWidth * n) / 2;
  // Thin x-labels on narrow widths so dense series (e.g. 14 days) don't overlap.
  const labelStride = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(chartWidth / 56))));

  const barTop = (val: number) => graphHeight - (val / max) * usable;
  const barCenterX = (i: number) => offsetX + i * itemWidth + itemWidth / 2;
  // Comparison overlay: a dashed line across the previous-period value at each bar centre.
  const ghostPath = showGhost
    ? ghost!.map((v, i) => `${i === 0 ? 'M' : 'L'} ${barCenterX(i)} ${barTop(v)}`).join(' ')
    : '';
  const tipText = (i: number) => {
    const base = titles?.[i] ?? `${labels?.[i] ?? ''}: ${values[i]}`;
    return showGhost && ghost![i] != null ? `${base} · пред. ${fmt.short(ghost![i])}` : base;
  };
  // Structured readout (label · Текущий · comparison · Δ) when a ghost series is present; else the
  // metric's own title text. Anchored to the hovered bar's top-centre.
  const buildTip = (i: number): TooltipState => {
    const x = barCenterX(i);
    const y = barTop(values[i]);
    if (showGhost && ghost![i] != null) {
      const cur = values[i];
      const prev = ghost![i];
      const rows: TooltipRow[] = [
        { label: 'Текущий', value: fmt.short(cur), color: 'hsl(var(--brand-iris))' },
        { label: ghostLabel, value: fmt.short(prev), color: 'hsl(var(--chart-2))' },
      ];
      const d = prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : null;
      if (d != null && Number.isFinite(d)) rows.push({ label: 'Δ', value: `${d >= 0 ? '+' : '−'}${Math.abs(d).toFixed(1)}%` });
      return { x, y, title: labels?.[i], rows };
    }
    return { x, y, text: tipText(i) };
  };
  const onEnter = (i: number) => () => {
    setHover((prev) => (prev && prev.i === i ? prev : { i }));
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full"
      onMouseLeave={() => setHover(null)}
      onPointerLeave={() => setHover(null)}
    >
      <svg className="block w-full" height={chartHeight} viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none">
        {/* Expanded: y gridlines with tick labels in the gutter */}
        {yTicks.map((v, idx) => {
          const y = barTop(v);
          return (
            <g key={`t${idx}`}>
              <line x1={gutterW} y1={y} x2={chartWidth} y2={y} stroke="hsl(var(--border))" strokeDasharray="4 6" strokeWidth="1" opacity="0.6" />
              <text x={gutterW - 8} y={y + 3.5} textAnchor="end" className="pointer-events-none select-none fill-muted-foreground text-2xs font-medium tabular-nums">
                {tickLabels[idx]}
              </text>
            </g>
          );
        })}

        {values.map((val, i) => {
          const barHeight = (val / max) * usable;
          const x = offsetX + i * itemWidth + (itemWidth - barWidth) / 2;
          const y = graphHeight - barHeight;
          const strideHit = i === 0 || i === n - 1 || i % labelStride === 0;
          const showLabel = labels?.[i] && strideHit;
          const showValue = expanded && strideHit;

          return (
            <g key={i}>
              {/* Flat single-token fill; hovered bar reads slightly stronger */}
              <rect
                x={x}
                y={y}
                width={barWidth}
                height={Math.max(barHeight, 2)}
                fill="hsl(var(--brand-iris))"
                rx={2}
                className="pointer-events-none transition-opacity"
                opacity={hover ? (hover.i === i ? 1 : 0.55) : 0.85}
              />
              {showValue && (
                <text
                  x={x + barWidth / 2}
                  y={y - 4}
                  textAnchor="middle"
                  className="pointer-events-none select-none fill-ink2 text-2xs font-medium tabular-nums"
                >
                  {fmt.short(val)}
                </text>
              )}
              {showLabel && (
                <text
                  x={x + barWidth / 2}
                  y={chartHeight - 6}
                  textAnchor="middle"
                  className="pointer-events-none select-none fill-muted-foreground text-2xs font-medium"
                >
                  {labels?.[i]}
                </text>
              )}
              {/* Wide transparent hit-area: hover anywhere over the column (also the drill click
                  target when onPointClick is set). */}
              <rect
                x={offsetX + i * itemWidth}
                y={0}
                width={itemWidth}
                height={graphHeight}
                fill="transparent"
                className={onPointClick ? 'cursor-pointer' : 'cursor-crosshair'}
                onMouseMove={onEnter(i)}
                onClick={onPointClick ? () => onPointClick(i) : undefined}
              />
            </g>
          );
        })}

        {/* Comparison overlay — dashed --chart-2 line across the previous-period values, plus
            hollow dots at each point so the delta reads at a glance (steep). */}
        {showGhost && (
          <g className="pointer-events-none">
            <path d={ghostPath} fill="none" stroke="hsl(var(--chart-2))" strokeWidth="1.8" strokeDasharray="5 4" opacity="0.9" />
            {ghost!.map((v, i) => (
              <circle key={`g${i}`} cx={barCenterX(i)} cy={barTop(v)} r="2.5" fill="hsl(var(--card))" stroke="hsl(var(--chart-2))" strokeWidth="1.5" />
            ))}
          </g>
        )}

        {/* Target level (widget pref) — dashed goal line + right-aligned label, above the bars */}
        {target != null && (
          <>
            <line x1={gutterW} y1={barTop(target)} x2={chartWidth} y2={barTop(target)} stroke="hsl(var(--muted-foreground))" strokeDasharray="6 4" strokeWidth="1.2" opacity="0.8" className="pointer-events-none" />
            <text
              x={chartWidth - 4}
              y={barTop(target) - 4 < 10 ? barTop(target) + 12 : barTop(target) - 4}
              textAnchor="end"
              className="pointer-events-none select-none fill-muted-foreground text-2xs font-medium tabular-nums"
            >
              цель {fmt.short(target)}
            </text>
          </>
        )}

        {/* Hovered-column crosshair + the comparison point on it (parity with LineChart). */}
        {hover && hover.i < n && (
          <g className="pointer-events-none">
            <line x1={barCenterX(hover.i)} y1={0} x2={barCenterX(hover.i)} y2={graphHeight} stroke="hsl(var(--brand-iris))" strokeWidth="1" opacity="0.3" vectorEffect="non-scaling-stroke" />
            {showGhost && ghost![hover.i] != null && (
              <circle cx={barCenterX(hover.i)} cy={barTop(ghost![hover.i])} r="3.5" fill="hsl(var(--card))" stroke="hsl(var(--chart-2))" strokeWidth="1.5" />
            )}
          </g>
        )}
      </svg>
      {/* Comparison legend — names both series whenever a ghost is present; the comparison chip is a
          toggle (steep #9): click to hide/show the overlay. Where a page-level compare control already
          owns the on/off (legendToggle=false, the metric page) the chip is a static label instead. */}
      {hasGhost && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 px-1 text-2xs font-medium text-muted-foreground">
          <span className="flex select-none items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-3 rounded-sm" style={{ backgroundColor: 'hsl(var(--brand-iris))' }} />
            Текущий период
          </span>
          {legendToggle ? (
            <button
              type="button"
              aria-pressed={!ghostHidden}
              onClick={() => setGhostHidden((v) => !v)}
              title={ghostHidden ? 'Показать сравнение' : 'Скрыть сравнение'}
              className={`flex select-none items-center gap-1.5 rounded transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${ghostHidden ? 'opacity-40 line-through' : ''}`}
            >
              <span aria-hidden="true" className="w-4 border-t-2 border-dashed" style={{ borderColor: 'hsl(var(--chart-2))' }} />
              {ghostLabel}
            </button>
          ) : (
            <span className="flex select-none items-center gap-1.5">
              <span aria-hidden="true" className="w-4 border-t-2 border-dashed" style={{ borderColor: 'hsl(var(--chart-2))' }} />
              {ghostLabel}
            </span>
          )}
        </div>
      )}
      {/* Readout anchored to the hovered bar's top-center (not the cursor) */}
      <ChartTooltip tip={hover && hover.i < n ? buildTip(hover.i) : null} />
    </div>
  );
}
