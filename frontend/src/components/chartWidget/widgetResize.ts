import { SIZE_RANK } from '@/components/widgets/variants';
import type { WidgetSize } from '@/lib/widgetPrefsStore';

export const WIDGET_SIZE_ORDER: readonly WidgetSize[] = ['third', 'half', 'full'];

const GRID_COLUMNS: Record<WidgetSize, number> = {
  third: 2,
  half: 3,
  full: 6,
};

/** Pixel width of each S/M/L footprint inside the six-column widget grid. */
export function widgetSizeWidths(containerWidth: number, columnGap: number): Record<WidgetSize, number> {
  const safeGap = Math.max(0, columnGap);
  const column = Math.max(0, (containerWidth - safeGap * 5) / 6);
  const widthFor = (size: WidgetSize) => {
    const span = GRID_COLUMNS[size];
    return column * span + safeGap * (span - 1);
  };
  return {
    third: widthFor('third'),
    half: widthFor('half'),
    full: widthFor('full'),
  };
}

/** Snap a dragged corner to the nearest allowed footprint. `startSize` stays the geometry anchor
 * even while React reflows the grid after a live S/M/L change, so the handle never jumps under the
 * pointer midway through one gesture. */
export function widgetResizeTarget({
  startSize,
  minSize,
  deltaX,
  containerWidth,
  columnGap,
}: {
  startSize: WidgetSize;
  minSize: WidgetSize;
  deltaX: number;
  containerWidth: number;
  columnGap: number;
}): WidgetSize {
  const widths = widgetSizeWidths(containerWidth, columnGap);
  const desired = widths[startSize] + deltaX;
  const allowed = WIDGET_SIZE_ORDER.filter((size) => SIZE_RANK[size] >= SIZE_RANK[minSize]);
  return allowed.reduce((closest, size) =>
    Math.abs(widths[size] - desired) < Math.abs(widths[closest] - desired) ? size : closest,
  );
}

/** Keyboard equivalent of the corner drag. */
export function stepWidgetSize(current: WidgetSize, minSize: WidgetSize, direction: -1 | 1): WidgetSize {
  const allowed = WIDGET_SIZE_ORDER.filter((size) => SIZE_RANK[size] >= SIZE_RANK[minSize]);
  const index = Math.max(0, allowed.indexOf(current));
  return allowed[Math.max(0, Math.min(allowed.length - 1, index + direction))];
}
