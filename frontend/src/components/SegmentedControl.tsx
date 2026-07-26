import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** One mutually-exclusive option of a {@link SegmentedControl}. */
export interface SegmentedOption<T extends string> {
  value: T;
  /** Visible content — a short text label or an icon. */
  content: ReactNode;
  /** Explicit accessible name when `content` is icon-only (e.g. «Тип графика: Столбцы»). */
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
}

type SegmentedGrouping =
  | {
      /** Names the `role="group"` track. */
      ariaLabel: string;
      groupless?: false;
    }
  | {
      /** Use only when a labelled group already encloses this track and its adjacent controls. */
      groupless: true;
      ariaLabel?: never;
    };

interface SegmentedControlBaseProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  /** Extra classes on the track container. */
  className?: string;
  /** Extra classes on every segment button — the place to tune padding / touch height. */
  segmentClassName?: string;
  /** Segment text size + default padding. `sm` = the compact per-card look. */
  size?: 'sm' | 'md';
}

type SegmentedControlProps<T extends string> = SegmentedControlBaseProps<T> & SegmentedGrouping;

/**
 * The one shared segmented-selection primitive: a quiet pill track with a single sliding indicator
 * (the «glider») that travels to the selected segment. Segments are equal-width by construction
 * (a CSS grid of `1fr` columns), so the glider is one column wide and moves in whole-column steps.
 *
 * Semantics stay explicit: each segment is a real `<button aria-pressed>` and there are NO hidden
 * native radio inputs. Every button carries its own explicit focus-visible ring above the glider.
 * Motion is token-driven (`--motion-base` / `--ease-standard`), so the global reduced-motion net
 * collapses the slide automatically. When `value` matches no option the glider hides (used by the
 * period controls, where a picked custom range deselects every preset).
 *
 * Keyboard: the track is ONE tab stop, not one per segment. A roving tabindex keeps the selected
 * segment focusable and ←/→ (plus Home/End) move between them, wrapping at the ends — a seven-preset
 * track used to cost seven Tab presses to walk past. That is why the track is a `toolbar` rather
 * than a plain group: roving tabindex is only discoverable if the container announces a pattern
 * where arrows are expected. Arrows move FOCUS only; Space/Enter commits, so tabbing through a form
 * cannot silently change a filter.
 *
 * Disabled segments use `aria-disabled`, not the native attribute. A natively disabled button is
 * unfocusable — in a roving track that leaves a hole the arrows skip over, and worse, it swallows
 * the `title` explaining WHY the option is unavailable (disabled elements fire no mouse events).
 * This way the segment stays reachable and self-explaining; activation is blocked in the handler.
 */
export function SegmentedControl<T extends string>({
  ariaLabel,
  value,
  onChange,
  options,
  className,
  segmentClassName,
  size = 'md',
  groupless = false,
}: SegmentedControlProps<T>) {
  const trackRef = useRef<HTMLDivElement>(null);
  const count = options.length;
  const activeIndex = options.findIndex((opt) => opt.value === value);
  // Каретка roving-tabindex. Держим ИНДЕКС, а не значение: у периодных треков value может не
  // совпадать ни с одним сегментом (выбран свой диапазон → глайдер скрыт), и тогда фокусируемым
  // должен остаться хоть кто-то, иначе в трек нельзя войти с клавиатуры вообще.
  const [caret, setCaret] = useState(() => (activeIndex >= 0 ? activeIndex : 0));
  const focusIndex = Math.min(caret, Math.max(0, count - 1));

  // A value change from outside the track (URL state, reset, another synchronized control) moves
  // the single tab stop to the newly selected answer. Arrow navigation does not change `value`, so
  // it is deliberately free to keep moving `caret` across several segments between commits.
  useEffect(() => {
    setCaret((current) => (
      activeIndex >= 0
        ? activeIndex
        : Math.min(current, Math.max(0, count - 1))
    ));
  }, [activeIndex, count]);

  /** Двигает фокус по треку с заворотом; отключённые сегменты НЕ пропускаем — они несут title,
      объясняющий недоступность, и должны быть достижимы. */
  const moveCaret = (next: number) => {
    if (count === 0) return;
    const wrapped = ((next % count) + count) % count;
    setCaret(wrapped);
    trackRef.current
      ?.querySelector<HTMLButtonElement>(`[data-segment-index="${wrapped}"]`)
      ?.focus();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    switch (event.key) {
      case 'ArrowLeft': moveCaret(focusIndex - 1); break;
      case 'ArrowRight': moveCaret(focusIndex + 1); break;
      case 'Home': moveCaret(0); break;
      case 'End': moveCaret(count - 1); break;
      default: return;
    }
    event.preventDefault();
  };

  // No options → nothing mutually-exclusive to pick, and the glider width `100% / count` would
  // divide by zero. Render nothing rather than an empty, malformed track.
  if (count === 0) return null;
  const sizePad = size === 'sm' ? 'px-2 py-1 text-2xs' : 'px-2.5 py-1 text-xs';

  // The glider is one grid-column wide and slides in whole-column steps. Both the width and the
  // travel are expressed against the track's own padded box via CSS custom properties, so the maths
  // has one source of truth and stays type-safe (numbers only).
  const gliderStyle: CSSProperties = {
    width: `calc((100% - 0.25rem) / ${count})`,
    transform: `translateX(calc(${activeIndex < 0 ? 0 : activeIndex} * 100%))`,
    opacity: activeIndex < 0 ? 0 : 1,
    transition:
      'transform var(--motion-base) var(--ease-standard), opacity var(--motion-fast) var(--ease-standard)',
  };

  return (
    <div
      ref={trackRef}
      data-segmented-control
      // `toolbar` even when groupless: the enclosing surface owns the visible LABEL, but the roving
      // tabindex still needs a container that announces «arrows work here».
      role="toolbar"
      aria-orientation="horizontal"
      aria-label={groupless ? undefined : ariaLabel}
      className={cn('relative inline-grid rounded-full border border-border p-0.5', className)}
      style={{ gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))` }}
    >
      <span
        data-segmented-indicator
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0.5 left-0.5 rounded-full bg-secondary"
        style={gliderStyle}
      />
      {options.map((opt, index) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            data-mobile-touch-target=""
            data-segment-index={index}
            aria-pressed={active}
            aria-label={opt.ariaLabel}
            title={opt.title}
            // aria-disabled, не disabled: см. докстроку — иначе сегмент выпадает из обхода стрелками
            // и молча съедает собственный title.
            aria-disabled={opt.disabled || undefined}
            tabIndex={index === focusIndex ? 0 : -1}
            onFocus={() => setCaret(index)}
            onKeyDown={handleKeyDown}
            onClick={() => {
              if (opt.disabled) return;
              onChange(opt.value);
            }}
            className={cn(
              'relative z-10 inline-flex min-h-11 min-w-11 items-center justify-center rounded-full font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40 sm:min-h-0 sm:min-w-0',
              sizePad,
              opt.disabled
                ? 'cursor-default opacity-40'
                : active
                  ? 'text-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              segmentClassName,
            )}
          >
            {opt.content}
          </button>
        );
      })}
    </div>
  );
}
