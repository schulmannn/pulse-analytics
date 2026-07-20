import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Cartograph } from '@/components/Cartograph';
import { Button } from '@/components/ui/button';

interface ErrorStateProps {
  /** Heading — what failed, plainly (default "Не удалось загрузить"). */
  title?: string;
  /** Optional second line — usually the error message or how to recover. */
  reason?: ReactNode;
  /** Optional retry (react-query refetch etc.); shows a «Повторить» pill when set. */
  onRetry?: () => void;
  /** Disables the retry pill + shows «Загрузка…» while a refetch is in flight. */
  retrying?: boolean;
  className?: string;
}

/**
 * The one load-/fetch-failure surface — the «broken route» cartograph + title + reason + an
 * optional retry. A hairline dashed box on the paper canvas (same restraint as EmptyState);
 * used wherever a query's isError branch showed ad-hoc «Не удалось загрузить …» text.
 */
export function ErrorState({ title = 'Не удалось загрузить', reason, onRetry, retrying, className }: ErrorStateProps) {
  return (
    <div className={cn('flex flex-col items-center rounded border border-dashed border-border bg-background px-4 py-8 text-center', className)}>
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
