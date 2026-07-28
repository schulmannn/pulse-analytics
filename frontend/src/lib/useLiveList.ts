import autoAnimate from '@formkit/auto-animate';
import { useEffect, useRef } from 'react';

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

// Числа, не var(): WAAPI-опции не читают CSS-переменные. Зеркала --motion-base/--ease-standard —
// при смене токенов в index.css обновить и здесь (единственное место).
const LIVE_LIST_DURATION_MS = 240;
const LIVE_LIST_EASING = 'cubic-bezier(0.2, 0.7, 0.3, 1)';

export function useLiveList<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const controller = autoAnimate(el, { duration: LIVE_LIST_DURATION_MS, easing: LIVE_LIST_EASING });
    return () => controller.disable();
  }, []);
  return ref;
}
