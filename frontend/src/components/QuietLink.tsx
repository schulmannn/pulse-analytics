import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { isPlainLeftClick, useViewTransitionNavigate } from '@/lib/viewTransitionNavigate';

/**
 * ТИХАЯ ССЫЛКА ВНУТРИ ТЕКСТА: подпись ведёт на свою страницу, оставаясь частью фразы.
 *
 * Цвет буквы здесь НЕ задаётся — он наследуется от соседнего текста (в леджере подпись
 * приглушена, в списке фактов набрана чернилами), поэтому аффорданс несёт подчёркивание, а не
 * акцентный синий: канон «один акцент» держит синий за управляющими элементами, а не за каждым
 * словом, которое куда-то ведёт.
 *
 * Линия подчёркивания — приглушённый `currentColor`, а НЕ `--border`, как предлагал ресёрч:
 * хайрлайн рамки даёт на поверхности карточки 1.24:1 в тёмной теме и 1.29:1 в светлой, то есть
 * не виден вовсе, а невидимый аффорданс равен его отсутствию. Наследуемый цвет заодно
 * подходит обоим макетам «Недели», где текст вокруг ссылки разной светлоты.
 *
 * Переход — тот же кроссфейд View Transitions, что у `MetricBackLink` (`MetricBackLink` остаётся
 * своим компонентом: там хлебная крошка со стрелкой и подчёркивания нет вовсе). Обычный левый
 * клик перехватывается, а модификаторы и средняя кнопка уходят браузеру — «открыть в новой
 * вкладке» продолжает работать.
 */
export function QuietLink({
  to,
  children,
  className,
}: { to: string; children: ReactNode; className?: string }) {
  const vtNavigate = useViewTransitionNavigate();
  return (
    <Link
      to={to}
      onClick={(event) => {
        if (!isPlainLeftClick(event)) return;
        event.preventDefault();
        vtNavigate(to);
      }}
      className={cn(
        'rounded underline decoration-current/40 decoration-1 underline-offset-2 transition-colors hover:decoration-current focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40',
        className,
      )}
    >
      {children}
    </Link>
  );
}
