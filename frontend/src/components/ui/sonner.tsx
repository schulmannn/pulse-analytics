import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { useTheme } from '@/lib/theme';

/**
 * House-wired sonner Toaster: theme comes from lib/theme (наш ThemeContext, НЕ next-themes из
 * шаблона shadcn), а цвета — через hsl(var(--…)) (токены заданы сырыми HSL-каналами, голый
 * var(--popover) как цвет не работает). Иконки sonner'а дефолтные — свои line-art глифы не
 * дублируем ради дублирования. Позиция снизу-справа, над модалками (z-toast из канон-лестницы).
 */
export function Toaster(props: ToasterProps) {
  const { theme } = useTheme();
  return (
    <Sonner
      theme={theme}
      className="toaster group"
      position="bottom-right"
      offset={16}
      toastOptions={{
        classNames: {
          toast: 'group toast rounded-xl border border-border bg-popover text-popover-foreground shadow-[0_12px_32px_-24px_rgba(0,0,0,0.6)]',
          title: 'text-sm font-medium',
          description: 'text-xs text-muted-foreground',
          actionButton: 'btn-pill bg-primary px-3 py-1 text-xs font-medium text-primary-foreground',
          cancelButton: 'btn-pill border border-border px-3 py-1 text-xs text-muted-foreground',
        },
      }}
      style={
        {
          '--normal-bg': 'hsl(var(--popover))',
          '--normal-text': 'hsl(var(--popover-foreground))',
          '--normal-border': 'hsl(var(--border))',
          '--border-radius': '0.75rem',
          zIndex: 'var(--z-index-toast)',
        } as React.CSSProperties
      }
      {...props}
    />
  );
}
