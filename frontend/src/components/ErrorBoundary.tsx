import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Render-error boundary for the protected app shell: a thrown render error becomes a calm
 * hairline card (error name + «Повторить») instead of a white screen. No stack traces in
 * the UI — the full error still lands in the console for diagnostics.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[app-crash]', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
        <div className="w-full max-w-sm rounded border border-border bg-card p-6 text-center">
          <h2 className="text-lg font-medium">Что-то пошло не так</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {error.name || 'Ошибка'} — интерфейс не смог отрисоваться.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="btn-pill mt-5 bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Повторить
          </button>
        </div>
      </div>
    );
  }
}
