import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Cartograph } from '@/components/Cartograph';
import { Button } from '@/components/ui/button';

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
  /** The «terra incognita» cartograph above the heading (default on; pass false for cramped rows). */
  glyph?: boolean;
  /** In-card variant: small glyph + heading (+ optional reason), no dashed box. */
  compact?: boolean;
  /** Reserve a chart-plot / table-rows footprint (compact only) instead of re-typing height classes. */
  size?: DataStateSize;
  className?: string;
}

/**
 * The one empty-state pattern for the dashboard — a hairline dashed box on paper, NOT a Card.
 * The «terra incognita» cartograph (uncharted map + flag) + heading + optional reason + action
 * link. Use everywhere a panel has "no data yet" (keeps depth in hairlines, not card chrome —
 * see the index.css governance note).
 */
export function EmptyState({ title, reason, action, glyph = true, compact = false, size, className }: EmptyStateProps) {
  if (compact) {
    // In-card empties: the SAME line-art language as the page-level states, no dashed box (the card
    // is already the frame) — replaces the bare grey strings (аудит). A bare title reads as one
    // quiet line; a title + reason gain the two-step heading/subline hierarchy of the page states.
    return (
      <div
        className={cn(
          // tile-short:*: зеркало ErrorState.compact — в тесном фикс-тайле резерв и ритм ужимаются
          // сами (CQ `tile`, index.css), пустое состояние не распирает 264px-слот.
          'flex h-full min-h-24 flex-col items-center justify-center gap-1.5 py-4 text-center tile-short:min-h-0 tile-short:h-auto tile-short:flex-1 tile-short:gap-1 tile-short:py-2',
          size && dataStateSizeClass[size],
          className,
        )}
      >
        {glyph ? <Cartograph name="terra" className="h-8 w-auto opacity-80 tile-short:h-6" /> : null}
        <p className={cn('text-sm', reason ? 'font-medium text-foreground' : 'text-muted-foreground')}>{title}</p>
        {reason ? <p className="mx-auto max-w-xs text-2xs text-muted-foreground">{reason}</p> : null}
        {action ? (
          <Button asChild size="sm" variant="outline" className="mt-1">
            <Link to={action.to}>{action.label} →</Link>
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    // tile-short:*: полный вариант в тесном фикс-тайле конвергирует к компактной иерархии
    // (зеркало ErrorState) — рамка гаснет, ритм ужимается, ничего не клипается.
    <div
      className={cn(
        'flex flex-col items-center rounded border border-dashed border-border bg-background px-4 py-8 text-center tile-short:flex-1 tile-short:min-h-0 tile-short:justify-center tile-short:gap-1 tile-short:rounded-none tile-short:border-0 tile-short:bg-transparent tile-short:px-3 tile-short:py-2',
        className,
      )}
    >
      {glyph ? <Cartograph name="terra" className="mb-3 h-12 w-auto tile-short:mb-0 tile-short:h-6 tile-short:opacity-80" /> : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {reason ? <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground tile-short:mt-0 tile-short:max-w-xs tile-short:text-2xs tile-short:line-clamp-2">{reason}</p> : null}
      {action ? (
        <Button asChild size="sm" className="mt-3 tile-short:mt-1">
          <Link to={action.to}>{action.label} →</Link>
        </Button>
      ) : null}
    </div>
  );
}
