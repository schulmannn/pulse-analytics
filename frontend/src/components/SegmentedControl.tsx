import type { CSSProperties, ReactNode } from 'react';
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
 * Semantics stay explicit: each segment is a real `<button aria-pressed>`, the track is a labelled
 * `role="group"`, and there are NO hidden native radio inputs. Every button carries its own explicit
 * focus-visible ring above the glider; disabled segments stay natively inert.
 * Motion is token-driven (`--motion-base` / `--ease-standard`), so the global reduced-motion net
 * collapses the slide automatically. When `value` matches no option the glider hides (used by the
 * period controls, where a picked custom range deselects every preset).
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
  const count = options.length;
  // No options → nothing mutually-exclusive to pick, and the glider width `100% / count` would
  // divide by zero. Render nothing rather than an empty, malformed track.
  if (count === 0) return null;
  const activeIndex = options.findIndex((opt) => opt.value === value);
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
      data-segmented-control
      role={groupless ? undefined : 'group'}
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
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            aria-label={opt.ariaLabel}
            title={opt.title}
            disabled={opt.disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              'relative z-10 inline-flex items-center justify-center rounded-full font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:pointer-events-none disabled:opacity-40',
              sizePad,
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
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
