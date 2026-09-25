import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Микро-морф двух иконок состояния (волна кнопочной моторики, 2026-08-18; референс — Amicro,
 * взята МЕХАНИКА, не зависимость): иконка А перетекает в Б кроссфейдом с лёгким сжатием по
 * домашней кривой на такте dur-fast. Чисто CSS — без motion/framer.
 *
 * Смысловой гейт канона: морф — только там, где смена иконки НЕСЁТ СОСТОЯНИЕ (скопировано,
 * выгружено), не декоративный ховер-фокус. Reduced motion — правило Button: цветовую половину
 * (opacity) оставляем, transform убираем (motion-reduce:scale-100); глобальный 0.01ms-кап
 * делает и фейд мгновенным.
 *
 * Иконки кладутся слоями в обёртку фиксированного размера (по умолчанию size-4 — такт
 * [&_svg]:size-4 общего Button); размер иконок задаёт вызывающий, чтобы не воевать
 * специфичностью с кнопочным селектором.
 */
export function IconMorph({
  active,
  a,
  b,
  className,
}: {
  /** false → видна иконка A, true → B (морфом). */
  active: boolean;
  a: ReactNode;
  b: ReactNode;
  className?: string;
}) {
  // Слои — grid-stack (обе иконки в одной ячейке), НЕ absolute: юнит-гвоздь Snippet пинит
  // «в разметке копи-плашки нет absolute» (кнопка не имеет права лежать поверх длинного
  // значения), и грид держит стопку без позиционирования вовсе.
  const layer =
    'col-start-1 row-start-1 inline-flex items-center justify-center transition-[opacity,transform] dur-fast ease-house';
  return (
    <span aria-hidden="true" className={cn('inline-grid size-4 shrink-0 place-items-center', className)}>
      <span className={cn(layer, active ? 'scale-50 opacity-0 motion-reduce:scale-100' : 'scale-100 opacity-100')}>
        {a}
      </span>
      <span className={cn(layer, active ? 'scale-100 opacity-100' : 'scale-50 opacity-0 motion-reduce:scale-100')}>
        {b}
      </span>
    </span>
  );
}

/**
 * Транзиентное состояние успеха для IconMorph (Copy→Check, Download→Check): `flash()` включает
 * `active` на durationMs и сам гасит. Повторный вызов перезаводит таймер; размонтирование чистит.
 */
export function useMorphFlash(durationMs = 1800): [boolean, () => void] {
  const [active, setActive] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );
  const flash = useCallback(() => {
    setActive(true);
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setActive(false), durationMs);
  }, [durationMs]);
  return [active, flash];
}
