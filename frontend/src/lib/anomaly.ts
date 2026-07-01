// Local-outlier detection for chart series — flags points that deviate strongly from their
// neighbours (a rolling baseline that adapts to trend, so a steadily-climbing series isn't all
// "anomalies"). Pure + client-side: no new API, runs on the values a chart already has.

export interface AnomalyOptions {
  /** Sensitivity — how many local std-devs a point must exceed to count. Higher = stricter. */
  k?: number;
  /** Neighbourhood radius on each side used for the local baseline. */
  window?: number;
}

/**
 * Return the indices of anomalous points in `values`. For each point we take its neighbours within
 * `window` on each side (excluding itself), and flag the point if it's more than `k` local
 * std-devs from that neighbourhood mean. Short series (<5) are never flagged.
 */
export function detectAnomalies(values: number[], opts: AnomalyOptions = {}): number[] {
  const n = values.length;
  if (n < 5) return [];
  const k = opts.k ?? 2.5;
  const window = opts.window ?? Math.max(3, Math.min(7, Math.floor(n / 3)));

  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(n - 1, i + window);
    const neigh: number[] = [];
    for (let j = lo; j <= hi; j++) if (j !== i) neigh.push(values[j]);
    if (neigh.length < 3) continue;
    const mean = neigh.reduce((a, b) => a + b, 0) / neigh.length;
    const variance = neigh.reduce((a, b) => a + (b - mean) ** 2, 0) / neigh.length;
    const std = Math.sqrt(variance);
    if (std <= 0) continue;
    if (Math.abs(values[i] - mean) > k * std) out.push(i);
  }
  return out;
}
