import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';

/**
 * PillSelect — the one dependency-free, accessible listbox that replaces every native `<select>`
 * on desktop/shared surfaces (the native popup read cheap + square on dark; owner report on the
 * campaign source filter). The closed trigger is a compact fully-oval pill (rounded-full) with a
 * chevron and a stable width; the popup is a floating dark card of individually-rounded rows, the
 * selected row carrying a quiet accent + checkmark (no random colours — only tokens).
 *
 * ARIA: implements the WAI-ARIA APG select-only combobox pattern — focus stays on the trigger
 * (`role="combobox"`, `aria-expanded`, `aria-controls`, `aria-activedescendant`) while the popup is
 * a `role="listbox"` of `role="option"` rows with `aria-selected`. Keyboard: Enter/Space/↓/↑ open;
 * ↑/↓/Home/End move the active option; Enter/Space select; Escape closes + restores trigger focus;
 * Tab closes and lets focus move on naturally. Outside-click and scroll/resize reposition/close are
 * handled here; disabled options are skipped by keyboard and long labels truncate.
 */
export interface PillSelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
  /** Optional secondary line shown under the label inside the popup (never in the closed trigger). */
  description?: string;
}

export interface PillSelectProps<T extends string = string> {
  value: T;
  options: PillSelectOption<T>[];
  onValueChange: (value: T) => void;
  /** Accessible name for the control (required — there is no visible <label> wiring by default). */
  ariaLabel: string;
  /** Shown in the trigger when `value` matches no option (e.g. an unset filter). */
  placeholder?: string;
  disabled?: boolean;
  /** Extra classes on the trigger — the caller owns width (min-w/max-w) for a stable footprint. */
  className?: string;
  testId?: string;
  id?: string;
}

const CHEVRON = (
  <svg
    aria-hidden="true"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="ml-1 size-3.5 shrink-0 text-muted-foreground"
  >
    <path d="m4 6 4 4 4-4" />
  </svg>
);

const CHECK = (
  <svg
    aria-hidden="true"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    className="size-3.5 shrink-0 text-primary"
  >
    <path d="m3.5 8.5 3 3 6-7" />
  </svg>
);

/** Nearest enabled option index in `dir` from `start` (inclusive of start). Returns -1 if none. */
function nextEnabled<T extends string>(options: PillSelectOption<T>[], start: number, dir: 1 | -1): number {
  for (let i = start; i >= 0 && i < options.length; i += dir) {
    if (!options[i]?.disabled) return i;
  }
  return -1;
}

