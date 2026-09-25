import * as React from 'react';
import { Slot, Slottable } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { LoaderDots } from '@/components/ui/loader';
import { cn } from '@/lib/utils';

/**
 * Tactile press feedback — the canon's 0.95–0.98 dip, here at 0.97 over `--motion-press` (140ms,
 * inside the 100–160ms band). A control that reacts to being pressed feels connected to the finger;
 * one that only changes colour on release feels like a picture of a button. Carried by the five
 * SURFACE variants only: `link` is text, and text does not depress.
 *
 * Reduced motion drops the dip outright instead of letting the global 0.01ms net snap it — a scale
 * that teleports is worse than no scale, and the canon's rule for reduced motion is «keep the
 * colour half, drop the transform half». Disabled buttons never reach `:active`
 * (`disabled:pointer-events-none` in the base).
 */
const PRESS_DIP = 'active:scale-[0.97] motion-reduce:active:scale-100';

const buttonVariants = cva(
  // The property list is `transition-colors` spelled out plus `transform`, so the press dip rides the
  // same beat as the colour change. Enumerated rather than blanket, so no layout property is swept in.
  'inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium transition-[color,background-color,border-color,text-decoration-color,fill,stroke,transform] dur-press ease-house focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: `bg-primary text-primary-foreground hover:bg-primary/90 ${PRESS_DIP}`,
        destructive: `border border-destructive/20 bg-background text-destructive hover:bg-destructive/5 ${PRESS_DIP}`,
        outline: `border border-border bg-background text-foreground hover:bg-muted ${PRESS_DIP}`,
        secondary: `border border-border bg-background text-foreground hover:bg-muted ${PRESS_DIP}`,
        // Инверсия чернил и полотна: чёрная на светлой теме, белая на тёмной. Нужна там, где
        // действие обязано быть заметнее синего акцента, — «Сохранить» на странице метрики
        // владелец не находил дважды подряд. `default` занят единственным синим канона, поэтому
        // у контраста свой вариант, а не переопределение классами на месте: такие переопределения
        // успели разойтись по четырём точкам (IgContentDesktop ×2, ReportDocumentDesktop ×2) и
        // отличались друг от друга и токеном текста, и силой hover, и цветом focus-кольца. Все
        // четыре сведены сюда; осталось одно НАМЕРЕННОЕ отличие — у Instagram чернила берутся по
        // местной плите (text-surface-table), потому что кнопка стоит на bg-surface-table.
        // Возврат копий стережёт правило contrast-button-retyped в scripts/design-motion-lint.
        contrast: `bg-foreground text-background hover:bg-foreground/90 focus-visible:ring-foreground/35 ${PRESS_DIP}`,
        ghost: `text-muted-foreground hover:bg-muted hover:text-foreground ${PRESS_DIP}`,
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
  pending?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant,
      size,
      shape,
      asChild = false,
      pending = false,
      disabled = false,
      children,
      ...props
    },
    ref,
  ) => {
    const Comp = asChild ? Slot : 'button';
    const unavailable = disabled || pending;
    return (
      <Comp
        {...props}
        data-mobile-touch-target=""
        data-pending={pending || undefined}
        aria-busy={pending || undefined}
        aria-disabled={asChild && unavailable ? true : props['aria-disabled']}
        disabled={asChild ? undefined : unavailable}
        className={cn(
          buttonVariants({ variant, size, shape, className }),
          asChild && unavailable && 'pointer-events-none opacity-50',
        )}
        ref={ref}
      >
        {pending ? <LoaderDots /> : null}
        <Slottable>{children}</Slottable>
      </Comp>
    );
  },
);
Button.displayName = 'Button';

export { Button, buttonVariants };
