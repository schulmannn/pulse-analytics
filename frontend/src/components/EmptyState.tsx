import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { EmptyGhostShape, type EmptyGhost } from '@/components/EmptyGhost';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

/**
 * Reserve a coherent footprint so an in-card empty/error occupies the same band a loaded chart or
 * table row group would — no jump when data resolves, no cramped one-liner. `chart` matches the
 * axis-free card plot band; `table` matches a few dense rows. Shared with {@link ErrorState}.
 */
export type DataStateSize = 'chart' | 'table';
// tile-short: в тесном фикс-тайле резерв-футпринт отпускается (контент и так центрируется в
// слоте через h-full) — иначе min-h + py + многострочный reason превышали 264px-слот (прод-класс
// багов «состояние не влезло в тайл»; см. container-запросы `tile` в index.css).
export const dataStateSizeClass: Record<DataStateSize, string> = {
  chart: 'min-h-40 tile-short:min-h-0',
  table: 'min-h-32 tile-short:min-h-0',
};

interface EmptyStateProps {
  /** One-line heading naming the empty space (e.g. "Публикаций пока нет"). */
  title: string;
  /** Optional second line explaining why / what unlocks it. */
  reason?: ReactNode;
  /** Optional single call-to-action link. */
  action?: { to: string; label: string };
  /** Show the shared muted icon tile above the heading (default on; pass false for cramped rows). */
  glyph?: boolean;
  /** In-card variant: small icon + heading (+ optional reason), no nested surface. */
  compact?: boolean;
  /** Reserve a chart-plot / table-rows footprint (compact only) instead of re-typing height classes. */
  size?: DataStateSize;
  /**
   * Силуэт того графика, который карточка нарисует, когда данные появятся ({@link EmptyGhostShape}).
   * Необязателен намеренно: 150+ существующих вызовов не должны получить форму, которой у них нет,
   * а откат сводится к снятию пропа в одном примитиве.
   */
  ghost?: EmptyGhost;
  className?: string;
}

/**
 * Product wrapper around the shadcn Empty primitive. Page-level states get one quiet, solid surface;
 * compact states drop that surface because their card/table already supplies the chrome.
 */
export function EmptyState({ title, reason, action, glyph = true, compact = false, size, ghost, className }: EmptyStateProps) {
  // Полоса таблицы обещает СТРОКИ, чем бы ни попросил вызывающий: линия над пустой таблицей
  // обещала бы график, которого на этой поверхности не будет.
  const shape = ghost && size === 'table' ? 'rows' : ghost;
  return (
    <Empty
      className={cn(
        compact
          ? 'h-full min-h-24 gap-2 rounded-none border-0 bg-transparent px-3 py-4 md:p-4 tile-short:min-h-0 tile-short:h-auto tile-short:flex-1 tile-short:gap-0.5 tile-short:py-1.5'
          : 'min-h-52 gap-4 border border-solid border-border/70 bg-muted/20 px-6 py-10 md:p-10 tile-short:flex-1 tile-short:min-h-0 tile-short:gap-1 tile-short:rounded-none tile-short:border-0 tile-short:bg-transparent tile-short:px-3 tile-short:py-2',
        size && dataStateSizeClass[size],
        className,
      )}
    >
      {/* Силуэт в ПОТОКЕ и ТОЛЬКО НА РОСТ (`flex-1` без нижнего порога), а не абсолютом поверх
          полосы. Две причины, обе замерены.
          1) Контраст: muted-текст держит на светлой карточке 5.48, а поверх заливки призрака
             проваливается до 3.90 — ниже AA 4.5. Абсолютный призрак пришлось бы разводить с
             текстом на глазок и заново на каждом длинном reason; флекс-элемент делает пересечение
             невозможным по построению — текст всегда ПОД полосой.
          2) Высота: `flex-grow` раздаёт только СВОБОДНОЕ место, поэтому силуэт физически не может
             сделать карточку выше — в тесном слоте он просто схлопывается в ноль. Контейнерный
             запрос `tile-short:` для этого не годится: тело фикс-тайла 264px — это 181px, то есть
             tile-short матчится в КАЖДОЙ карточке доски, и призрака не осталось бы нигде. */}
      {shape && compact ? (
        <EmptyGhostShape
          kind={shape}
          className={
            shape === 'ring'
              ? // Кольцо в фикс-тайле PieChart живёт слева сверху (донат слева, легенда справа).
                'w-10 max-h-10 flex-1 self-start'
              : 'w-full max-h-24 flex-1'
          }
        />
      ) : null}
      <EmptyHeader className={cn(compact ? 'gap-1.5' : 'gap-2', 'tile-short:gap-0.5')}>
        {shape && !compact ? (
          // Страничное состояние: форма И ЕСТЬ значок. Значок Inbox над силуэтом — две иконографии
          // в одном столбце, читаются как две разные системы.
          <EmptyGhostShape kind={shape} className={cn('mb-1', shape === 'ring' ? 'size-12' : 'h-12 w-40')} />
        ) : glyph && !shape ? (
          <EmptyMedia
            variant="icon"
            className={cn(
              'mb-1 rounded-full bg-muted text-muted-foreground',
              compact ? 'size-8 [&_svg]:size-4' : 'size-10 [&_svg]:size-5',
              'tile-short:mb-0 tile-short:size-6 tile-short:[&_svg]:size-3.5',
            )}
          >
            <Inbox aria-hidden="true" />
          </EmptyMedia>
        ) : null}
        <EmptyTitle
          className={cn(
            'text-sm tracking-normal',
            reason ? 'font-medium text-foreground' : 'font-normal text-muted-foreground',
          )}
        >
          {title}
        </EmptyTitle>
        {reason ? (
          <EmptyDescription
            className={cn(
              'max-w-sm',
              compact && 'max-w-xs text-xs/relaxed',
              'tile-short:max-w-xs tile-short:text-2xs tile-short:leading-tight tile-short:line-clamp-2',
            )}
          >
            {reason}
          </EmptyDescription>
        ) : null}
      </EmptyHeader>
      {action ? (
        <EmptyContent className={cn(compact ? 'gap-2' : 'gap-3', 'tile-short:gap-0.5')}>
          <Button asChild size="sm" variant={compact ? 'outline' : 'default'}>
            <Link to={action.to}>{action.label}</Link>
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
