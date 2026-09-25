import { createContext } from 'react';

/**
 * Контексты, которые оболочка карточки (ChartSection) и развёрнутые виды раздают графикам и
 * телам. Живут отдельным лёгким модулем: раньше они стояли в `ExpandableChart.tsx` рядом с мёртвым
 * rich-разворотом, и каждый график тянул за ними весь модуль оверлея (EXPAND-17).
 */

/** True while rendering inside an expanded view (the Tier-1 overlay, a metric page, the explorer).
    Charts opt into richer annotations there (full y-axis, value labels) without prop plumbing
    through the panels. */
export const ChartExpandedContext = createContext(false);

/** Chart height (px) requested by the expanded view; null = the caller's own height.
    Overrides the chart's `height` prop, so callers keep their compact inline sizing while
    the same element renders explorer-sized in the overlay. */
export const ExpandedChartHeightContext = createContext<number | null>(null);

/** Per-widget target level («Целевой уровень» in the edit dialog). ChartSection provides it
    around the widget body (and, via portal context flow, the expanded overlay); LineChart
    draws a dashed goal line at the value. null = no target — the default everywhere else. */
export const WidgetTargetContext = createContext<number | null>(null);

/**
 * Заголовок карточки, внутри которой рисуется тело.
 *
 * Нужен ровно затем, чтобы тело не печатало подпись-ДУБЛЬ: на IG-обзоре карточка называлась
 * «Охват», и над числом стояла вторая подпись «Охват» (аудит #554, D8). Это уже вторая серия
 * одного дефекта — до неё так же дублировались «Просмотры» (аудит 11 августа), — поэтому чинится
 * структурно: хост объявляет своё имя, тело сравнивает и не повторяет.
 */
export const ChartCardTitleContext = createContext<string | null>(null);
