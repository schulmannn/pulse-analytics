import type { ReactNode } from 'react';
import { ICON_BUTTON_CLASS } from './constants';
import { MenuIcon, WidgetMenu } from './WidgetMenu';
import type { WidgetMenuProps } from './WidgetMenu';

interface PresenceState {
  mounted: boolean;
  exiting: boolean;
}

interface WidgetHeaderProps {
  label: string;
  action?: ReactNode;
  strip: boolean;
  /** In-flow strip header with a visible title (metric explorer toolbar). */
  stripToolbar?: boolean;
  reorder: boolean;
  allowExpand: boolean;
  homeKey?: string;
  removePresence: PresenceState;
  onRemove: () => void;
  onExpand: () => void;
  /** Клавиатурная перестановка в reorder-режиме (группа виджетов; вне группы — undefined). */
  onReorderMove?: (dir: -1 | 1) => void;
  menu: Omit<WidgetMenuProps, 'homeKey'>;
}

export function WidgetHeader({
  label,
  action,
  strip,
  stripToolbar,
  reorder,
  allowExpand,
  homeKey,
  removePresence,
  onRemove,
  onExpand,
  onReorderMove,
  menu,
}: WidgetHeaderProps) {
  // A «floating» strip parks the controls in the top-right corner over a headline-less summary; a
  // toolbar strip (metric explorer) lays them in-flow with a visible title, so the page's card can
  // frame title + switcher + menu as one row.
  const floating = strip && !stripToolbar && !reorder;
  return (
    <div className={floating ? 'absolute -top-1 right-0 z-10 flex items-center' : 'flex shrink-0 items-center gap-3'}>
      <h3
        title={label}
        className={floating ? 'sr-only' : 'widget-title min-w-0 flex-1 truncate text-sm font-medium tracking-tight text-foreground'}
      >
        {label}
      </h3>
      {action && (
        <div
          className="flex shrink-0 items-center gap-2"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {action}
        </div>
      )}
      {removePresence.mounted && (
        <button
          type="button"
          aria-label={`Убрать виджет «${label}» с главной`}
          title="Убрать с главной"
          aria-hidden={removePresence.exiting || undefined}
          tabIndex={removePresence.exiting ? -1 : undefined}
          onClick={onRemove}
          className={`${ICON_BUTTON_CLASS} hover:text-destructive ${
            reorder
              ? 'pointer-events-none invisible'
              : removePresence.exiting
                ? 'home-remove-exit pointer-events-none'
                : 'home-remove-enter'
          }`}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M6 6l12 12M18 6 6 18" strokeLinecap="round" />
          </svg>
        </button>
      )}
      {allowExpand && (
        <button
          type="button"
          aria-label={`Развернуть виджет «${label}»`}
          onClick={onExpand}
          className={`sr-only ${removePresence.mounted || reorder ? 'hidden' : ''}`}
        >
          Развернуть
        </button>
      )}
      {reorder && onReorderMove && (
        // Ручка перестановки: единственный фокусируемый элемент карточки в reorder-режиме (меню и
        // «убрать» здесь invisible). Указательный жест остаётся у всей карточки — pointerdown
        // гасим, иначе section-level обработчик preventDefault'ит и ручка не получает фокус.
        // Кольцо фокуса даёт глобальное правило index.css (button:focus-visible), своё не заводим.
        <button
          type="button"
          data-reorder-handle
          aria-label={`Переместить виджет «${label}»`}
          aria-keyshortcuts="ArrowLeft ArrowRight"
          title="Стрелки ← → — переместить"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            const dir: -1 | 1 | 0 =
              event.key === 'ArrowLeft' || event.key === 'ArrowUp'
                ? -1
                : event.key === 'ArrowRight' || event.key === 'ArrowDown'
                  ? 1
                  : 0;
            if (dir === 0) return;
            event.preventDefault();
            event.stopPropagation();
            onReorderMove(dir);
          }}
          className={`${ICON_BUTTON_CLASS} hover:text-foreground`}
        >
          <MenuIcon kind="drag" />
        </button>
      )}
      <WidgetMenu {...menu} homeKey={homeKey} />
    </div>
  );
}
