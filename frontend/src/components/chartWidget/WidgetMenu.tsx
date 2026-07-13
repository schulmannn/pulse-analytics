import { useEffect, useRef } from 'react';
import type { GroupCtxValue } from '@/components/widgets/WidgetGroup';
import { pinToHome, unpinFromHome } from '@/lib/widgetPrefsStore';
import type { WidgetPrefs } from '@/lib/widgetPrefsStore';
import { ICON_BUTTON_CLASS, MENU_ITEM_CLASS } from './constants';

export interface WidgetMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  widgetId: string;
  group: GroupCtxValue | null;
  sequenceIndex: number;
  pinned: boolean;
  homeKey?: string;
  prefs: WidgetPrefs;
  onPrefsChange: (next: WidgetPrefs) => void;
  onExpand: () => void;
  onEdit: () => void;
  allowExpand: boolean;
  allowEdit: boolean;
  reorder: boolean;
}

export function WidgetMenu({
  open,
  onOpenChange,
  label,
  widgetId,
  group,
  sequenceIndex,
  pinned,
  homeKey,
  prefs,
  onPrefsChange,
  onExpand,
  onEdit,
  allowExpand,
  allowEdit,
  reorder,
}: WidgetMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      onOpenChange(false);
      buttonRef.current?.focus();
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onOpenChange]);

  const focusFirstItem = () =>
    requestAnimationFrame(() =>
      rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus(),
    );

  const keepFocusInMenu = () =>
    requestAnimationFrame(() => {
      if (document.activeElement === document.body)
        rootRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
    });

  return (
    <div className={`relative shrink-0 ${reorder ? 'pointer-events-none invisible' : ''}`} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={`Меню виджета «${label}»`}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => onOpenChange(!open)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return;
          event.preventDefault();
          if (!open) onOpenChange(true);
          focusFirstItem();
        }}
        className={`${ICON_BUTTON_CLASS} hover:text-foreground`}
      >
        <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4" aria-hidden="true">
          <circle cx="3.5" cy="8" r="1.25" />
          <circle cx="8" cy="8" r="1.25" />
          <circle cx="12.5" cy="8" r="1.25" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`Меню виджета «${label}»`}
          className="absolute right-0 top-full z-popover mt-1 w-48 rounded-lg border border-border bg-card p-1.5"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const items = Array.from(
              event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)'),
            );
            if (!items.length) return;
            const index = items.indexOf(document.activeElement as HTMLElement);
            const next =
              event.key === 'Home' || (event.key === 'ArrowDown' && index < 0)
                ? 0
                : event.key === 'End'
                  ? items.length - 1
                  : event.key === 'ArrowDown'
                    ? (index + 1) % items.length
                    : index < 0
                      ? items.length - 1
                      : (index - 1 + items.length) % items.length;
            items[next]?.focus();
          }}
        >
          {allowExpand && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  buttonRef.current?.focus();
                  onOpenChange(false);
                  onExpand();
                }}
                className={MENU_ITEM_CLASS}
              >
                <MenuIcon kind="expand" /> Развернуть
              </button>
              <MenuSeparator />
            </>
          )}
          {group && (
            <>
              <button
                type="button"
                role="menuitem"
                disabled={sequenceIndex <= 0}
                onClick={() => {
                  group.move(widgetId, -1);
                  keepFocusInMenu();
                }}
                className={MENU_ITEM_CLASS}
              >
                <MenuIcon kind="up" /> Выше
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={sequenceIndex < 0 || sequenceIndex >= group.sequence.length - 1}
                onClick={() => {
                  group.move(widgetId, 1);
                  keepFocusInMenu();
                }}
                className={MENU_ITEM_CLASS}
              >
                <MenuIcon kind="down" /> Ниже
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onOpenChange(false);
                  group.beginReorder();
                  requestAnimationFrame(() =>
                    document.querySelector<HTMLElement>('[data-reorder-done]')?.focus(),
                  );
                }}
                className={MENU_ITEM_CLASS}
              >
                <MenuIcon kind="drag" /> Переставить
              </button>
              <MenuSeparator />
            </>
          )}
          {homeKey && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                buttonRef.current?.focus();
                onOpenChange(false);
                if (pinned) unpinFromHome(homeKey);
                else pinToHome(homeKey);
                requestAnimationFrame(() => {
                  if (!buttonRef.current?.isConnected)
                    document.querySelector<HTMLElement>('.edit-toggle')?.focus();
                });
              }}
              className={MENU_ITEM_CLASS}
            >
              <MenuIcon kind="home" /> {pinned ? 'Убрать с главной' : 'На главную'}
            </button>
          )}
          {allowEdit && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                buttonRef.current?.focus();
                onOpenChange(false);
                onEdit();
              }}
              className={MENU_ITEM_CLASS}
            >
              <MenuIcon kind="edit" /> Изменить
            </button>
          )}
          {group && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onOpenChange(false);
                onPrefsChange({ ...prefs, hidden: true });
                requestAnimationFrame(() => {
                  for (const chip of document.querySelectorAll<HTMLElement>('[data-widget-chip]')) {
                    if (chip.dataset.widgetChip === widgetId) {
                      chip.focus();
                      return;
                    }
                  }
                });
              }}
              className={MENU_ITEM_CLASS}
            >
              <MenuIcon kind="hide" /> Скрыть
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MenuSeparator() {
  return <div role="separator" className="mx-1 my-1 h-px bg-border" />;
}

function MenuIcon({ kind }: { kind: 'up' | 'down' | 'edit' | 'hide' | 'drag' | 'expand' | 'home' }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-3.5 w-3.5 shrink-0"
      aria-hidden="true"
    >
      {kind === 'expand' && <path d="M5 11 11 5M6.5 5H11v4.5" />}
      {kind === 'home' && (
        <>
          <path d="m2 7 6-5 6 5" />
          <path d="M3.5 6.2V14h9V6.2" />
          <path d="M6.5 14v-4h3v4" />
        </>
      )}
      {kind === 'up' && <path d="m4 10 4-4 4 4" />}
      {kind === 'down' && <path d="m4 6 4 4 4-4" />}
      {kind === 'drag' && (
        <>
          <path d="M8 2v12M2 8h12" />
          <path d="m6 3.5 2-2 2 2M6 12.5l2 2 2-2M3.5 6l-2 2 2 2M12.5 6l2 2-2 2" />
        </>
      )}
      {kind === 'edit' && <path d="M11.5 2.5a1.8 1.8 0 0 1 2.5 2.5L5.5 13.5l-3 .5.5-3z" />}
      {kind === 'hide' && (
        <>
          <path d="M2 2l12 12" />
          <path d="M6.5 3.8A6.5 6.5 0 0 1 14 8s-.7 1.3-2 2.4M4 5.6C2.7 6.7 2 8 2 8a6.9 6.9 0 0 0 7.5 4.2" />
        </>
      )}
    </svg>
  );
}
