import * as React from 'react';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface SearchFieldProps {
  /** Controlled query string. */
  value: string;
  /** Fires with the next query on every keystroke and on clear (empty string). */
  onChange: (value: string) => void;
  /** Accessible name for the input — required (search boxes rarely carry a visible label). */
  ariaLabel: string;
  placeholder?: string;
  /** Width / layout classes for the wrapper (the input itself is always full-width inside). */
  className?: string;
  /** Russian accessible name for the clear button; shown only while the field is non-empty. */
  clearLabel?: string;
  testId?: string;
  id?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>;
}

/**
 * The one dashboard search box: a leading {@link Search} glyph, the canonical {@link Input} treatment
 * (height / radius / focus ring), and a trailing clear button that appears only while there is a query.
 * Presentational — the caller owns the value + setter (URL-synced query state stays where it lives).
 * One component so every content / report / mentions filter reads as the same control by construction.
 */
export function SearchField({
  value,
  onChange,
  ariaLabel,
  placeholder,
  className,
  clearLabel = 'Очистить поиск',
  testId,
  id,
  inputRef,
  onKeyDown,
}: SearchFieldProps) {
  const hasValue = value.length > 0;
  return (
    <div className={cn('relative', className)}>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        ref={inputRef}
        id={id}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel}
        data-testid={testId}
        // Hide WebKit's native × so it never doubles our own clear button.
        className={cn('pl-9 [&::-webkit-search-cancel-button]:appearance-none', hasValue && 'pr-9')}
      />
      {hasValue && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => onChange('')}
          aria-label={clearLabel}
          className="absolute right-1 top-1/2 size-7 -translate-y-1/2 [&_svg]:size-3.5"
        >
          <X aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
