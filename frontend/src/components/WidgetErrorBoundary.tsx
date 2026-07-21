import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { reportWidgetError } from '@/lib/widgetErrors';

interface WidgetErrorBoundaryProps {
  children: ReactNode;
  /** Stable widget id (its ChartSection id) — logged with the crash so the failed card is identifiable. */
  widgetId?: string;
  /** Human label (the widget title) — shown in the fallback and logged for readable context. */
  label?: string;
  /**
   * 'inline' (default) — the boundary sits INSIDE a card's body (ChartSection already draws the card
   * chrome + ⋯ menu), so the fallback just fills the body region and the card stays usable (the user
   * can still Скрыть / Изменить the broken widget). 'card' — the boundary wraps a whole self-chromed
   * widget (a curated own-chrome card), so the fallback draws its own hairline card that fills the grid slot.
   */
  variant?: 'inline' | 'card';
  /** For variant='card': the crashed widget's footprint, so the fallback fills the same grid slot the
   *  widget owned (a 'full' own-chrome card like the heatmap must not collapse to a half tile).
   *  Defaults to 'half'. NOTE: a card fallback does not re-join the WidgetGroup, so it carries no
   *  reorder `order` — a crashed non-first card may sort ahead of its siblings until retried; that is
   *  acceptable in the already-degraded crash state and never affects the healthy grid. */
  size?: 'third' | 'half' | 'full';
  /** When any entry changes (by Object.is), a caught error is cleared and the children re-render — so
   *  editing / reconfiguring a broken widget recovers it without a manual retry. */
  resetKeys?: ReadonlyArray<unknown>;
}

interface WidgetErrorBoundaryState {
  /** null = healthy; 'pending' = caught, id not yet minted; else the report's trace id. */
  traceId: string | null;
}

function keysChanged(a?: ReadonlyArray<unknown>, b?: ReadonlyArray<unknown>): boolean {
  if (a === b) return false;
  if (!a || !b || a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return true;
  return false;
}

// A 'card' fallback must occupy the same 6-col grid footprint the healthy widget would (mirrors
// ChartWidget's SIZE_COL_SPAN / SIZE_H). Kept as a small local copy so this leaf boundary doesn't
// import the heavy ChartWidget module (which imports this one).
const CARD_SPAN: Record<'third' | 'half' | 'full', string> = {
  third: 'lg:col-span-2',
  half: 'lg:col-span-4',
  full: 'lg:col-span-6',
};
const CARD_MIN_H: Record<'third' | 'half' | 'full', string> = {
  third: 'h-[264px]',
  half: 'h-[264px]',
  full: 'min-h-[264px]', // full cards are content-height; keep a floor so the fallback isn't tiny
};

/**
 * Per-widget render boundary: a thrown error in ONE widget becomes a calm fallback in that widget's
 * place — the app shell, the sidebar and every sibling widget keep rendering (the app-level
 * ErrorBoundary only ever sees what escapes here). The crash is reported (trace id + widget id +
 * route) via reportWidgetError; the fallback shows that trace id and a «Повторить» that re-mounts the
 * child. Reconfiguring the widget (a changed resetKey) clears the error automatically.
 */
export class WidgetErrorBoundary extends Component<WidgetErrorBoundaryProps, WidgetErrorBoundaryState> {
  state: WidgetErrorBoundaryState = { traceId: null };

  // Enter the error state on a child throw. The real trace id is minted in componentDidCatch (a
  // render-phase method must stay side-effect-free, and that's also where the componentStack is), so
  // a sentinel flips us into the fallback for the one commit before the id arrives.
  static getDerivedStateFromError(): WidgetErrorBoundaryState {
    return { traceId: 'pending' };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const report = reportWidgetError({
      error,
      widgetId: this.props.widgetId,
      label: this.props.label,
      componentStack: info.componentStack ?? undefined,
    });
    this.setState({ traceId: report.traceId });
  }

  componentDidUpdate(prev: WidgetErrorBoundaryProps): void {
    // A changed reset key (e.g. the widget was reconfigured) clears the error so the new render is
    // attempted. No-op while healthy.
    if (this.state.traceId && keysChanged(prev.resetKeys, this.props.resetKeys)) {
      this.setState({ traceId: null });
    }
  }

  private retry = () => this.setState({ traceId: null });

  render(): ReactNode {
    const { traceId } = this.state;
    if (!traceId) return this.props.children;

    const body = (
      <div className="flex h-full min-h-24 flex-col items-center justify-center gap-1.5 px-3 py-4 text-center">
        <svg
          className="h-6 w-6 text-ink3"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h16.9a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
        <div className="text-sm font-medium text-foreground">Виджет не отрисовался</div>
        <p className="text-2xs text-muted-foreground">
          Остальная панель работает.
          {traceId !== 'pending' && (
            <>
              {' '}
              Код: <span className="font-mono">{traceId}</span>
            </>
          )}
        </p>
        <button
          type="button"
          onClick={this.retry}
          className="btn-pill mt-1 border border-border px-3 py-1 text-2xs font-medium text-foreground transition-colors hover:bg-muted"
        >
          Повторить
        </button>
      </div>
    );

    if (this.props.variant !== 'card') return body;

    // Self-chromed fallback for own-chrome widgets (no ChartSection around us) — a hairline card that
    // fills the widget's own grid slot, matching the dashboard card surface (governance: hairline
    // depth, no shadow).
    const size = this.props.size ?? 'half';
    return (
      <section className={`min-w-0 ${CARD_SPAN[size]}`}>
        <div className={`flex ${CARD_MIN_H[size]} flex-col rounded-2xl border border-border bg-card p-4 dark:border-white/6 sm:p-5`}>
          <h3 className="shrink-0 truncate text-xs font-medium tracking-wider text-muted-foreground">
            {this.props.label || 'Виджет'}
          </h3>
          <div className="min-h-0 flex-1">{body}</div>
        </div>
      </section>
    );
  }
}

/**
 * Renders nothing but re-throws a captured error during its OWN render. Use it to surface an error
 * caught OUTSIDE a boundary (e.g. a widget's function-form variant-compute that runs in ChartSection's
 * render body, above the in-card boundary) from INSIDE that boundary — converting what would blank the
 * app shell into a per-widget fallback with the card chrome intact.
 */
export function ThrowInRender({ error }: { error: unknown }): never {
  throw error instanceof Error
    ? error
    : new Error(typeof error === 'string' ? error : 'Widget failed to render');
}
