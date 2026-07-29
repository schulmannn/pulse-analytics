import type { ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
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
  /** In-card/in-table variant: small icon + heading (+ reason + retry), no nested surface — the mirror
      of EmptyState's compact, for a failed query inside an existing card or table surface. */
  compact?: boolean;
  /** Reserve a chart-plot / table-rows footprint (compact only) instead of re-typing height classes. */
  size?: DataStateSize;
  className?: string;
}

/**
 * Load-/fetch-failure wrapper built from the same shadcn Empty composition as EmptyState. The
 * `compact` variant drops the surface for a failed query nested inside a card or table.
 */
export function ErrorState({ title = 'Не удалось загрузить', reason, onRetry, retrying, compact = false, size, className }: ErrorStateProps) {
  return (
    <Empty
      role="alert"
      className={cn(
        compact
          ? 'h-full min-h-24 gap-2 rounded-none border-0 bg-transparent px-3 py-4 md:p-4 tile-short:min-h-0 tile-short:h-auto tile-short:flex-1 tile-short:gap-0.5 tile-short:py-1.5'
          : 'min-h-52 gap-4 border border-solid border-border/70 bg-muted/20 px-6 py-10 md:p-10 tile-short:flex-1 tile-short:min-h-0 tile-short:gap-1 tile-short:rounded-none tile-short:border-0 tile-short:bg-transparent tile-short:px-3 tile-short:py-2',
        size && dataStateSizeClass[size],
        className,
      )}
    >
      <EmptyHeader className={cn(compact ? 'gap-1.5' : 'gap-2', 'tile-short:gap-0.5')}>
        <EmptyMedia
          variant="icon"
          className={cn(
            'mb-1 rounded-full bg-destructive/10 text-destructive',
            compact ? 'size-8 [&_svg]:size-4' : 'size-10 [&_svg]:size-5',
            'tile-short:mb-0 tile-short:size-6 tile-short:[&_svg]:size-3.5',
          )}
        >
          <TriangleAlert aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle className="text-sm font-medium tracking-normal text-foreground">
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
      {onRetry ? (
        <EmptyContent className={cn(compact ? 'gap-2' : 'gap-3', 'tile-short:gap-0.5')}>
          <Button
            type="button"
            size="sm"
            variant={compact ? 'outline' : 'default'}
            onClick={onRetry}
            disabled={retrying}
          >
            {retrying ? 'Загрузка…' : 'Повторить'}
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
