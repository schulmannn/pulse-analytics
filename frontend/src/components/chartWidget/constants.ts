import type { PeriodDays } from '@/lib/period';
import type { WidgetSize } from '@/lib/widgetPrefsStore';

export const SIZE_COL_SPAN: Record<WidgetSize, string> = {
  third: 'lg:col-span-2',
  half: 'lg:col-span-3',
  full: 'lg:col-span-6',
};

export const SIZE_HEIGHT: Record<WidgetSize, string> = {
  third: 'h-[264px]',
  half: 'h-[264px]',
  full: '',
};

export const REMOVE_EXIT_MS = 200;

export const ICON_BUTTON_CLASS =
  'inline-flex h-8 w-8 sm:h-7 sm:w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted';

export const MENU_ITEM_CLASS =
  'flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40';

export const PERIOD_WORD: Record<PeriodDays, string> = {
  7: '7 дней',
  30: '30 дней',
  90: '90 дней',
  0: 'всё время',
};
