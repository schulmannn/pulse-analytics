import { cn } from '@/lib/utils';

/**
 * ЕДИНЫЙ канон индетерминантной загрузки (исследование полировки 2026-07-28, паттерн Uiverse,
 * переписанный на токены): hairline-БАР для операций «в полный рост» (поллинг агента, долгие
 * job'ы) и три СТАГГЕР-ТОЧКИ для инлайн-ожиданий (кнопки, ячейки, стриминг). Никаких спиннеров,
 * градиентов и glow. Keyframes — в index.css («Loader canon»), длительности/изинг токенные,
 * reduced-motion гасится глобальной сетью: остаётся статичная приглушённая форма.
 */

/** Тонкая полоса с бегающим сегментом. Растягивается на ширину контейнера. Полоса обычно стоит
    ОДНА (без соседнего текста состояния) — поэтому несёт role="status". */
export function LoaderBar({ className, label }: { className?: string; label?: string }) {
  return (
    <div
      role="status"
      aria-label={label ?? 'Загрузка'}
      className={cn('loader-bar relative h-0.5 w-full overflow-hidden rounded-full bg-border/60', className)}
    />
  );
}

/** Три точки с каскадным пульсом — инлайн-рост, наследует currentColor.
    ДЕКОРАТИВНЫ (aria-hidden, ревью): точки всегда стоят рядом с носителем смысла — текстом
    («Ждём агента…», «Ассистент думает…») или aria-label кнопки. role="status" на каждом инстансе
    плодил live-регионы на каждый tool-чип и двойные анонсы; статус доносит сосед, не точки. */
export function LoaderDots({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn('loader-dots inline-flex items-center gap-1', className)}>
      <span className="size-1 rounded-full bg-current" />
      <span className="size-1 rounded-full bg-current" />
      <span className="size-1 rounded-full bg-current" />
    </span>
  );
}
