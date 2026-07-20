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
          'flex h-full min-h-24 flex-col items-center justify-center gap-1.5 py-4 text-center',
          size && dataStateSizeClass[size],
          className,
        )}
      >
        <Cartograph name="broken-route" className="h-8 w-auto opacity-80" />
        <p className="text-sm font-medium text-foreground">{title}</p>
        {reason ? <p className="mx-auto max-w-xs text-2xs text-muted-foreground">{reason}</p> : null}
        {onRetry ? (
          <Button type="button" size="sm" variant="outline" onClick={onRetry} disabled={retrying} className="mt-1">
            {retrying ? 'Загрузка…' : 'Повторить'}
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div role="alert" className={cn('flex flex-col items-center rounded border border-dashed border-border bg-background px-4 py-8 text-center', className)}>
      <Cartograph name="broken-route" className="h-16 w-auto" />
      <p className="mt-4 text-sm font-medium text-foreground">{title}</p>
      {reason ? <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{reason}</p> : null}
      {onRetry ? (
        <Button
          type="button"
          size="sm"
          onClick={onRetry}
          disabled={retrying}
          className="mt-4"
        >
          {retrying ? 'Загрузка…' : 'Повторить'}
        </Button>
      ) : null}
    </div>
  );
}
