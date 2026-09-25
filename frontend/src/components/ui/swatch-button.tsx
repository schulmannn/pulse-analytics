import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface SwatchButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  color: string;
  selected: boolean;
}

/**
 * A 20px visual colour sample inside a phone-safe 44px hit area. At ≥sm the hit area collapses
 * back to the compact sample size used by the desktop widget editor.
 */
export function SwatchButton({ color, selected, className, ...props }: SwatchButtonProps) {
  return (
    <button
      type="button"
      data-mobile-touch-target=""
      className={cn('flex h-11 w-11 items-center justify-center rounded-full sm:h-5 sm:w-5', className)}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          'h-5 w-5 rounded-full transition-shadow',
          selected && 'ring-2 ring-foreground/50 ring-offset-2 ring-offset-card',
        )}
        style={{ backgroundColor: color }}
      />
    </button>
  );
}
