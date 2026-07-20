import { useEffect, useLayoutEffect, useRef, useState } from 'react';

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
export function ChartTooltip({ tip, appearance = 'default' }: { tip: TooltipState; appearance?: 'default' | 'rhea' | 'comparison' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0, cw: 0 });
  // The tooltip fades in on mount and GLIDES between points via the shared [data-chart-tooltip]
  // transform transition (index.css). But the very first (measured) frame moves the box by half its
  // width as the clamp resolves from an unmeasured origin — with the transition live that would read
  // as an unwanted slide-in. So the glide is armed one frame AFTER the tooltip appears: the first
  // placement snaps (transition suppressed inline), every subsequent point-to-point move glides.
  const hasTip = tip !== null;
  const [glide, setGlide] = useState(false);
  useEffect(() => {
    if (!hasTip) {
      setGlide(false);
      return;
    }
    const id = requestAnimationFrame(() => setGlide(true));
    return () => cancelAnimationFrame(id);
  }, [hasTip]);

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

  const compact = appearance !== 'default';

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

  // ⚠️ Позиция ТОЛЬКО через transform + ширина w-max (не left/top): у absolute-элемента
  // shrink-to-fit ширина зависит от `left` (доступное место до правого края контейнера), а left
  // здесь сам вычисляется из измеренной ширины (cx − half). Эта взаимозависимость у края при
  // неудачной длине строк не сходится — текст перескакивает между двумя переносами, layout-effect
  // ставит box заново, и React падает с #185 «Maximum update depth exceeded» (прод-краши w-1-4jty
  // donut «Вовлечённость по формату» и home-velocity — общий тултип всех графиков). transform не
  // участвует в layout, w-max фиксирует ширину от контента → измерение сходится за один проход.
  return (
    <div
      ref={ref}
      data-chart-tooltip
      data-chart-tooltip-appearance={appearance}
      className={`pointer-events-none absolute left-0 top-0 z-10 w-max border bg-popover/98 px-3 py-2.5 text-xs font-medium leading-snug text-popover-foreground backdrop-blur-sm ${
        compact
          ? 'min-w-[148px] max-w-[220px] rounded-xl border-foreground/10 shadow-[0_10px_30px_rgba(0,0,0,0.14)] dark:border-white/10 dark:shadow-[0_14px_36px_rgba(0,0,0,0.4)]'
          : 'min-w-[176px] max-w-[240px] rounded-md border-border shadow-[0_12px_32px_rgba(0,0,0,0.22)] dark:border-white/10 dark:shadow-[0_14px_36px_rgba(0,0,0,0.48)]'
      }`}
      style={{ transform: `translate(${cx - half}px, ${Math.max(top, 0)}px)`, visibility: measured ? 'visible' : 'hidden', transition: glide ? undefined : 'none' }}
    >
      {tip.rows ? (
        <>
          {tip.title && <div data-chart-tooltip-title className="mb-2 whitespace-nowrap text-xs font-semibold text-foreground">{tip.title}</div>}
          <div className="space-y-1">
            {tip.rows.map((r, i) => (
              <div key={i} data-chart-tooltip-row className="flex items-center justify-between gap-4 whitespace-nowrap">
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  {r.color && (
                    <span
                      aria-hidden="true"
                      className={compact ? 'h-2.5 w-2.5 shrink-0 rounded-[3px]' : 'h-1.5 w-1.5 shrink-0 rounded-full'}
                      style={{ backgroundColor: r.color }}
                    />
                  )}
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
