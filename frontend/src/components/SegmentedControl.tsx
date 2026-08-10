import type { KeyboardEvent, ReactNode } from 'react';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

/** One mutually-exclusive option of a {@link SegmentedControl}. */
export interface SegmentedOption<T extends string> {
  value: T;
  /** Visible content — a short text label or an icon. */
  content: ReactNode;
  /** Explicit accessible name when `content` is icon-only. */
  ariaLabel?: string;
  title?: string;
  disabled?: boolean;
}

type SegmentedGrouping =
  | {
      /** Names the choice group. */
      ariaLabel: string;
      groupless?: false;
    }
  | {
      /** Use only when a labelled group already encloses this control and its adjacent controls. */
      groupless: true;
      ariaLabel?: never;
    };

interface SegmentedControlBaseProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: SegmentedOption<T>[];
  /** Extra classes on the group container. */
  className?: string;
  /** Extra classes on every option — the place to tune padding or touch height. */
  segmentClassName?: string;
  /** `sm` is the compact per-card treatment; `md` is the regular toolbar treatment. */
  size?: 'sm' | 'md';
  /** Limits the number of equal-width columns and lets long option sets wrap into rows. */
  columns?: number;
}

type SegmentedControlProps<T extends string> = SegmentedControlBaseProps<T> & SegmentedGrouping;

/**
 * Shared mutually-exclusive choice control, composed from the official shadcn/Radix ToggleGroup.
 * Radix owns roving focus, arrow/Home/End navigation and pressed-state semantics. The wrapper keeps
 * Pulse's generic option API, equal-width columns, mobile hit areas and the intentional no-selection
 * state used while a custom date range is active.
 *
 * A disabled option remains reachable so its `title` can explain why it is unavailable. Activation
 * is blocked here instead of using the native disabled attribute, which would remove it from Radix's
 * arrow-key sequence.
 */
export function SegmentedControl<T extends string>({
  ariaLabel,
  value,
  onChange,
  options,
  className,
  segmentClassName,
  size = 'md',
  columns,
  groupless = false,
}: SegmentedControlProps<T>) {
  if (options.length === 0) return null;

  const handleValueChange = (nextValues: string[]) => {
    const nextValue = nextValues.find((candidate) => candidate !== value);
    if (!nextValue) return;
    const nextOption = options.find((option) => option.value === nextValue);
    if (!nextOption || nextOption.disabled) return;
    onChange(nextValue as T);
  };

  const blockDisabledActivation = (
    event: KeyboardEvent<HTMLButtonElement>,
    disabled?: boolean,
  ) => {
    if (!disabled || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <ToggleGroup
      type="multiple"
      value={value ? [value] : []}
      onValueChange={handleValueChange}
      orientation="horizontal"
      loop
      role="toolbar"
      aria-orientation="horizontal"
      aria-label={groupless ? undefined : ariaLabel}
      data-slot="toggle-group"
      data-segmented-control=""
      className={cn(
        'inline-grid w-auto items-center gap-px rounded-full border border-input bg-border p-px',
        className,
      )}
      style={{ gridTemplateColumns: `repeat(${Math.min(columns ?? options.length, options.length)}, minmax(0, 1fr))` }}
    >
      {options.map((option, index) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          data-slot="toggle-group-item"
          data-mobile-touch-target=""
          data-segment-index={index}
          aria-label={option.ariaLabel}
          aria-disabled={option.disabled || undefined}
          title={option.title}
          onKeyDown={(event) => blockDisabledActivation(event, option.disabled)}
          onClick={(event) => {
            if (!option.disabled) return;
            event.preventDefault();
            event.stopPropagation();
          }}
          className={cn(
            'inline-flex h-9 w-full min-h-11 min-w-11 shrink-0 items-center justify-center whitespace-nowrap rounded-full bg-background px-3 font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50 sm:min-h-0 sm:min-w-0 data-[state=on]:bg-accent data-[state=on]:text-accent-foreground',
            size === 'sm' ? 'h-7 px-2 text-2xs' : 'text-xs',
            option.disabled ? 'cursor-default opacity-40' : 'hover:text-foreground',
            segmentClassName,
          )}
        >
          {option.content}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
