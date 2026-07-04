import { z } from 'zod';
import { apiSend } from '@/api/client';
import { setWidgetErrorSink, type WidgetErrorReport } from '@/lib/widgetErrors';

/**
 * Crash telemetry — forwards a caught render crash (widget or app-level) to POST /api/client-errors so
 * it is diagnosable in the admin Bugs surface by its trace id, not just a lost console line. Builds on
 * the widget-error sink seam (setWidgetErrorSink). The server owns identity/commit/storage; the client
 * only ships the report the boundary already built, fire-and-forget.
 */

const AckSchema = z
  .object({ ok: z.boolean().optional(), id: z.number().nullable().optional(), traceId: z.string().optional() })
  .passthrough();

// Per-scope budgets so a broadly-broken deploy's WIDGET-crash noise can never starve the report of a
// (rarer, higher-value) app-shell white-screen crash. No signature dedupe: every crash the user is
// shown a trace id for is POSTed, so that exact id is always findable in admin (a dedupe would drop a
// «Повторить» retry's fresh id). The server rate limiter (30/5min) is the backstop against a runaway.
const MAX_WIDGET_REPORTS = 12;
const MAX_APP_REPORTS = 4;
let sentWidget = 0;
let sentApp = 0;

/** POST a caught crash to the telemetry endpoint. Fire-and-forget: every failure (offline, demo mode,
 *  rate limit, sync throw) is swallowed so reporting can never escalate a crash. Budgeted per scope. */
export function reportCrashToServer(report: WidgetErrorReport, scope: 'widget' | 'app' = 'widget'): void {
  if (scope === 'app') {
    if (sentApp >= MAX_APP_REPORTS) return;
    sentApp += 1;
  } else {
    if (sentWidget >= MAX_WIDGET_REPORTS) return;
    sentWidget += 1;
  }
  try {
    void apiSend(
      'POST',
      '/api/client-errors',
      {
        traceId: report.traceId,
        name: report.name,
        message: report.message,
        componentStack: report.componentStack,
        route: report.route,
        widgetId: report.widgetId,
        label: report.label,
        scope,
      },
      AckSchema,
    ).catch(() => {
      /* offline / demo / rate-limited — the console line already captured it locally */
    });
  } catch {
    /* apiSend can throw synchronously (demo mode) — swallow */
  }
}

const widgetSink = (report: WidgetErrorReport) => reportCrashToServer(report, 'widget');

// Install the widget crash sink at MODULE LOAD (import time) — an ALWAYS-ON floor for the whole page
// session. It is registered BEFORE any widget can commit (the module is imported at app init via
// ErrorBoundary, so this runs before the first React commit), and it is never torn down: a passive
// effect / logout-cleanup could null it and — since re-login is pure SPA navigation with no page
// reload, so this module never re-evaluates — leave a first-render crash after re-login unreported.
// The sink is stateless (apiSend reads the auth token at call time; an unauthenticated POST just 401s
// and is swallowed), so keeping it armed for the whole session is harmless.
setWidgetErrorSink(widgetSink);

/** Test seam — reset the per-session report budgets. */
export function __resetCrashReporting(): void {
  sentWidget = 0;
  sentApp = 0;
}
