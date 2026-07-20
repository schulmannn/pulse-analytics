import type { ReactNode } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';

export interface PillSelectOption<T extends string = string> {
  value: T;
  label: string;
  disabled?: boolean;
  /** Optional secondary line shown under the label inside the popup. */
  description?: string;
}

export interface PillSelectProps<T extends string = string> {
  value: T;
  options: PillSelectOption<T>[];
  onValueChange: (value: T) => void;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  testId?: string;
  id?: string;
}

const EMPTY_VALUE = '__pulse_pill_select_empty__';
const encodeValue = (value: string) => (value === '' ? EMPTY_VALUE : value);
const decodeValue = (value: string) => (value === EMPTY_VALUE ? '' : value);

/**
 * Pulse's compact select API, now composed from the shadcn/Radix Select primitive. Radix owns
 * keyboard navigation, type-ahead, focus return, collision-aware portal placement and disabled
 * option semantics; this wrapper preserves the existing generic call sites and pill styling.
 */
export function PillSelect<T extends string = string>({
  value,
  options,
  onValueChange,
  ariaLabel,
  placeholder = 'Выбрать',
  disabled = false,
  className,
  contentClassName,
  testId,
  id,
}: PillSelectProps<T>) {
  const selected = options.find((option) => option.value === value);

  return (
    <Select
      value={selected ? encodeValue(value) : ''}
      onValueChange={(next) => onValueChange(decodeValue(next) as T)}
      disabled={disabled}
    >
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        data-testid={testId}
        data-value={value}
        className={cn('max-w-full', className)}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent align="start" aria-label={ariaLabel} className={contentClassName}>
        {options.map((option) => (
          <SelectItem
            key={option.value || EMPTY_VALUE}
            value={encodeValue(option.value)}
            disabled={option.disabled}
            data-value={option.value}
          >
            <span className="block min-w-0">
              <span className="block truncate">{option.label}</span>
              {option.description && (
                <span className="mt-0.5 block truncate text-2xs font-normal text-muted-foreground">
                  {option.description}
                </span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Convenience: a label + compact select row matching the inline-filter idiom. */
export function PillSelectField({
  label,
  children,
}: {
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0">{label}</span>
      {children}
    </div>
  );
}
