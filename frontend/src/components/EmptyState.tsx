import type { ReactNode } from 'react';
import { Inbox } from 'lucide-react';
import { Link } from 'react-router-dom';
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
  className?: string;
}

/**
 * Product wrapper around the shadcn Empty primitive. Page-level states get one quiet, solid surface;
 * compact states drop that surface because their card/table already supplies the chrome.
 */
export function EmptyState({ title, reason, action, glyph = true, compact = false, size, className }: EmptyStateProps) {
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
      <EmptyHeader className={cn(compact ? 'gap-1.5' : 'gap-2', 'tile-short:gap-0.5')}>
        {glyph ? (
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
