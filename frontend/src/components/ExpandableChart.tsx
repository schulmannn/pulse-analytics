import { useEffect, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface ExpandableChartProps {
  title: string;
  children: ReactNode;
  renderExpanded?: (days: number) => ReactNode;
}

const WINDOWS = [
  { days: 30, label: '1М' },
  { days: 90, label: '3М' },
  { days: 180, label: '6М' },
  { days: 0, label: 'Всё' },
];

export function ExpandableChart({ title, children, renderExpanded }: ExpandableChartProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [days, setDays] = useState(90);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setIsOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen]);

  const handlePreviewKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      setIsOpen(true);
    }
  };

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        aria-label={`Развернуть график: ${title}`}
        onClick={() => setIsOpen(true)}
        onKeyDown={handlePreviewKeyDown}
        className="group relative cursor-zoom-in rounded focus-visible:ring-inset focus-visible:ring-offset-0"
      >
        {children}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-1 top-1 text-xs text-muted-foreground opacity-60 transition-opacity group-hover:opacity-100"
        >
          ⤢
        </span>
      </div>

      {isOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
          onClick={() => setIsOpen(false)}
        >
          <Card
            className="relative max-h-[90vh] w-full max-w-5xl overflow-y-auto shadow-xl"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="absolute right-4 top-4 rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              aria-label="Закрыть"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            <CardHeader className="pr-12">
              <CardTitle className="text-base font-semibold text-foreground">{title}</CardTitle>
              {renderExpanded && (
                <div className="flex flex-wrap pt-2">
                  {WINDOWS.map((window) => (
                    <button
                      key={window.days}
                      type="button"
                      onClick={() => setDays(window.days)}
                      className={`whitespace-nowrap border-b-2 px-3 py-2 text-xs font-medium transition-colors ${
                        days === window.days
                          ? 'border-primary text-foreground'
                          : 'border-transparent text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {window.label}
                    </button>
                  ))}
                </div>
              )}
            </CardHeader>
            <CardContent>
              <div className="min-h-[280px] w-full [&_svg]:min-h-[280px]">
                {renderExpanded ? renderExpanded(days) : children}
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </>
  );
}
