/**
 * Общее «окно пропуска» задержки для подсказок — поверх ОТДЕЛЬНЫХ Radix-провайдеров.
 *
 * Канон: первая подсказка ждёт, соседние открываются мгновенно, пока пользователь сканирует ряд
 * ⓘ. У Radix это `skipDelayDuration`, но он ограничен ближайшим `Tooltip.Provider`, а каждая
 * `InfoTooltip` монтирует свой — то есть каждая сидит в группе из одной себя и заново платит
 * задержку. Очевидная починка (один провайдер в корне защищённого дерева) была ЗАМЕРЕНА и
 * отвергнута: `@radix-ui/react-tooltip` уезжает в статическое замыкание КАЖДОГО защищённого
 * маршрута, +2.5KB gzip на каждый, четыре бюджета сразу. Здесь та же семантика за ноль байт.
 *
 * Почему store с явным уведомлением, а не «посмотреть на часы при рендере»: значение, посчитанное
 * из `performance.now()` в момент рендера, к моменту наведения уже протухшее — компонент не
 * перерисовывается сам от того, что время идёт. Поэтому ОБА перехода (окно открылось, окно
 * закрылось по таймеру) толкают подписчиков явно, и `delayDuration` всегда соответствует правде.
 */

/** Задержка первой подсказки. */
export const TOOLTIP_DELAY_MS = 120;
/** Сколько после закрытия соседние открываются без задержки. */
export const TOOLTIP_SKIP_MS = 300;

let skipActive = false;
let skipTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

/** Подсказка закрылась — открыть окно, в котором соседние показываются мгновенно. */
export function openTooltipSkipWindow(): void {
  skipActive = true;
  if (skipTimer) clearTimeout(skipTimer);
  skipTimer = setTimeout(() => {
    skipActive = false;
    skipTimer = null;
    emit();
  }, TOOLTIP_SKIP_MS);
  emit();
}

export function subscribeTooltipSkip(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isTooltipSkipActive(): boolean {
  return skipActive;
}

/** Задержка открытия для текущего состояния окна. */
export function tooltipDelayFor(skip: boolean): number {
  return skip ? 0 : TOOLTIP_DELAY_MS;
}

/** Только для тестов: вернуть модуль в исходное состояние между кейсами. */
export function resetTooltipSkipForTest(): void {
  if (skipTimer) clearTimeout(skipTimer);
  skipTimer = null;
  skipActive = false;
  listeners.clear();
}
