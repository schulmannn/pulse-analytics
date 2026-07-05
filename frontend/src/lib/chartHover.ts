// Cursor→sample-index math for the equal-step SVG charts (LineChart / BarChart / DivergingBars).
// The charts attach ONE mouse handler to the svg and derive the hovered index from the pointer's
// x offset, instead of tiling a transparent <rect> per data point — a 365-day series across a
// board of cards used to mean thousands of DOM nodes that existed only to catch hover.
//
// Pure and unit-tested; both functions clamp into [0, n-1] so callers can feed any pointer x
// (gutters, margins, label bands) and always get a valid index — matching the old edge-rect
// behaviour where the first/last zones extended to the chart edges.

/** Nearest sample for point-anchored series (LineChart): points sit AT origin + i*step, so the
 *  hovered index is the rounded step count — zone boundaries fall halfway between points, exactly
 *  like the old per-point rects. `n` is the series length (callers render charts only for n ≥ 1). */
export function nearestPointIndex(xView: number, n: number, origin: number, step: number): number {
  if (n <= 1) return 0;
  if (!Number.isFinite(step) || step <= 0) return 0;
  // Math.max also normalizes the -0 that Math.round yields just left of the origin.
  const i = Math.round((xView - origin) / step);
  return Math.min(n - 1, Math.max(0, i));
}

/** Column hit for column-tiled charts (BarChart / DivergingBars): column i owns
 *  [origin + i*colWidth, origin + (i+1)*colWidth). Pointer x outside the tiled band (centered
 *  bar groups have side margins) clamps to the nearest edge column. */
export function columnIndex(xView: number, n: number, origin: number, colWidth: number): number {
  if (n <= 1) return 0;
  if (!Number.isFinite(colWidth) || colWidth <= 0) return 0;
  const i = Math.floor((xView - origin) / colWidth);
  return Math.min(n - 1, Math.max(0, i));
}
