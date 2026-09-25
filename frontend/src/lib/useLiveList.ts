import autoAnimate from '@formkit/auto-animate';
import { useCallback, useEffect, useRef } from 'react';
import { parseCssDurationMs } from '@/lib/chartMotionRuntime';

/**
 * «Живой список» (волна C; ресёрч 2026-07-28): add/remove/move прямых детей контейнера
 * анимируются автоматически через @formkit/auto-animate (~2-3KB, WAAPI). Единственная
 * санкционированная обёртка — параметры прибиты к токен-лестнице: duration = --motion-base
 * (240мс), easing = house-кривая. prefers-reduced-motion библиотека уважает сама
 * (задокументировано: отключается полностью).
 *
 * ПРАВИЛО из ресёрча: auto-animate — для reorder/insert/remove ЖИВЫХ списков (строки таблиц
 * упоминаний/кампаний при сортировке и фильтрах, приход fresh-элементов); mount/unmount
 * одиночных элементов — обычные CSS-переходы. НЕ вешать на home-грид виджетов: там свои
 * widget-rise/home-remove keyframes и FLIP-реордер — будет двойная анимация.
 *
 * Для таблиц ref вешается на <tbody> (дети-строки). Грабля: удаляемый элемент клонируется
 * в absolute-позицию на время exit — hairline-бордеры строк при этом не мигают, потому что
 * divide-y живёт на родителе, а не на клоне.
 */

export function useLiveList<T extends HTMLElement>() {
  const controllerRef = useRef<ReturnType<typeof autoAnimate> | null>(null);
  // Callback ref, not a one-shot effect: loading/empty branches often mount the real tbody/ul only
  // after data arrives. Attaching at that commit keeps those live lists animated too.
  const ref = useCallback((el: T | null) => {
    controllerRef.current?.disable();
    controllerRef.current = null;
    if (!el) return;
    // WAAPI-опции не читают var() — токены СЧИТЫВАЮТСЯ из computed-стиля (канон readMorphMs):
    // один источник правды в index.css, никаких зеркал-литералов.
    const styles = getComputedStyle(document.documentElement);
    const duration = parseCssDurationMs(styles.getPropertyValue('--motion-base')) ?? 240;
    const easing = styles.getPropertyValue('--ease-standard').trim();
    controllerRef.current = autoAnimate(el, easing ? { duration, easing } : { duration });
  }, []);
  useEffect(() => () => controllerRef.current?.disable(), []);
  return ref;
}
