// Period-median comparison for posts — a source-neutral, deterministic primitive. The content
// table and top-post cards compare a single post against the MEDIAN of its period (not the mean:
// the median resists the one viral outlier that would otherwise make every other post look weak),
// and render an explicit "+42% к медиане" label instead of an unexplained colour. Pure + honest:
// below a minimum sample the comparison is withheld (null) rather than shown as false precision.

/** Minimum posts in a period before a "vs median" comparison is trustworthy. Below this the
 *  median is too noisy to anchor a per-post claim, so callers show an insufficient-data state. */
export const MEDIAN_MIN_SAMPLE = 5;

/** Δ smaller than this (in %) reads as "at the median" rather than a signed move. */
const FLAT_EPS_PCT = 0.5;

export type MedianDir = 'above' | 'below' | 'at';

export interface MedianComparison {
  /** Signed percent vs the period median (positive = above). */
  pct: number;
  dir: MedianDir;
  /** value / median — 1.0 means exactly at the median. */
  ratio: number;
}

/**
 * Median of a numeric sample. Non-finite entries are dropped first. Returns null for an empty
 * sample so callers never divide by an undefined baseline.
 */
export function median(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = clean.length;
  if (n === 0) return null;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (clean[mid - 1] + clean[mid]) / 2 : clean[mid];
}

/**
 * Period median of `values`, gated by MEDIAN_MIN_SAMPLE. Returns null when the sample is too
 * small (or the median is ≤0, which would make a percent comparison meaningless). This is the
 * single baseline every per-post comparison in a period is measured against.
 */
export function periodMedian(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length < MEDIAN_MIN_SAMPLE) return null;
  const m = median(clean);
  return m != null && m > 0 ? m : null;
}

/**
 * Compare one post's metric against a precomputed period median. Returns null when the median is
 * missing/≤0 or the value is not finite — the caller then shows no comparison rather than a fake
 * one. Callers pass the SAME median (from `periodMedian`) for every row so the labels are coherent.
 */
export function compareToMedian(
  value: number | null | undefined,
  periodMedianValue: number | null,
): MedianComparison | null {
  if (
    value == null
    || !Number.isFinite(value)
    || value < 0
    || periodMedianValue == null
    || periodMedianValue <= 0
  ) {
    return null;
  }
  const ratio = value / periodMedianValue;
  const pct = (ratio - 1) * 100;
  const dir: MedianDir = Math.abs(pct) < FLAT_EPS_PCT ? 'at' : pct > 0 ? 'above' : 'below';
  return { pct, dir, ratio };
}

/**
 * Human label for a median comparison — the explicit "+42% к медиане" wording Task 6 mandates so
 * colour is never the only explanation. Russian to match the rest of the UI; `atLabel` covers the
 * near-median case. Rounds to whole percent (medians are noisy; decimals imply false precision).
 */
export function medianDeltaLabel(cmp: MedianComparison): string {
  if (cmp.dir === 'at') return 'на уровне медианы';
  const sign = cmp.pct > 0 ? '+' : '−';
  return `${sign}${Math.abs(Math.round(cmp.pct))}% к медиане`;
}
