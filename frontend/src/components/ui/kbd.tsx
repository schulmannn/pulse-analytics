import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Чип клавиши/шортката (shadcn Kbd): моно-глиф в тихой рамке. Для сочетаний — несколько <Kbd>
    подряд внутри KbdGroup («Ctrl» «K»). Декоративен для AT ровно настолько, насколько текст
    рядом уже называет действие. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-5 min-w-5 select-none items-center justify-center rounded border border-border bg-muted/40 px-1 font-mono text-2xs font-medium text-muted-foreground',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/** Ряд клавиш одного сочетания — единый зазор, без «+» (глифы читаются сами). */
export function KbdGroup({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1', className)}>{children}</span>;
}
