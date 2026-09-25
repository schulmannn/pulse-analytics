import * as React from 'react';
import * as ProgressPrimitive from '@radix-ui/react-progress';

import { cn } from '@/lib/utils';

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, ...props }, ref) => (
  <ProgressPrimitive.Root
    ref={ref}
    value={value}
    className={cn(
      'relative h-2 w-full overflow-hidden rounded-full bg-muted',
      className,
    )}
    {...props}
  >
    <ProgressPrimitive.Indicator
      className={cn(
        // transition-transform only: the value is carried by the translateX below, so a blanket
        // property list bought nothing but the layout-triggering w-1/3 ↔ w-full flip (a mode
        // change that should snap, not tween). dur-reveal leaves animate-pulse on its own beat.
        'h-full flex-1 rounded-full bg-primary transition-transform dur-reveal ease-house',
        value == null
          ? 'w-1/3 animate-pulse motion-reduce:animate-none'
          : 'w-full',
      )}
      style={{
        transform: value == null ? undefined : `translateX(-${100 - value}%)`,
      }}
    />
  </ProgressPrimitive.Root>
));
Progress.displayName = ProgressPrimitive.Root.displayName;

export { Progress };
