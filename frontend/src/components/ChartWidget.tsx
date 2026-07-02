import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

/**
 * Widget shell for charts (steep Home): a quiet card surface that separates each chart from
 * the canvas, with a per-widget «⋯» menu — accent colour (chart-token swatches) and a tinted
 * background, persisted per widget in localStorage. The accent works by scoping the
 * `--brand-iris` CSS var over the widget subtree, so every chart primitive (LineChart /
 * BarChart / Sparkline / Breakdown) recolours without prop plumbing.
 *
 * This intentionally supersedes the flat hairline section for CHARTS (owner call, steep
 * pattern); KPI ledgers and tables stay open on the paper canvas.
 */

const PREFS_KEY = 'pulse_widget_prefs';

interface WidgetPrefs {
  /** chart token index 1..6; undefined = brand accent */
  color?: number;
  /** tinted card background in the accent colour */
  tinted?: boolean;
}

function loadAllPrefs(): Record<string, WidgetPrefs> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, WidgetPrefs>) : {};
  } catch {
    return {};
  }
}

function savePrefs(id: string, prefs: WidgetPrefs) {
  try {
    const all = loadAllPrefs();
    if (!prefs.color && !prefs.tinted) delete all[id];
    else all[id] = prefs;
    localStorage.setItem(PREFS_KEY, JSON.stringify(all));
  } catch {
    /* storage blocked — customisation is a nicety */
  }
}

const SWATCHES = [1, 2, 3, 4, 5, 6] as const;

interface ChartSectionProps {
  /** Stable widget id for the prefs store; defaults to the title. */
  id?: string;
  title: string;
  /** Extra header controls (e.g. the chart-type switcher) between the title and the menu. */
  action?: ReactNode;
  children: ReactNode;
}

export function ChartSection({ id, title, action, children }: ChartSectionProps) {
  const widgetId = id ?? title;
  const [prefs, setPrefs] = useState<WidgetPrefs>(() => loadAllPrefs()[widgetId] ?? {});
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const update = (next: WidgetPrefs) => {
    setPrefs(next);
    savePrefs(widgetId, next);
  };

  const accentVar = prefs.color ? `--chart-${prefs.color}` : '--brand-iris';
  const style: CSSProperties = {};
  if (prefs.color) (style as Record<string, string>)['--brand-iris'] = `var(--chart-${prefs.color})`;
  if (prefs.tinted) style.backgroundColor = `hsl(var(${accentVar}) / 0.07)`;

  return (
    <section className="rounded-xl border border-border bg-card p-4 sm:p-5" style={style}>
      <div className="flex items-center gap-3">
        <h3 className="min-w-0 flex-1 truncate text-xs font-medium tracking-wider text-muted-foreground">
          {title}
        </h3>
        {action}
        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            aria-label={`Настройки виджета «${title}»`}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="h-4 w-4" aria-hidden="true">
              <circle cx="3.5" cy="8" r="1.25" />
              <circle cx="8" cy="8" r="1.25" />
              <circle cx="12.5" cy="8" r="1.25" />
            </svg>
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full z-20 mt-1 w-56 rounded-lg border border-border bg-card p-3">
              <div className="text-2xs tracking-wide text-muted-foreground">Акцент</div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  aria-label="Стандартный акцент"
                  aria-pressed={!prefs.color}
                  onClick={() => update({ ...prefs, color: undefined })}
                  className={`h-4 w-4 rounded-full transition-shadow ${!prefs.color ? 'ring-2 ring-foreground/50 ring-offset-2 ring-offset-card' : ''}`}
                  style={{ backgroundColor: 'hsl(var(--primary))' }}
                />
                {SWATCHES.map((n) => (
                  <button
                    key={n}
                    type="button"
                    aria-label={`Акцент ${n}`}
                    aria-pressed={prefs.color === n}
                    onClick={() => update({ ...prefs, color: n })}
                    className={`h-4 w-4 rounded-full transition-shadow ${prefs.color === n ? 'ring-2 ring-foreground/50 ring-offset-2 ring-offset-card' : ''}`}
                    style={{ backgroundColor: `hsl(var(--chart-${n}))` }}
                  />
                ))}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={!!prefs.tinted}
                onClick={() => update({ ...prefs, tinted: !prefs.tinted })}
                className="mt-3 flex w-full items-center justify-between gap-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <span>Цветной фон</span>
                <span
                  aria-hidden="true"
                  className={
                    prefs.tinted
                      ? 'rounded-full border border-primary/40 bg-primary/10 px-2 py-0.5 text-2xs font-medium text-primary'
                      : 'rounded-full border border-border px-2 py-0.5 text-2xs font-medium text-muted-foreground'
                  }
                >
                  {prefs.tinted ? 'вкл' : 'выкл'}
                </span>
              </button>
              {(prefs.color || prefs.tinted) && (
                <button
                  type="button"
                  onClick={() => {
                    update({});
                    setMenuOpen(false);
                  }}
                  className="mt-3 w-full border-t border-border pt-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  Сбросить настройки
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}
