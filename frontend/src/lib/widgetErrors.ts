/**
 * Widget crash reporting — the shared sink behind the per-widget error boundaries. A boundary that
 * catches a render error builds a structured report (trace id + widget id + error + route) and hands
 * it here: it lands in the console today, and a `sink` seam lets a future telemetry pass (the crash
 * telemetry P0) POST it to /api/client-errors WITHOUT touching every boundary. Kept framework-free
 * and pure so it unit-tests in the node test env (no DOM); the boundary supplies the environment bits
 * (route / clock).
 */

export interface WidgetErrorReport {
  /** Short, user-quotable id shown in the fallback and logged — links the visible card to the log. */
  traceId: string;
  /** The widget's stable id (its ChartSection id) when known — which card failed. */
  widgetId?: string;
  /** Human label of the widget (its title) — readable context in the log / telemetry. */
  label?: string;
  /** error.name (e.g. TypeError). */
  name: string;
  /** error.message, truncated. */
  message: string;
  /** React componentStack (info.componentStack), truncated — where in the tree it threw. */
  componentStack?: string;
  /** Route the crash happened on (location.pathname). */
  route?: string;
  /** ISO timestamp of the crash. */
  at: string;
}

type WidgetErrorSink = (report: WidgetErrorReport) => void;

const MESSAGE_CAP = 300;
const STACK_CAP = 2000;

let counter = 0;
let sink: WidgetErrorSink | null = null;

/** A short, unique, human-quotable trace id, e.g. `w-3f-k7q2` — the counter keeps it unique within a
 *  session, the random suffix keeps two tabs from colliding in a shared telemetry stream. The suffix
 *  is padded so a rare tiny Math.random() can't yield an empty tail. */
export function nextTraceId(): string {
  counter = (counter + 1) % 1_000_000;
  const rand = (Math.random().toString(36) + '0000').slice(2, 6);
  return `w-${counter.toString(36)}-${rand}`;
}

function truncate(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

/** Build the structured report from raw inputs — pure (no clock / DOM reads), so it unit-tests
 *  deterministically. The boundary supplies traceId / route / at from the environment. */
export function buildWidgetErrorReport(input: {
  traceId: string;
  error: unknown;
  at: string;
  widgetId?: string;
  label?: string;
  componentStack?: string;
  route?: string;
}): WidgetErrorReport {
  const err = input.error;
  const name = err instanceof Error && err.name ? err.name : 'Error';
  const rawMessage = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);
  return {
    traceId: input.traceId,
    widgetId: input.widgetId,
    label: input.label,
    name,
    message: truncate(rawMessage ?? '', MESSAGE_CAP),
    componentStack: input.componentStack ? truncate(input.componentStack, STACK_CAP) : undefined,
    route: input.route,
    at: input.at,
  };
}

/** Register (or clear with null) the telemetry sink; returns the previous sink so a caller can
 *  restore it. The crash-telemetry pass wires a POST /api/client-errors here — until then the
 *  console line below is the diagnostics floor. */
export function setWidgetErrorSink(next: WidgetErrorSink | null): WidgetErrorSink | null {
  const prev = sink;
  sink = next;
  return prev;
}

/** Report a caught widget render error: build the report, log it (always — the console line keyed by
 *  the same trace id the user sees is the local floor), and forward it to the sink if one is
 *  registered. A throwing sink is swallowed — reporting a crash must never itself crash the app.
 *  Returns the report so the boundary can show its trace id. */
export function reportWidgetError(input: {
  error: unknown;
  widgetId?: string;
  label?: string;
  componentStack?: string;
  /** Overridable for tests; defaults to the current route. */
  route?: string;
  /** Overridable for tests; defaults to now. */
  at?: string;
}): WidgetErrorReport {
  const route = input.route ?? (typeof location !== 'undefined' ? location.pathname : undefined);
  const at = input.at ?? new Date().toISOString();
  const report = buildWidgetErrorReport({
    traceId: nextTraceId(),
    error: input.error,
    widgetId: input.widgetId,
    label: input.label,
    componentStack: input.componentStack,
    route,
    at,
  });
  console.error('[widget-crash]', report.traceId, report);
  if (sink) {
    try {
      sink(report);
    } catch {
      /* a broken sink must not escalate a widget crash into an app crash */
    }
  }
  return report;
}
