import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';

interface EmptyStateProps {
  /** One-line heading naming the empty space (e.g. "Публикаций пока нет"). */
  title: string;
  /** Optional second line explaining why / what unlocks it. */
  reason?: ReactNode;
  /** Optional single call-to-action link. */
  action?: { to: string; label: string };
  className?: string;
}

/**
 * The one empty-state pattern for the dashboard — a hairline dashed box on paper, NOT a Card.
 * Heading + optional reason + optional action link. Use everywhere a panel has "no data yet"
 * (keeps depth in hairlines, not card chrome — see the index.css governance note).
 */
export function EmptyState({ title, reason, action, className }: EmptyStateProps) {
  return (
    <div className={cn('rounded border border-dashed border-border bg-background px-4 py-8 text-center', className)}>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {reason ? <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{reason}</p> : null}
      {action ? (
        <Link
          to={action.to}
          className="mt-3 inline-block text-sm font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
        >
          {action.label} →
        </Link>
      ) : null}
    </div>
  );
}
