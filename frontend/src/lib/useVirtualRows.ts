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

/** Первый прокручиваемый предок (overflow-y: auto|scroll); null — скроллер = окно. */
function findScrollParent(node: HTMLElement | null): HTMLElement | null {
  for (let el = node?.parentElement ?? null; el; el = el.parentElement) {
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return el;
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
  return {
    active,
    containerRef,
    items: active ? virtualizer.getVirtualItems() : [],
    totalSize: active ? virtualizer.getTotalSize() : 0,
    scrollMargin,
    measureElement: virtualizer.measureElement,
  };
}
