import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { observeSize } from '@/lib/observeSize';
import { ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { cn } from '@/lib/utils';

/**
 * Полоса под график внутри карточки, у которой СВЕРХУ есть ещё что-то (хедлайн, дельта, подпись).
 *
 * Карточка публикует в {@link ExpandedChartHeightContext} высоту ВСЕГО своего тела, и график,
 * читающий контекст напрямую, рисует себя на эту высоту — под хедлайном он уже не помещается,
 * тайл получает внутренний скроллбар (канон плотности запрещает; e2e «no inner scrollbars»).
 * Искра этого не замечала — она тянется CSS'ом (`h-full`), — а столбцы берут высоту числом,
 * поэтому проблема вскрылась, когда столбцы стали дефолтом дискретных метрик.
 *
 * Band измеряет СОБСТВЕННУЮ высоту (`min-h-0` + `overflow-hidden` позволяют ужаться ниже
 * контента, иначе svg распирал бы полосу и измерение зациклилось бы на своём же результате) и
 * переопределяет контекст для поддерева графика — ровно тот приём, которым WidgetRenderer уже
 * разводит хедлайн и плот у конфигурируемых виджетов.
 */
export function ChartBand({ className, children }: { className?: string; children: ReactNode }) {
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
    <div ref={ref} className={cn('min-h-0 w-full flex-1 overflow-hidden', className)}>
      <ExpandedChartHeightContext.Provider value={height}>
        {children}
      </ExpandedChartHeightContext.Provider>
    </div>
  );
}
