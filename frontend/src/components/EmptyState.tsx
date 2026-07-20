import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { Cartograph } from '@/components/Cartograph';
import { Button } from '@/components/ui/button';

interface EmptyStateProps {
  /** One-line heading naming the empty space (e.g. "Публикаций пока нет"). */
  title: string;
  /** Optional second line explaining why / what unlocks it. */
  reason?: ReactNode;
  /** Optional single call-to-action link. */
  action?: { to: string; label: string };
  /** The «terra incognita» cartograph above the heading (default on; pass false for cramped rows). */
  glyph?: boolean;
  /** In-card variant: small glyph + one muted line, no dashed box. */
  compact?: boolean;
  className?: string;
}

/**
 * The one empty-state pattern for the dashboard — a hairline dashed box on paper, NOT a Card.
 * The «terra incognita» cartograph (uncharted map + flag) + heading + optional reason + action
 * link. Use everywhere a panel has "no data yet" (keeps depth in hairlines, not card chrome —
 * see the index.css governance note).
 */
export function EmptyState({ title, reason, action, glyph = true, compact = false, className }: EmptyStateProps) {
  if (compact) {
    // In-card empties: the SAME line-art language as the page-level states, one quiet line, no
    // dashed box (the card is already the frame) — replaces the bare grey strings (аудит).
    return (
      <div className={cn('flex h-full min-h-24 flex-col items-center justify-center gap-2 py-4 text-center', className)}>
        {glyph ? <Cartograph name="terra" className="h-8 w-auto opacity-80" /> : null}
        <p className="text-sm text-muted-foreground">{title}</p>
      </div>
    );
  }
  return (
    <div className={cn('flex flex-col items-center rounded border border-dashed border-border bg-background px-4 py-8 text-center', className)}>
      {glyph ? <Cartograph name="terra" className="mb-3 h-12 w-auto" /> : null}
      <p className="text-sm font-medium text-foreground">{title}</p>
      {reason ? <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{reason}</p> : null}
      {action ? (
        <Button asChild size="sm" className="mt-3">
          <Link to={action.to}>{action.label} →</Link>
        </Button>
      ) : null}
    </div>
  );
}
