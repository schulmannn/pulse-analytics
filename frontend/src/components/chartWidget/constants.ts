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

/**
 * Отложенный рендер фикс.-размерных карточек (перф «фризов»: бут /home раскладывал всю доску
 * разом). Офскрин-карточка держит бокс ровно в пиксели SIZE_HEIGHT через contain-intrinsic-size,
 * а layout/paint её содержимого браузер скипает до приближения к viewport'у — заодно ставя на
 * паузу CSS-анимации внутри. Ключи ОБЯЗАНЫ зеркалить SIZE_HEIGHT (те же пиксели); full —
 * авто-высотный, интрисика для него нет — не скипаем. Только md+ (мобильный этап не трогаем);
 * print возвращает рендер, иначе в PDF уедут пустые тела (порядок @media print ПОСЛЕ
 * @media (min-width) в выхлопе Tailwind — override работает, проверено компиляцией).
 */
export const SIZE_DEFER_RENDER: Record<WidgetSize, string> = {
  third:
    'md:[content-visibility:auto] md:[contain-intrinsic-size:auto_264px] print:[content-visibility:visible]',
  half: 'md:[content-visibility:auto] md:[contain-intrinsic-size:auto_264px] print:[content-visibility:visible]',
  full: '',
};

export const REMOVE_EXIT_MS = 200;

export const ICON_BUTTON_CLASS =
  'widget-icon inline-flex h-8 w-8 sm:h-7 sm:w-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted';

export const MENU_ITEM_CLASS =
  'flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40';

export const PERIOD_WORD: Record<PeriodDays, string> = {
  7: '7 дней',
  30: '30 дней',
  90: '90 дней',
  0: 'всё время',
};
