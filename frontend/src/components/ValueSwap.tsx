import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Снап-кроссфейд НЕЧИСЛОВЫХ значений: строка меняется мгновенно, обёртка мягко проявляется
 * (opacity + 2px подъём за --motion-fast) через keyed-ремаунт — смена `swapKey` перемонтирует
 * спан и проигрывает entry-анимацию. Глобальная reduced-motion сеть глушит её автоматически.
 * tabular-nums на числовых хостах уже стоит — ширина не дёргается.
 *
 * История канона: «числа снапают, не крутятся» (полировка 2026-07-28) действовало и для чисел;
 * с 2026-08-18 (решение владельца) числовые хедлайны морфятся ЦИФРАМИ через components/KpiNumber
 * (@number-flow/react) — паритет с морфом графиков. ValueSwap остаётся его фолбэком для строк,
 * которые числом не являются («—», «<0.1%», даты, минус U+2212), и для прочих текстовых свапов.
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
