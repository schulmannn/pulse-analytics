import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Снап-кроссфейд числа (канон: «числа снапают, не крутятся» — исследование полировки 2026-07-28).
 * Значение меняется МГНОВЕННО (никакого тикера/каунт-апа), но обёртка мягко проявляется
 * (opacity + 2px подъём за --motion-fast) через keyed-ремаунт: смена `swapKey` перемонтирует
 * спан и проигрывает entry-анимацию. Глобальная reduced-motion сеть глушит её автоматически.
 * tabular-nums на числовых хостах уже стоит — ширина не дёргается.
 */
export function ValueSwap({
  swapKey,
  children,
  className,
}: {
  /** Сигнатура значения — обычно сама отформатированная строка. */
  swapKey: string | number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span key={swapKey} className={cn('value-swap inline-block', className)}>
      {children}
    </span>
  );
}
