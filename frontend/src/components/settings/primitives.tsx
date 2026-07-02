import type { ReactNode, SVGProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * Shared building blocks for the settings dialog ("Refined Technical"):
 * a settings GROUP is the sanctioned bordered form container (rounded border + divide-y rows),
 * a ROW is title + muted description on the left and the control on the right.
 * Depth stays in hairlines — no shadows, no card chrome.
 */

/** Small group heading (text-sm medium + trailing hairline) above a bordered row container. */
export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-3 text-sm font-medium text-foreground">
        <span className="whitespace-nowrap">{title}</span>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </h3>
      <div className="divide-y divide-border rounded border border-border">{children}</div>
    </section>
  );
}

interface SettingsRowProps {
  title: ReactNode;
  /** Muted xs description under the title (calm, generous line-height). */
  description?: ReactNode;
  /** Right-aligned control (button / segmented / input); wraps under the text on mobile. */
  control?: ReactNode;
  /** Optional full-width content below the title/control line (errors, expanded panels). */
  footer?: ReactNode;
  className?: string;
}

/** One setting row: title (sm, medium) + desc (xs, ink3) left, control right; stacks on mobile. */
export function SettingsRow({ title, description, control, footer, className }: SettingsRowProps) {
  return (
    <div className={cn('px-4 py-3.5', className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{title}</div>
          {description ? (
            <div className="mt-0.5 max-w-[46ch] text-xs leading-relaxed text-ink3">{description}</div>
          ) : null}
        </div>
        {control ? <div className="flex shrink-0 flex-wrap items-center gap-2">{control}</div> : null}
      </div>
      {footer}
    </div>
  );
}

// Shared control styles (mirror the app's existing secondary / destructive outline buttons).
export const BTN_SECONDARY =
  'rounded border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50';
export const BTN_DESTRUCTIVE =
  'rounded border border-destructive/20 bg-background px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/5 disabled:opacity-50';

/** Lean stroke-only glyphs for the settings nav (local — the shell's nav-icons set stays untouched). */
const PATHS = {
  user: ['M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2', 'M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z'],
  database: [
    'M12 8c4.97 0 9-1.34 9-3s-4.03-3-9-3-9 1.34-9 3 4.03 3 9 3z',
    'M21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3',
    'M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5',
  ],
  signal: [
    'M4.9 19.1a10 10 0 0 1 0-14.2',
    'M7.8 16.2a6 6 0 0 1 0-8.4',
    'M12 12h.01',
    'M16.2 16.2a6 6 0 0 0 0-8.4',
    'M19.1 19.1a10 10 0 0 0 0-14.2',
  ],
  instagram: [
    'M8 3.5h8A4.5 4.5 0 0 1 20.5 8v8a4.5 4.5 0 0 1-4.5 4.5H8A4.5 4.5 0 0 1 3.5 16V8A4.5 4.5 0 0 1 8 3.5z',
    'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z',
    'M17.2 6.8h.01',
  ],
  shield: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'],
  external: ['M7 17 17 7', 'M9 7h8v8'],
  close: ['M18 6 6 18', 'M6 6l12 12'],
  arrow: ['m9 6 6 6-6 6'],
} as const;

export type SettingsIconName = keyof typeof PATHS;

export function SettingsIcon({ name, ...props }: { name: SettingsIconName } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {PATHS[name].map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}
