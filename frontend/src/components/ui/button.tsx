import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@/lib/utils';

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive:
          'border border-destructive/20 bg-background text-destructive hover:bg-destructive/5',
        outline:
          'border border-border bg-background text-foreground hover:bg-muted',
        secondary:
          'border border-border bg-background text-foreground hover:bg-muted',
        ghost: 'text-muted-foreground hover:bg-muted hover:text-foreground',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      size: {
        default: 'h-9 min-h-11 px-4 py-2 sm:min-h-0',
        sm: 'h-8 min-h-11 px-3.5 text-xs sm:min-h-0',
        xs: 'h-7 min-h-11 px-3 text-xs sm:min-h-0',
        lg: 'h-10 min-h-11 px-8 sm:min-h-0',
        icon: 'h-9 min-h-11 w-9 min-w-11 p-0 sm:min-h-0 sm:min-w-0',
        'icon-sm': 'h-8 min-h-11 w-8 min-w-11 p-0 sm:min-h-0 sm:min-w-0',
        'icon-xs': 'h-7 min-h-11 w-7 min-w-11 p-0 sm:min-h-0 sm:min-w-0',
      },
      shape: {
        pill: 'btn-pill',
        rounded: 'rounded-md',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
      shape: 'pill',
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, shape, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button';
    return (
      <Comp
        data-mobile-touch-target=""
        className={cn(buttonVariants({ variant, size, shape, className }))}
        ref={ref}
        {...props}
      />
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
