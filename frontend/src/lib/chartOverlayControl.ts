export interface ChartPressStart {
  x: number;
  y: number;
}

const DRAG_THRESHOLD_PX = 5;

/** Roving index for the single focusable chart overlay control. Charts clamp at their ends. */
export function nextChartControlIndex(
  key: string,
  currentIndex: number,
  count: number,
): number | null {
  if (count <= 0) return null;
  if (key === 'ArrowLeft') return Math.max(0, currentIndex - 1);
  if (key === 'ArrowRight') return Math.min(count - 1, currentIndex + 1);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}

/** One accessible-name recipe shared by line and bar drill surfaces. */
export function chartControlAriaLabel({
  index,
  label,
  fallbackNoun,
  value,
}: {
  index: number;
  label?: string;
  fallbackNoun: 'точка' | 'столбец';
  value: string;
}): string {
  return `Открыть данные: ${label ?? `${fallbackNoun} ${index + 1}`}, ${value}. Стрелки влево и вправо выбирают ${fallbackNoun}.`;
}

/**
 * Resolve the index activated by the native overlay button.
 *
 * Enter, Space and AT activation produce a click with `detail === 0`; that path must always use the
 * keyboard-selected index and must never be cancelled by coordinates left from an interrupted
 * pointer gesture. Pointer clicks retain the >5px scrub guard.
 */
export function chartActivationIndex({
  detail,
  controlIndex,
  pointerIndex,
  press,
  clientX,
  clientY,
}: {
  detail: number;
  controlIndex: number;
  pointerIndex: number | null;
  press: ChartPressStart | null;
  clientX: number;
  clientY: number;
}): number | null {
  if (detail === 0) return controlIndex;
  if (press && Math.hypot(clientX - press.x, clientY - press.y) > DRAG_THRESHOLD_PX) {
    return null;
  }
  return pointerIndex;
}

/** Invoke the chart's production activation callback only when the gesture resolves to a point. */
export function activateChartControl(
  input: Parameters<typeof chartActivationIndex>[0],
  onPointClick: (index: number) => void,
): boolean {
  const index = chartActivationIndex(input);
  if (index == null) return false;
  onPointClick(index);
  return true;
}
