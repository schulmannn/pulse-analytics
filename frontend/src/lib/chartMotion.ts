/**
 * Stable, DATA-derived signature for the chart data-change motion (the line/area clip sweep,
 * sparkline reveal and bar grow — see index.css «Chart motion»).
 *
 * Keyed on the SERIES CONTENT — the primary values plus the shown comparison — and NOTHING else:
 * container width, hover, tooltip position and referential identity are all deliberately absent, so
 * a ResizeObserver width change or a hover mousemove never changes it (no replay), while a period /
 * filter / compare swap does. `null` gaps serialize verbatim (a hole is real absence, and a hole
 * appearing / moving is itself a content change). A referentially-unstable-but-equal re-render (a
 * refetch producing an identical series) yields the SAME string, so the animated node keeps its React
 * key and updates geometry in place instead of remounting and replaying.
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
