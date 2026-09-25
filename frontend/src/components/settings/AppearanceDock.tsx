import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { setThemeStudioOpen } from '@/lib/appearanceStorage';
import { AppearanceStudio } from '@/components/settings/AppearanceStudio';
import { SettingsIcon } from '@/components/settings/primitives';

/**
 * Левая панель студии оформления — поверх работающего приложения.
 *
 * Смысл именно в том, чтобы НЕ быть модалкой: страница справа остаётся видимой и кликабельной,
 * поэтому здесь нет ни затемнения, ни ловушки фокуса — меняешь акцент и сразу видишь, как
 * перекрасились графики. Живой предпросмотр — это само приложение, отдельной карточки-предпросмотра
 * внутри панели нет (она есть в разделе настроек, где приложения за диалогом не видно).
 *
 * Перекраска мгновенная и без перерендера: серии рисуются через `hsl(var(--chart-role-primary))`,
 * то есть CSS-переменные разрешаются в момент отрисовки.
 *
 * Слой — `z-popover` (40) из лестницы DESIGN_TOKENS: панель стоит выше липкой шапки и фиксированной
 * навигации, но НИЖЕ диалогов (`z-modal`), чтобы настройки или подтверждение по-прежнему её
 * накрывали. Только desktop (`hidden md:flex`): мобильный редизайн — отдельный этап, а на телефоне
 * студия остаётся разделом настроек.
 */
export function AppearanceDock() {
  // Escape закрывает панель. Захватывающая фаза не нужна и вредна: открытое меню выбора или диалог
  // поверх должны съесть Escape первыми, иначе панель закроется вместе со своим же выпадашкой.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) setThemeStudioOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return createPortal(
    <aside
      aria-label="Студия оформления"
      data-appearance-dock=""
      className="fixed inset-y-2.5 left-2.5 z-popover hidden w-80 flex-col overflow-hidden rounded-2xl border border-border bg-card md:flex"
    >
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border py-2 pl-4 pr-2">
        <span className="text-sm font-medium text-foreground">Оформление</span>
        <button
          type="button"
          aria-label="Закрыть студию оформления"
          onClick={() => setThemeStudioOpen(false)}
          className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/50"
        >
          <SettingsIcon name="close" className="h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <AppearanceStudio variant="dock" />
      </div>
    </aside>,
    document.body,
  );
}
