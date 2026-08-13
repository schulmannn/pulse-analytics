import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface SnippetProps {
  value: string;
  label?: ReactNode;
  tone?: 'default' | 'warn';
  multiline?: boolean;
  copyLabel?: string;
  copiedLabel?: string;
  className?: string;
}

/**
 * Shared copy surface for tokens, URLs and command blocks. The action stays in normal flex flow, so
 * long values never run underneath an absolutely-positioned button on narrow screens.
 */
export function Snippet({
  value,
  label,
  tone = 'default',
  multiline = false,
  copyLabel = 'Копировать',
  copiedLabel = 'Скопировано',
  className,
}: SnippetProps) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current != null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  const copy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      if (resetTimer.current != null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 2_000);
    });
  };

  return (
    <>
      <div
        role={tone === 'warn' ? 'status' : undefined}
        className={cn(
          'overflow-hidden rounded border bg-muted/60',
          tone === 'warn' ? 'border-status-warn/40' : 'border-border',
          className,
        )}
      >
        {label ? (
          <div
            className={cn(
              'border-b px-3 py-2 text-xs font-medium',
              tone === 'warn'
                ? 'border-status-warn/25 text-status-warn'
                : 'border-border text-foreground',
            )}
          >
            {label}
          </div>
        ) : null}
        <div className="flex min-w-0 items-start gap-2 p-2">
          {multiline ? (
            <pre className="min-w-0 flex-1 whitespace-pre-wrap break-all px-1 py-1.5 font-mono text-xs leading-relaxed text-foreground">
              {value}
            </pre>
          ) : (
            <code className="min-w-0 flex-1 select-all break-all px-1 py-1.5 font-mono text-xs leading-relaxed text-foreground">
              {value}
            </code>
          )}
          <Button
            type="button"
            variant="secondary"
            size="xs"
            onClick={copy}
            className="shrink-0 bg-background px-2 font-sans text-2xs"
          >
            {copied ? copiedLabel : copyLabel}
          </Button>
        </div>
      </div>
      <span role="status" className="sr-only">
        {copied ? copiedLabel : ''}
      </span>
    </>
  );
}
