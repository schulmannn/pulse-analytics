'use client';

import * as React from 'react';
import * as HoverCardPrimitive from '@radix-ui/react-hover-card';

import { cn } from '@/lib/utils';

// Hover-карточка (превью по наведению) — shadcn-обёртка в поповер-каноне ui/dropdown-menu.
// openDelay короткий: превью — читалка рабочей таблицы, а не ленивый тултип.

const HoverCard = ({ openDelay = 250, closeDelay = 120, ...props }: HoverCardPrimitive.HoverCardProps) => (
  <HoverCardPrimitive.Root openDelay={openDelay} closeDelay={closeDelay} {...props} />
);

const HoverCardTrigger = HoverCardPrimitive.Trigger;

const HoverCardContent = React.forwardRef<
  React.ElementRef<typeof HoverCardPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content>
>(({ className, align = 'start', side = 'top', sideOffset = 8, collisionPadding = 12, ...props }, ref) => (
  <HoverCardPrimitive.Portal>
    <HoverCardPrimitive.Content
      ref={ref}
      align={align}
      side={side}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        // Без тени — канон поверхности (hairlines, не elevation): та же рамка, что у dropdown.
        'z-popover w-80 rounded-xl border border-border bg-popover p-4 text-popover-foreground outline-hidden',
        'data-[state=open]:animate-in data-[state=open]:ease-house data-[state=closed]:animate-out data-[state=closed]:ease-exit data-[state=closed]:anim-dur-exit data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 motion-reduce:duration-0 origin-(--radix-hover-card-content-transform-origin)',
        className,
      )}
      {...props}
    />
  </HoverCardPrimitive.Portal>
));
HoverCardContent.displayName = HoverCardPrimitive.Content.displayName;

export { HoverCard, HoverCardTrigger, HoverCardContent };
