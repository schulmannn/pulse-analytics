// Прогрессивная загрузка Главной: конфиг-карточка ниже вьюпорта не запускает свои data-запросы,
// пока не приблизится к экрану. ChartSection (только для homeKey-карточек) вешает один
// IntersectionObserver на section и оборачивает ТЕЛО карточки в Provider со значением «видима /
// приближается»; useWidgetData читает его и гейтит `enabled` своих запросов, не меняя queryKey.
// Default = true, поэтому все НЕ-Home поверхности (страницы, превью, эксплорер) и expand-оверлей
// (он рендерится ВНЕ Provider'а) фетчат как раньше. Значение одноразовое: увидели карточку —
// true навсегда, обратно в false не откатывается.
import { createContext, useContext } from 'react';

export const WidgetInViewContext = createContext(true);

/** true, когда карточка видима/приближается к вьюпорту — или поверхность вовсе не гейтится. */
export function useWidgetInView(): boolean {
  return useContext(WidgetInViewContext);
}
