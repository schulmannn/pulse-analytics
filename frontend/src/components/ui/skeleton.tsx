import type { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Skeleton({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  // motion-reduce: the shimmer is pure decoration — a static muted field reads the same.
  return <div className={cn('animate-pulse rounded bg-muted motion-reduce:animate-none', className)} {...props} />;
}
