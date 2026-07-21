/**
 * Stable, DATA-derived signature for chart data-change motion (line/area point morph,
 * sparkline reveal and bar grow — see index.css «Chart motion»).
 *
 * Keyed on the SERIES CONTENT — the primary values plus the shown comparison — and NOTHING else:
 * container width, hover, tooltip position and referential identity are all deliberately absent, so
 * a ResizeObserver width change or a hover mousemove never changes it (no replay), while a period /
 * filter / compare swap does. `null` gaps serialize verbatim (a hole is real absence, and a hole
 * appearing / moving is itself a content change). A referentially-unstable-but-equal re-render (a
 * refetch producing an identical series) yields the SAME string, so the data layer keeps its current
 * geometry instead of restarting the morph.
 */
export function seriesMotionKey(
  values: ReadonlyArray<number | null> | null | undefined,
  comparison?: ReadonlyArray<number | null> | null,
): string {
  const primary = values ?? [];
  // `join` renders each `null` as an empty field — the same serialization the charts used inline,
  // so a null-day is distinguishable from a 0-day (`,,` vs `,0,`).
  return `${primary.length}|${primary.join(',')}|${comparison?.join(',') ?? ''}`;
}