export function PillSelect<T extends string = string>({
  value,
  options,
  onValueChange,
  ariaLabel,
  placeholder = 'Выбрать',
  disabled = false,
  className,
  testId,
  id,
}: PillSelectProps<T>) {
  const reactId = useId().replace(/:/g, '');
  const baseId = id ?? `ps${reactId}`;
  const listboxId = `${baseId}-listbox`;
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const selectedIndex = options.findIndex((o) => o.value === value);
  const [activeIndex, setActiveIndex] = useState<number>(selectedIndex);
  const [pos, setPos] = useState<{ top: number; left: number; width: number; placement: 'below' | 'above' } | null>(null);

  const selected = selectedIndex >= 0 ? options[selectedIndex] : null;
  const popupLayer = triggerRef.current?.closest('[role="dialog"][aria-modal="true"]')
    ? 'z-modal-popover'
    : 'z-popover';

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // Rough popup height budget → flip above when the row would spill past the viewport bottom.
    const estimated = Math.min(options.length * 40 + 12, 320);
    const below = window.innerHeight - rect.bottom;
    const placement = below < estimated && rect.top > below ? 'above' : 'below';
    const width = Math.min(Math.max(rect.width, 160), window.innerWidth - 16);
    setPos({
      top: placement === 'below' ? rect.bottom + 4 : rect.top - 4,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      width,
      placement,
    });
  }, [options.length]);

  const openMenu = useCallback(
    (active: number) => {
      if (disabled) return;
      reposition();
      setActiveIndex(active >= 0 && !options[active]?.disabled ? active : nextEnabled(options, 0, 1));
      setOpen(true);
    },
    [disabled, options, reposition],
  );

  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    setPos(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  const commit = useCallback(
    (index: number) => {
      const opt = options[index];
      if (!opt || opt.disabled) return;
      if (opt.value !== value) onValueChange(opt.value);
      close();
    },
    [close, onValueChange, options, value],
  );

  // Keep the active row in view + re-sync when the popup opens or the selection changes underneath.
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    const active = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [open, activeIndex, reposition]);

  // Outside-click + scroll/resize while open. Reposition on scroll (a filter can live in a scroller).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t) || listRef.current?.contains(t)) return;
      close(false);
    };
    const onScroll = () => reposition();
    const onResize = () => reposition();
    document.addEventListener('mousedown', onDown, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, close, reposition]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        openMenu(selectedIndex);
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        const next = nextEnabled(options, Math.min(activeIndex + 1, options.length - 1), 1);
        if (next >= 0) setActiveIndex(next);
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        const prev = nextEnabled(options, Math.max(activeIndex - 1, 0), -1);
        if (prev >= 0) setActiveIndex(prev);
        break;
      }
      case 'Home': {
        e.preventDefault();
        const first = nextEnabled(options, 0, 1);
        if (first >= 0) setActiveIndex(first);
        break;
      }
      case 'End': {
        e.preventDefault();
        const last = nextEnabled(options, options.length - 1, -1);
        if (last >= 0) setActiveIndex(last);
        break;
      }
      case 'Enter':
      case ' ':
      case 'Spacebar': {
        e.preventDefault();
        commit(activeIndex);
        break;
      }
      case 'Escape': {
        e.preventDefault();
        close();
        break;
      }
      case 'Tab': {
        // Let focus move on naturally (Tab from the trigger), just drop the popup.
        close(false);
        break;
      }
      default:
        break;
    }
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        id={baseId}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-label={ariaLabel}
        aria-disabled={disabled || undefined}
        disabled={disabled}
        data-testid={testId}
        data-value={value}
        onClick={() => (open ? close(false) : openMenu(selectedIndex))}
        onKeyDown={onKeyDown}
        className={cn(
          'inline-flex h-8 max-w-full items-center justify-between gap-1 rounded-full border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors',
          'outline-none hover:bg-muted focus-visible:ring-1 focus-visible:ring-primary',
          disabled && 'cursor-not-allowed opacity-50 hover:bg-background',
          className,
        )}
      >
        <span className={cn('truncate', !selected && 'text-muted-foreground')}>
          {selected ? selected.label : placeholder}
        </span>
        {CHEVRON}
      </button>
      {open && pos
        ? createPortal(
            <ul
              ref={listRef}
              id={listboxId}
              role="listbox"
              aria-label={ariaLabel}
              aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
              className={cn(
                'fixed max-h-[min(320px,60vh)] min-w-[8rem] overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-[0_12px_32px_rgba(0,0,0,0.22)] dark:border-white/10 dark:shadow-[0_14px_36px_rgba(0,0,0,0.48)]',
                popupLayer,
              )}
              style={{
                top: pos.placement === 'below' ? pos.top : undefined,
                bottom: pos.placement === 'above' ? window.innerHeight - pos.top : undefined,
                left: pos.left,
                width: pos.width,
              }}
            >
              {options.map((o, i) => {
                const isSelected = o.value === value;
                const isActive = i === activeIndex;
                return (
                  <li key={o.value} role="none">
                    <button
                      type="button"
                      role="option"
                      id={optionId(i)}
                      aria-selected={isSelected}
                      aria-disabled={o.disabled || undefined}
                      data-value={o.value}
                      data-active={isActive}
                      tabIndex={-1}
                      onClick={() => commit(i)}
                      onMouseMove={() => !o.disabled && setActiveIndex(i)}
                      className={cn(
                        'flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-xs transition-colors',
                        o.disabled
                          ? 'cursor-not-allowed text-muted-foreground/60'
                          : isSelected
                            ? 'bg-primary/10 text-foreground'
                            : isActive
                              ? 'bg-muted text-foreground'
                              : 'text-muted-foreground',
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span className={cn('block truncate', isSelected && 'font-medium')}>{o.label}</span>
                        {o.description && (
                          <span className="mt-0.5 block truncate text-2xs text-muted-foreground">{o.description}</span>
                        )}
                      </span>
                      {isSelected ? CHECK : <span aria-hidden="true" className="size-3.5 shrink-0" />}
                    </button>
                  </li>
                );
              })}
            </ul>,
            document.body,
          )
        : null}
    </>
  );
}

/** Convenience: a label + PillSelect row matching the inline-filter idiom (caption text + control). */
export function PillSelectField({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0">{label}</span>
      {children}
    </div>
  );
}
