import { useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer, type VirtualItem, type Virtualizer } from '@tanstack/react-virtual';

/**
 * Виртуализация длинных списков/таблиц (@tanstack/react-virtual ~5KB; решение владельца
 * 2026-07-29 «давай виртуализацию»). Desktop-контент скроллится ВНУТРЕННИМ контейнером
 * `[data-dashboard-scroll]` (DashboardLayout), а не окном — поэтому element-виртуализатор,
 * scroll-родитель ищется автоматически вверх по дереву (первый overflow-y: auto|scroll).
 * На mobile скроллер — окно, scroll-родителя нет → active=false, классический рендер:
 * мобильное поведение канонически не трогаем.
 *
 * ПОРОГ: ниже VIRTUALIZE_FROM строк рендер тоже классический — демо/e2e-объёмы, auto-animate
 * живых списков и nth-адресация спеков виртуализацию не замечают. Это не анимация —
 * reduced-motion не касается.
 */
export const VIRTUALIZE_FROM = 120;

/**
 * Вертикальный скроллер для контейнера; null — скроллер = окно (mobile) → виртуализация спит.
 * Сначала канонический [data-dashboard-scroll] (единственный вертикальный скроллер desktop-шелла;
 * на mobile его overflow-y = visible → отвергается), затем универсальный обход вверх. ГРАБЛЯ
 * обхода: по CSS-коэрции осей `overflow-x: auto` даёт computed overflow-y 'auto' — так
 * горизонтальная обёртка .data-table-scroll прикидывается вертикальным скроллером. Поэтому
 * кандидат обязан РЕАЛЬНО переполняться вертикально; вызов идёт из layout-эффекта после
 * классического рендера ≥120 строк, когда настоящий скроллер заведомо переполнен, а
 * контент-высотные обёртки — нет (запас 40px покрывает высоту горизонтального скроллбара).
 */
function findScrollParent(node: HTMLElement | null): HTMLElement | null {
  const isVerticalScroller = (el: HTMLElement): boolean => {
    const overflowY = getComputedStyle(el).overflowY;
    return (overflowY === 'auto' || overflowY === 'scroll') && el.scrollHeight - el.clientHeight > 40;
  };
  const canonical = node?.closest('[data-dashboard-scroll]');
  if (canonical instanceof HTMLElement && isVerticalScroller(canonical)) return canonical;
  for (let el = node?.parentElement ?? null; el; el = el.parentElement) {
    if (isVerticalScroller(el)) return el;
  }
  return null;
}

export interface VirtualRows<T extends HTMLElement> {
  /** Виртуализация активна (count ≥ порога и найден scroll-родитель) — рендерить окно items. */
  active: boolean;
  /** Реф контейнера строк (ul / tbody): от него ищется scroll-родитель и меряется scrollMargin. */
  containerRef: React.RefObject<T | null>;
  items: VirtualItem[];
  totalSize: number;
  /** Смещение контейнера от начала scroll-контента — вычитается из item.start при позиционировании. */
  scrollMargin: number;
  /**
   * Высоты строк-РАСПОРОК до и после окна. Для таблицы это единственный корректный способ
   * виртуализации: `<tr>` обязан остаться `table-row`, иначе он выпадает из колоночной модели
   * таблицы. Абсолютное позиционирование строки требует `display: table` на `<tr>` — и тогда
   * КАЖДАЯ строка становится собственной таблицей со своими ширинами: шапка держит реальные
   * колонки, а ячейки строк схлопываются (владелец на живых данных СДЭКа — заказы наезжали друг
   * на друга). Распорки этого не делают: строки остаются строками одной таблицы.
   */
  padTop: number;
  padBottom: number;
  measureElement: Virtualizer<HTMLElement, Element>['measureElement'];
}

export function useVirtualRows<T extends HTMLElement>({
  count,
  estimateSize,
  overscan = 10,
}: {
  count: number;
  /** Оценка высоты строки в px; точная высота добирается measureElement-ом. */
  estimateSize: number;
  overscan?: number;
}): VirtualRows<T> {
  const containerRef = useRef<T | null>(null);
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  const wantVirtual = count >= VIRTUALIZE_FROM;

  // Поиск scroll-родителя — после маунта контейнера (и только когда порог вообще достигнут).
  useLayoutEffect(() => {
    setScrollEl(wantVirtual ? findScrollParent(containerRef.current) : null);
  }, [wantVirtual]);

  const active = wantVirtual && scrollEl != null;
  // Позиция контейнера в scroll-контенте: rect-разница + scrollTop — инвариант при прокрутке.
  // Считается на каждый рендер (дёшево; рендеры при скролле и так идут от виртуализатора).
  const scrollMargin =
    active && containerRef.current
      ? containerRef.current.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top + scrollEl.scrollTop
      : 0;

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollEl,
    estimateSize: () => estimateSize,
    overscan,
    // Хук вызывается безусловно (rules of hooks); без scroll-родителя виртуализатор спит.
    enabled: active,
    scrollMargin,
  });
  const items = active ? virtualizer.getVirtualItems() : [];
  const totalSize = active ? virtualizer.getTotalSize() : 0;
  const first = items[0];
  const last = items[items.length - 1];
  return {
    active,
    containerRef,
    items,
    totalSize,
    scrollMargin,
    padTop: first ? Math.max(0, first.start - scrollMargin) : 0,
    padBottom: last ? Math.max(0, totalSize - (last.end - scrollMargin)) : 0,
    measureElement: virtualizer.measureElement,
  };
}
