import { useSyncExternalStore } from 'react';

/**
 * Свёрнута ли правая колонка страницы метрики.
 *
 * Владелец: «сделай кнопку toggle чтобы скрыть все фильтры и прочее при открытии графика в полном
 * экране, также как сделано у Steep». Замер их страницы: кнопка «Toggle sidebar» 32×32 у правого
 * края шапки, панель уходит ИЗ ПОТОКА (не прячется прозрачностью), полотно занимает её место.
 *
 * Состояние — свойство РАБОЧЕГО МЕСТА, а не метрики: свернув колонку на выручке, человек хочет
 * видеть широкое полотно и на заказах. Поэтому один ключ на все страницы метрик, а не по одному
 * на метрику — и он переживает перезагрузку, иначе полноэкранный режим пришлось бы включать
 * заново на каждом заходе.
 */
const KEY = 'pulse_metric_rail_hidden';

let hidden: boolean | null = null;
const listeners = new Set<() => void>();

export function isMetricRailHidden(): boolean {
  if (hidden == null) {
    try {
      hidden = localStorage.getItem(KEY) === '1';
    } catch {
      hidden = false;
    }
  }
  return hidden;
}

export function setMetricRailHidden(next: boolean): void {
  if (isMetricRailHidden() === next) return;
  hidden = next;
  try {
    if (next) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* хранилище недоступно — выбор живёт до перезагрузки */
  }
  for (const listener of listeners) listener();
}

export function useMetricRailHidden(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isMetricRailHidden,
    () => false,
  );
}
