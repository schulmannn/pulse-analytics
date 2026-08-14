import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * The two shared data-loading scaffolds — a chart placeholder and a table placeholder — so every
 * widget / table shows loading in the SAME visual language and reserves the SAME footprint as the
 * content it stands in for (CLS budget, DESIGN_TOKENS «Loading & layout stability»). Both compose
 * the base {@link Skeleton}, so `prefers-reduced-motion` (shimmer → static field) is handled once.
 */

/**
 * Chart-shaped loading: an optional hero headline (number + caption) over a plot band — the same
 * anatomy as a loaded story card, so a config widget never flashes «Нет данных» before its data
 * arrives and loading reads as distinct from a genuinely empty result. `headline={false}` for the
 * breakdown/donut vizzes that lead with the chart itself.
 */
export function ChartSkeleton({
  headline = true,
  label = 'Загрузка графика',
  className,
}: {
  headline?: boolean;
  label?: string;
  className?: string;
}) {
  return (
    <div role="status" aria-busy="true" aria-label={label} className={cn('flex h-full min-h-0 flex-col', className)}>
      <div aria-hidden="true" className="contents">
        {headline && (
          <div className="shrink-0 space-y-2">
            <Skeleton className="h-7 w-28" />
            <Skeleton className="h-3 w-40" />
          </div>
        )}
        <div className={cn('min-h-0 flex-1', headline && 'mt-3')}>
          <Skeleton className="h-full min-h-[72px] w-full rounded" />
        </div>
      </div>
    </div>
  );
}

/**
 * Table-shaped loading: a header hairline over dense rows, each a wide label cell + a few narrow
 * numeric cells — so the placeholder reads as column/row structure, not a grey block. Sits directly
 * on the surface (no card chrome); the caller supplies row/column counts to match its own table.
 */
export function TableSkeleton({
  rows = 5,
  columns = 4,
  header = true,
  label = 'Загрузка таблицы',
  className,
}: {
  rows?: number;
  columns?: number;
  header?: boolean;
  label?: string;
  className?: string;
}) {
  const cells = Array.from({ length: Math.max(columns, 1) });
  return (
    <div role="status" aria-busy="true" aria-label={label} className={cn('w-full', className)}>
      <div aria-hidden="true">
        {header && (
          <div className="flex items-center gap-4 border-b border-border pb-2.5">
            {cells.map((_, c) => (
              <Skeleton key={c} className={cn('h-3', c === 0 ? 'w-24 flex-1' : 'w-12')} />
            ))}
          </div>
        )}
        <div className="divide-y divide-border">
          {Array.from({ length: Math.max(rows, 1) }).map((_, r) => (
            <div key={r} className="flex items-center gap-4 py-3">
              {cells.map((_, c) => (
                <Skeleton key={c} className={cn('h-4', c === 0 ? 'flex-1' : 'w-12')} />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
