import { useLayoutEffect, useRef, useState } from 'react';

/** One line of a structured readout: a label (with an optional series-colour dot) and a value. */
export type TooltipRow = { label: string; value: string; color?: string };
/** Either a plain `text` readout (legacy callers) or a structured `title` + `rows` card (series
 *  charts showing current vs comparison). `rows` wins when present. */
export type TooltipState =
  | { x: number; y: number; text?: string; title?: string; rows?: TooltipRow[] }
  | null;

/** Floating readout for the SVG charts — anchored to a point inside a `relative` chart
    container. Placed above the anchor and flipped below when it would clip the container's
    top edge; clamped horizontally to the container bounds. It never escapes the chart
    upward, and its z-10 keeps it under the sticky app header (z-sticky+), so it can't cover
    the page chrome. Shows instantly on hover (vs. the slow native SVG <title>). */
export function ChartTooltip({ tip }: { tip: TooltipState }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0, cw: 0 });

  // Re-measure after every render: the text (and thus the box) changes per hovered point,
  // and the offsetParent is the chart container whose width we clamp against.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const cw = (el.offsetParent as HTMLElement | null)?.clientWidth ?? 0;
    setBox((prev) => (prev.w === w && prev.h === h && prev.cw === cw ? prev : { w, h, cw }));
  });

  if (!tip) return null;

  const gap = 10;
  const measured = box.w > 0 && box.h > 0;
  const half = box.w / 2;
  // Clamp the horizontal center so the tooltip stays inside the chart container.
  const cx =
    measured && box.cw > 0
      ? Math.min(Math.max(tip.x, half + 2), Math.max(box.cw - half - 2, half + 2))
      : tip.x;
  // Above the anchor by default; flip below when clipped by the container's top edge.
  const fitsAbove = tip.y - gap - box.h >= 0;
  const top = fitsAbove ? tip.y - gap - box.h : tip.y + gap;

  return (
    <div
      ref={ref}
      data-chart-tooltip
      className="pointer-events-none absolute z-10 max-w-[240px] rounded border border-border bg-background/95 px-2.5 py-1.5 text-xs font-medium leading-snug text-foreground"
      style={{ left: cx - half, top: Math.max(top, 0), visibility: measured ? 'visible' : 'hidden' }}
    >
      {tip.rows ? (
        <>
          {tip.title && <div className="mb-1 whitespace-nowrap text-2xs tracking-wide text-muted-foreground">{tip.title}</div>}
          <div className="space-y-0.5">
            {tip.rows.map((r, i) => (
              <div key={i} className="flex items-center justify-between gap-4 whitespace-nowrap">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  {r.color && <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: r.color }} />}
                  {r.label}
                </span>
                <span className="tabular-nums text-foreground">{r.value}</span>
              </div>
            ))}
          </div>
        </>
      ) : (
        tip.text
      )}
    </div>
  );
}
