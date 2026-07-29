'use client';

import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cn } from '@/lib/utils';

const Tabs = TabsPrimitive.Root;

interface TabsListExtraProps {
  /** Скользящая пилюля под активным табом: вместо мгновенной
      смены заливки один aria-hidden спан переезжает к активному табу по --motion-base. Опционально:
      поверхности с подчёркиванием (Settings mobile) остаются на своей идиоме. Активный таб при
      включённом глайдере НЕ должен нести собственный data-[state=active]:bg-* — пилюля едет здесь. */
  glider?: boolean;
  /** Заливка глайдера — сохраняет прежний активный тон поверхности (bg-secondary / bg-primary/15). */
  gliderClassName?: string;
}

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & TabsListExtraProps
>(({ className, glider = false, gliderClassName, children, ...props }, ref) => {
  const listRef = React.useRef<HTMLDivElement | null>(null);
  const setRefs = (node: HTMLDivElement | null) => {
    listRef.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref) ref.current = node;
  };
  React.useLayoutEffect(() => {
    if (!glider) return;
    const list = listRef.current;
    if (!list) return;
    const indicator = list.querySelector<HTMLElement>('[data-tabs-glider]');
    if (!indicator) return;
    const measure = () => {
      const active = list.querySelector<HTMLElement>('[role="tab"][data-state="active"]');
      if (!active) {
        indicator.style.opacity = '0';
        return;
      }
      indicator.style.opacity = '1';
      indicator.style.width = `${active.offsetWidth}px`;
      indicator.style.height = `${active.offsetHeight}px`;
      indicator.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
    };
    measure();
    // Смена значения меняет data-state на триггерах; ресайз/шрифты двигают геометрию.
    const mo = new MutationObserver(measure);
    mo.observe(list, { attributes: true, attributeFilter: ['data-state'], subtree: true });
    const ro = new ResizeObserver(measure);
    ro.observe(list);
    document.fonts?.ready.then(measure).catch(() => {});
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, [glider]);
  return (
    <TabsPrimitive.List
      ref={setRefs}
      className={cn(
        'inline-flex min-h-11 items-center justify-center rounded-full border border-border bg-background p-0.5 text-muted-foreground sm:min-h-9',
        glider && 'relative isolate',
        className,
      )}
      {...props}
    >
      {glider && (
        <span
          data-tabs-glider
          aria-hidden="true"
          className={cn(
            // -z-10 (при isolate на списке): пилюля ПОД контентом табов, но над фоном списка.
            'pointer-events-none absolute left-0 top-0 -z-10 rounded-full opacity-0 transition-[transform,width,height] dur-base ease-house',
            gliderClassName ?? 'bg-muted',
          )}
        />
      )}
      {children}
    </TabsPrimitive.List>
  );
});
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    data-mobile-touch-target=""
    className={cn(
      'inline-flex min-h-11 min-w-11 items-center justify-center whitespace-nowrap rounded-full px-3 py-1 text-sm font-medium ring-offset-background transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-muted data-[state=active]:text-foreground sm:min-h-0 sm:min-w-0',
      className,
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'mt-2 ring-offset-background focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
