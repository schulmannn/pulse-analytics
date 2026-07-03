import type { ReactNode, SVGProps } from 'react';
import { cn } from '@/lib/utils';

/**
 * Shared building blocks for the settings dialog ("Refined Technical"):
 * a settings GROUP is the sanctioned bordered form container (rounded border + divide-y rows),
 * a ROW is title + muted description on the left and the control on the right.
 * Depth stays in hairlines — no shadows, no card chrome.
 */

/**
 * Settings group — an OPEN hairline ledger (Claude/steep): optional small heading, then rows
 * separated by divide-y. No box around the group; with a heading, a top hairline opens the
 * ledger. Panes whose dialog header already names them skip the heading entirely.
 */
export function SettingsGroup({
  title,
  description,
  children,
}: {
  title?: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const hasHeading = Boolean(title || description);
  return (
    <section>
      {title ? <h3 className="text-sm font-medium text-foreground">{title}</h3> : null}
      {description ? <p className="mt-1 text-xs leading-relaxed text-ink3">{description}</p> : null}
      <div className={cn('divide-y divide-border', hasHeading && 'mt-3 border-t border-border')}>
        {children}
      </div>
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

/** One setting row: title (sm, medium) + desc (xs, ink3) left, control right (vertically
    centered against the text block, Claude-style); stacks on mobile. Open ledger — no inset. */
export function SettingsRow({ title, description, control, footer, className }: SettingsRowProps) {
  return (
    <div className={cn('py-4', className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
        <div className="min-w-0">
          <div className="text-sm font-medium text-foreground">{title}</div>
          {description ? (
            <div className="mt-0.5 max-w-[56ch] text-xs leading-relaxed text-ink3">{description}</div>
          ) : null}
        </div>
        {control ? <div className="flex shrink-0 flex-wrap items-center gap-2">{control}</div> : null}
      </div>
      {footer}
    </div>
  );
}

// Shared control styles — pill radius (chrome buttons follow btn-pill; inputs keep --radius).
export const BTN_SECONDARY =
  'btn-pill border border-border bg-background px-3.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50';
export const BTN_DESTRUCTIVE =
  'btn-pill border border-destructive/20 bg-background px-3.5 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/5 disabled:opacity-50';

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
  sun: ['M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10z', 'M12 1v2', 'M12 21v2', 'm4.2 4.2 1.4 1.4', 'm18.4 18.4 1.4 1.4', 'M1 12h2', 'M21 12h2', 'm4.2 19.8 1.4-1.4', 'm18.4 5.6 1.4-1.4'],
  moon: ['M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'],
  monitor: ['M4 4h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z', 'M8 21h8', 'M12 17v4'],
  lock: ['M6 11h12a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2z', 'M8 11V7a4 4 0 0 1 8 0v4'],
  card: ['M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', 'M2 10h20'],
  check: ['m5 12 5 5 9-10'],
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
