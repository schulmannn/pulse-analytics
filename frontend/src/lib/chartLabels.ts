export interface AxisLabelOptions {
  /** Minimum horizontal space reserved for one label. Prefer hiding labels over rotating them. */
  minLabelPx?: number;
  /** Hard cap so large detail views stay readable instead of becoming dense rulers. */
  maxLabels?: number;
}

const DEFAULT_MIN_LABEL_PX = 78;
const DEFAULT_MAX_LABELS = 10;

export function axisLabelBudget(width: number, options: AxisLabelOptions = {}): number {
  const minLabelPx = Math.max(1, options.minLabelPx ?? DEFAULT_MIN_LABEL_PX);
  const maxLabels = Math.max(2, options.maxLabels ?? DEFAULT_MAX_LABELS);
  const safeWidth = Number.isFinite(width) ? Math.max(width, 0) : 0;
  return Math.max(2, Math.min(maxLabels, Math.floor(safeWidth / minLabelPx)));
}

/**
 * Width-aware x-axis density for chart labels.
 *
 * Hide rules:
 * - never rotate labels; if the label belt is too narrow, show fewer ticks;
 * - always keep first and last labels for temporal orientation;
 * - avoid a final near-duplicate tick right next to the last label;
 * - expanded/detail views naturally show more labels because their measured width is larger.
 */
export function axisLabelIndexes(count: number, width: number, options: AxisLabelOptions = {}): number[] {
  if (!Number.isFinite(count) || count <= 0) return [];
  const n = Math.floor(count);
  if (n === 1) return [0];

  const budget = Math.min(n, axisLabelBudget(width, options));
  if (budget >= n) return Array.from({ length: n }, (_, i) => i);

  const stride = Math.max(1, Math.ceil((n - 1) / Math.max(budget - 1, 1)));
  const indexes: number[] = [0];
  for (let i = stride; i < n - 1; i += stride) indexes.push(i);

  const lastPlanned = indexes[indexes.length - 1];
  if (n - 1 - lastPlanned < stride * 0.6 && indexes.length > 1) indexes.pop();
  indexes.push(n - 1);
  return indexes;
}

export function axisLabelIndexSet(count: number, width: number, options: AxisLabelOptions = {}): Set<number> {
  return new Set(axisLabelIndexes(count, width, options));
}
