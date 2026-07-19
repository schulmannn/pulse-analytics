import type { ReactNode } from 'react';
import { ICON_BUTTON_CLASS } from './constants';
import { WidgetMenu } from './WidgetMenu';
import type { WidgetMenuProps } from './WidgetMenu';

interface PresenceState {
  mounted: boolean;
  exiting: boolean;
}

interface WidgetHeaderProps {
  label: string;
  action?: ReactNode;
  strip: boolean;
  reorder: boolean;
  allowExpand: boolean;
  homeKey?: string;
  removePresence: PresenceState;
  onRemove: () => void;
  onExpand: () => void;
  menu: Omit<WidgetMenuProps, 'homeKey'>;
}

export function WidgetHeader({
  label,
  action,
  strip,
  reorder,
  allowExpand,
  homeKey,
  removePresence,
  onRemove,
  onExpand,
  menu,
}: WidgetHeaderProps) {
  return (
    <div className={strip && !reorder ? 'absolute -top-1 right-0 z-10 flex items-center' : 'flex shrink-0 items-center gap-3'}>
      <h3
        title={label}
        className={strip && !reorder ? 'sr-only' : 'widget-title min-w-0 flex-1 truncate text-sm font-medium tracking-tight text-foreground'}
      >
        {label}
      </h3>
      {action}
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
          title="Развернуть"
          onClick={onExpand}
          className={`${ICON_BUTTON_CLASS} hover:text-foreground print:hidden ${
            removePresence.mounted ? 'hidden' : ''
          } ${reorder ? 'pointer-events-none invisible' : ''}`}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <path d="M7 17 17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      <WidgetMenu {...menu} homeKey={homeKey} />
    </div>
  );
}
