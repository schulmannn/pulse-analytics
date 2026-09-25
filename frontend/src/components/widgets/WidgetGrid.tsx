import { useRef } from 'react';
import type { ReactNode } from 'react';
import { subscribeStore } from '@/lib/widgetPrefsStore';
import { useRowFill } from './useRowFill';

/**
 * Сетка карточек БЕЗ перестановки — для поверхностей, где виджеты фиксированы (СДЭК, Метрика,
 * Rusender, МойСклад). До аудита #554 они рендерили голый `<div className="grid …">`, и правило
 * заполнения ряда, жившее внутри WidgetGroup, до них не доходило вовсе: дыра в ряду там была
 * штатным состоянием.
 *
 * Здесь нет ни драга, ни FLIP, ни скрытых виджетов — только ref и общее правило ряда, поэтому
 * поверхность не получает ни чужой моторики, ни чужих обработчиков. Классы сетки приходят с
 * места вызова как были: раскладка у каждой поверхности своя, общее у них — только запрет на
 * дыру в хвосте ряда.
 */
export function WidgetGrid({
  className,
  children,
  ...rest
}: { className?: string; children: ReactNode } & Omit<React.HTMLAttributes<HTMLDivElement>, 'className' | 'children'>) {
  const ref = useRef<HTMLDivElement>(null);
  useRowFill(ref, { subscribe: subscribeStore });
  return (
    <div ref={ref} className={className} data-widget-grid {...rest}>
      {children}
    </div>
  );
}
