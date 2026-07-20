import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Cartograph } from '@/components/Cartograph';
import { isChunkLoadError } from '@/lib/lazyWithReload';
import { buildWidgetErrorReport, nextTraceId } from '@/lib/widgetErrors';
import { reportCrashToServer } from '@/lib/crashReporting';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  traceId: string | null;
}

/**
 * Render-error boundary for the protected app shell: a thrown render error becomes a calm
 * hairline card (error name + «Повторить») instead of a white screen. No stack traces in
 * the UI — the full error still lands in the console for diagnostics.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, traceId: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Build the report with the PURE helpers (not reportWidgetError, whose sink may be uninstalled if
    // the shell itself failed to mount) and forward it to telemetry directly with scope 'app'. The
    // trace id is shown in the fallback so a user can quote it.
    const report = buildWidgetErrorReport({
      traceId: nextTraceId(),
      error,
      widgetId: 'app-shell',
      label: 'Приложение',
      componentStack: info.componentStack ?? undefined,
      route: typeof location !== 'undefined' ? location.pathname : undefined,
      at: new Date().toISOString(),
    });
    console.error('[app-crash]', report.traceId, error, info.componentStack);
    reportCrashToServer(report, 'app');
    this.setState({ traceId: report.traceId });
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <div className="flex w-full max-w-sm flex-col items-center rounded border border-border bg-card p-8 text-center">
          <Cartograph name="compass" className="h-28 w-auto" />
          <h2 className="mt-5 text-lg font-medium tracking-tight">Не удалось загрузить раздел</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {/* Чанк-ошибка после деплоя (авто-reload из lazyWithReload не помог): честная причина
                вместо generic-текста — кнопка «Обновить» ниже уже делает нужное. */}
            {isChunkLoadError(error) ? (
              'Вышло обновление приложения — обновите страницу.'
            ) : (
              <>
                Обновите страницу — обычно это помогает · <span className="font-mono">{error.name || 'Ошибка'}</span>
              </>
            )}
          </p>
          {this.state.traceId && (
            <p className="mt-1 text-2xs text-muted-foreground">
              Код ошибки: <span className="font-mono">{this.state.traceId}</span>
            </p>
          )}
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn-pill mt-6 bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Обновить
          </button>
        </div>
      </div>
    );
  }
}
