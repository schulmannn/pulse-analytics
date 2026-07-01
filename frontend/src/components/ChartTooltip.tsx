export type TooltipState = { x: number; y: number; text: string } | null;

/** Floating tooltip for the SVG charts — positioned above the cursor, inside a
    `relative` chart container. Shows instantly on hover (vs. the slow native
    SVG <title>). Uses popover tokens so it works in light and dark themes. */
export function ChartTooltip({ tip }: { tip: TooltipState }) {
  if (!tip) return null;
  return (
    <div
      className="pointer-events-none absolute z-20 max-w-[240px] -translate-x-1/2 -translate-y-full rounded border bg-popover px-2.5 py-1.5 text-xs font-medium leading-snug text-popover-foreground"
      style={{ left: tip.x, top: tip.y - 10 }}
    >
      {tip.text}
    </div>
  );
}
