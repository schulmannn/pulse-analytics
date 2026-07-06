import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { fmt } from '@/lib/format';
import { ChartTooltip } from '@/components/ChartTooltip';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';

interface PieChartProps {
  values: number[];
  labels?: string[];
  /** Full tooltip lines (label + display) — falls back to `label: value`. */
  titles?: string[];
  /** Per-slice colour (an `hsl(...)` string). Missing entries cycle --chart-1..6. */
  colors?: (string | undefined)[];
  height?: number;
}

interface Hover {
  i: number;
}

// A donut, not a full pie: the hole keeps the shape legible and leaves room for a total.
const DONUT_RATIO = 0.58;
// The palette has 6 distinct chart tokens; cap coloured slices at 6 (largest by value) and fold
// the rest into a single muted «Прочее» so no two wedges ever share a hue (a pie relies on colour
// to map wedge → legend, unlike bars, so a collision there is genuinely confusing).
const MAX_COLORS = 6;
// Legend caps at 8 rows inline, «+N ещё» beyond; the overlay shows the full legend.
const LEGEND_CAP = 8;

/** Polar → cartesian on a unit circle, 12 o'clock = 0, clockwise. */
function polar(cx: number, cy: number, r: number, frac: number): [number, number] {
  const a = frac * 2 * Math.PI - Math.PI / 2;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/** One donut-segment path between two cumulative fractions. */
function arcPath(cx: number, cy: number, rOuter: number, rInner: number, from: number, to: number): string {
  // A single wedge that is the whole circle can't be drawn as one arc (start === end) —
  // draw it as two half rings.
  if (to - from >= 1) {
    const [ox1, oy1] = polar(cx, cy, rOuter, 0);
    const [ox2, oy2] = polar(cx, cy, rOuter, 0.5);
    const [ix1, iy1] = polar(cx, cy, rInner, 0);
    const [ix2, iy2] = polar(cx, cy, rInner, 0.5);
    return [
      `M ${ox1} ${oy1}`,
      `A ${rOuter} ${rOuter} 0 0 1 ${ox2} ${oy2}`,
      `A ${rOuter} ${rOuter} 0 0 1 ${ox1} ${oy1}`,
      `M ${ix1} ${iy1}`,
      `A ${rInner} ${rInner} 0 0 0 ${ix2} ${iy2}`,
      `A ${rInner} ${rInner} 0 0 0 ${ix1} ${iy1}`,
      'Z',
    ].join(' ');
  }
  const large = to - from > 0.5 ? 1 : 0;
  const [ox1, oy1] = polar(cx, cy, rOuter, from);
  const [ox2, oy2] = polar(cx, cy, rOuter, to);
  const [ix2, iy2] = polar(cx, cy, rInner, to);
  const [ix1, iy1] = polar(cx, cy, rInner, from);
  return [
    `M ${ox1} ${oy1}`,
    `A ${rOuter} ${rOuter} 0 ${large} 1 ${ox2} ${oy2}`,
    `L ${ix2} ${iy2}`,
    `A ${rInner} ${rInner} 0 ${large} 0 ${ix1} ${iy1}`,
    'Z',
  ].join(' ');
}

/**
 * SVG donut for categorical (part-of-whole) data — a круговая presentation of Breakdown-style
 * items. Mirrors BarChart: width-measured so the ring is crisp, reads ChartExpandedContext /
 * ExpandedChartHeightContext to render compact inline vs large-with-legend in the «Развернуть»
 * overlay, tokens only (works on the near-black canvas), no shadows. Slices below 2% fold into
 * «Прочее». Hover reads out label · value · %.
 */
export function PieChart({ values, labels, titles, colors, height = 200 }: PieChartProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  const [width, setWidth] = useState(600);
  const expanded = useContext(ChartExpandedContext);
  const ctxHeight = useContext(ExpandedChartHeightContext);

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

  // The readout must not linger once the chart scrolls under the sticky header or the window
  // loses focus — mouseleave alone does not fire during wheel scrolling.
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

  const positive = (values ?? []).map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = positive.reduce((s, v) => s + v, 0);

  if (!values || values.length === 0 || total <= 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Нет данных
      </div>
    );
  }

  // Keep the six largest slices (each a distinct hue: the item's own colour, else a --chart token
  // by rank), fold every remaining slice into one muted «Прочее» — collision-free by construction.
  type Slice = { label: string; value: number; color: string; title: string };
  const ranked = positive
    .map((v, i) => ({ v, i }))
    .filter((s) => s.v > 0)
    .sort((a, b) => b.v - a.v);
  const big: Slice[] = ranked.slice(0, MAX_COLORS).map((s, pos) => ({
    label: labels?.[s.i] ?? '',
    value: s.v,
    color: colors?.[s.i] ?? `hsl(var(--chart-${(pos % 6) + 1}))`,
    title: titles?.[s.i] ?? `${labels?.[s.i] ?? ''}: ${fmt.num(s.v)}`,
  }));
  const otherValue = ranked.slice(MAX_COLORS).reduce((sum, s) => sum + s.v, 0);
  const slices: Slice[] =
    otherValue > 0
      ? [...big, { label: 'Прочее', value: otherValue, color: 'hsl(var(--chart-role-neutral))', title: `Прочее: ${fmt.num(otherValue)}` }]
      : big;

  const chartHeight = ctxHeight ?? height;
  // In a FIXED tile (ctxHeight set) the donut sits LEFT and the legend RIGHT so nothing scrolls
  // off the tile (steep) — the donut is bounded by the tile height AND ~45% of the width so the
  // legend has room. Expanded keeps its big responsive layout; a free-height surface stacks
  // the donut over the legend as before.
  const compactSide = !expanded && ctxHeight != null;
  const size = compactSide
    ? Math.min(chartHeight, Math.max(width * 0.45, 1))
    : Math.min(chartHeight, Math.max(width, 1));
  const cx = size / 2;
  const cy = size / 2;
  const rOuter = size / 2 - 4;
  const rInner = rOuter * DONUT_RATIO;

  // Cumulative fractions per slice.
  let acc = 0;
  const arcs = slices.map((s) => {
    const from = acc;
    acc += s.value / total;
    return { ...s, from, to: acc, mid: (from + acc) / 2 };
  });

  const pct = (v: number) => `${((v / total) * 100).toFixed(1)}%`;
  const tipText = (i: number) => `${arcs[i]?.title ?? ''} · ${pct(arcs[i]?.value ?? 0)}`;

  // Legend: full in the overlay; in a fixed tile capped by how many rows fit the donut height so
  // the list never scrolls off NOR clips (the tile is overflow-hidden) — «следить чтобы не съезжали»;
  // else the flat 8. Row pitch matches the rendered li (py-1.5 + a text-sm value line ≈ 34px), and
  // when the list is truncated one slot is reserved for the «+N ещё» line so rows + that line still
  // fit — mirrors Breakdown.
  const LEGEND_ROW_PX = 34;
  const rowsThatFit = Math.max(2, Math.floor(size / LEGEND_ROW_PX));
  const legendCap = expanded ? arcs.length : compactSide ? rowsThatFit : LEGEND_CAP;
  const willTruncate = arcs.length > legendCap;
  const legendRows = arcs.slice(0, willTruncate ? Math.max(1, legendCap - 1) : legendCap);
  const legendExtra = arcs.length - legendRows.length;

  const containerCls = expanded
    ? 'flex flex-col items-start gap-6 sm:flex-row sm:items-center'
    : compactSide
      ? 'flex items-center gap-4'
      : '';
  const donutWidth = expanded || compactSide ? size : '100%';
  const legendCls = expanded || compactSide ? 'min-w-0 flex-1' : 'mt-4';

  return (
    <div ref={containerRef} className="relative w-full">
      <div className={containerCls}>
        <div
          className="relative shrink-0"
          style={{ width: donutWidth, maxWidth: size }}
          onMouseLeave={() => setHover(null)}
          onPointerLeave={() => setHover(null)}
        >
          <svg
            className="block w-full"
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            role="img"
            aria-label="Круговая диаграмма"
          >
            {arcs.map((a, i) => (
              <path
                key={i}
                d={arcPath(cx, cy, rOuter, rInner, a.from, a.to)}
                fill={a.color}
                stroke="hsl(var(--card))"
                strokeWidth="1.5"
                className="cursor-crosshair transition-opacity"
                opacity={hover ? (hover.i === i ? 1 : 0.55) : 0.9}
                onMouseMove={() => setHover((prev) => (prev && prev.i === i ? prev : { i }))}
              />
            ))}
            {/* Total in the hole — a quiet anchor, not a headline. */}
            <text
              x={cx}
              y={cy - 2}
              textAnchor="middle"
              className="pointer-events-none select-none fill-foreground text-sm font-medium tabular-nums"
            >
              {fmt.short(total)}
            </text>
            <text
              x={cx}
              y={cy + 14}
              textAnchor="middle"
              className="pointer-events-none select-none fill-muted-foreground text-2xs font-medium"
            >
              всего
            </text>
          </svg>
          {/* Readout anchored to the hovered slice centroid (mid-radius of the ring). */}
          <ChartTooltip
            tip={
              hover && hover.i < arcs.length
                ? {
                    ...(() => {
                      const [px, py] = polar(cx, cy, (rOuter + rInner) / 2, arcs[hover.i]!.mid);
                      return { x: px, y: py };
                    })(),
                    text: tipText(hover.i),
                  }
                : null
            }
          />
        </div>

        {/* Legend: hairline rows (colour dot + label + value·%), reusing the ValueLedger idiom.
            Inline it flows under the ring; in the overlay it sits beside it. */}
        <ul className={legendCls}>
          {legendRows.map((a, i) => (
            <li
              key={i}
              className="flex items-baseline justify-between gap-3 border-b border-border py-1.5 last:border-b-0"
              onMouseEnter={() => setHover({ i })}
              onMouseLeave={() => setHover(null)}
            >
              <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: a.color }} aria-hidden="true" />
                <span className="truncate">{a.label}</span>
              </span>
              <span className="shrink-0 text-sm font-medium tabular-nums text-foreground">
                {fmt.num(a.value)}
                <span className="ml-1.5 text-2xs font-normal text-muted-foreground">{pct(a.value)}</span>
              </span>
            </li>
          ))}
          {legendExtra > 0 && <li className="pt-1.5 text-2xs text-muted-foreground">+{legendExtra} ещё</li>}
        </ul>
      </div>
    </div>
  );
}
