import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Cartograph } from '@/components/Cartograph';
import { Button } from '@/components/ui/button';
import { dataStateSizeClass, type DataStateSize } from '@/components/EmptyState';

interface ErrorStateProps {
  /** Heading — what failed, plainly (default "Не удалось загрузить"). */
  title?: string;
  /** Optional second line — usually the error message or how to recover. */
  reason?: ReactNode;
  /** Optional retry (react-query refetch etc.); shows a «Повторить» pill when set. */
  onRetry?: () => void;
  /** Disables the retry pill + shows «Загрузка…» while a refetch is in flight. */
  retrying?: boolean;
  /** In-card/in-table variant: small glyph + heading (+ reason + retry), no dashed box — the mirror
      of EmptyState's compact, for a failed query inside an existing card or table surface. */
  compact?: boolean;
  /** Reserve a chart-plot / table-rows footprint (compact only) instead of re-typing height classes. */
  size?: DataStateSize;
  className?: string;
}

/**
 * The one load-/fetch-failure surface — the «broken route» cartograph + title + reason + an
 * optional retry. A hairline dashed box on the paper canvas (same restraint as EmptyState);
 * used wherever a query's isError branch showed ad-hoc «Не удалось загрузить …» text. The
 * `compact` variant drops the dashed box for a failed query nested inside a card / table.
 */
export function ErrorState({ title = 'Не удалось загрузить', reason, onRetry, retrying, compact = false, size, className }: ErrorStateProps) {
  if (compact) {
    // Mirrors EmptyState's compact hierarchy (glyph → medium heading → muted subline) so a card
    // that empties and a card that fails read as one family; no nested dashed page box.
    return (
      <div
        role="alert"
        className={cn(
          // tile-short:*: в тесном фикс-тайле (CQ `tile`, index.css) состояние ужимается само —
          // py/gap/глиф меньше, reason клампится — и «Повторить» гарантированно остаётся в слоте.
          // Вариантные утилиты в выхлопе позже базовых, поэтому tile-short:py-2 перебивает и
          // py-4 этой строки, и py-4 из call-site className.
          'flex h-full min-h-24 flex-col items-center justify-center gap-1.5 py-4 text-center tile-short:min-h-0 tile-short:h-auto tile-short:flex-1 tile-short:gap-1 tile-short:py-2',
          size && dataStateSizeClass[size],
          className,
        )}
      >
        <Cartograph name="broken-route" className="h-8 w-auto opacity-80 tile-short:h-6" />
        <p className="text-sm font-medium text-foreground">{title}</p>
        {reason ? <p className="mx-auto max-w-xs text-2xs text-muted-foreground tile-short:line-clamp-2">{reason}</p> : null}
        {onRetry ? (
          <Button type="button" size="sm" variant="outline" onClick={onRetry} disabled={retrying} className="mt-1">
            {retrying ? 'Загрузка…' : 'Повторить'}
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    // tile-short:*: полный вариант, случайно попавший в тесный фикс-тайл (систематический риск —
    // любой будущий call-site), конвергирует к компактной иерархии: рамка-пунктир гаснет (карточка
    // уже рамка), глиф/отступы компактные, reason клампится — вместо клипа overflow-hidden.
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center rounded border border-dashed border-border bg-background px-4 py-8 text-center tile-short:flex-1 tile-short:min-h-0 tile-short:justify-center tile-short:gap-1 tile-short:rounded-none tile-short:border-0 tile-short:bg-transparent tile-short:px-3 tile-short:py-2',
        className,
      )}
    >
      <Cartograph name="broken-route" className="h-16 w-auto tile-short:h-6 tile-short:opacity-80" />
      <p className="mt-4 text-sm font-medium text-foreground tile-short:mt-0">{title}</p>
      {reason ? <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground tile-short:mt-0 tile-short:max-w-xs tile-short:text-2xs tile-short:line-clamp-2">{reason}</p> : null}
      {onRetry ? (
        <Button
          type="button"
          size="sm"
          onClick={onRetry}
          disabled={retrying}
          className="mt-4 tile-short:mt-1"
        >
          {retrying ? 'Загрузка…' : 'Повторить'}
        </Button>
      ) : null}
    </div>
  );
}
