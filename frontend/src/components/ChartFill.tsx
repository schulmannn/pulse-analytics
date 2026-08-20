import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { observeSize } from '@/lib/observeSize';

/**
 * Слот графика внутри карточки, где над ним или под ним есть что-то ещё — подпись величины,
 * легенда, строка вывода.
 *
 * Зачем: график берёт высоту из {@link ExpandedChartHeightContext} — это высота ВСЕГО тела тайла.
 * Если рядом с ним в теле лежит подпись, график всё равно рисует себя во всю высоту, и карточка
 * переполняется ровно на высоту подписи (гейт «нет внутренних скроллов» ловил так «По дням недели»
 * на +23px). Слот меряет СВОЙ бокс и публикует его как высоту графика, поэтому подпись занимает
 * своё, а график — честный остаток.
 *
 * Ставить внутрь флекс-колонки во всю высоту тела; сам слот забирает остаток (`flex-1 min-h-0`).
 */
export function ChartFill({ children, className = '' }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setHeight(el.clientHeight || null);
    measure();
    return observeSize(el, measure);
  }, []);

  return (
    <div ref={ref} className={`min-h-0 flex-1 ${className}`}>
      <ExpandedChartHeightContext.Provider value={height}>{children}</ExpandedChartHeightContext.Provider>
    </div>
  );
}
