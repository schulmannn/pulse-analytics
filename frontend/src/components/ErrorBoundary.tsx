import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { Cartograph } from '@/components/Cartograph';

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
        <div className="flex w-full max-w-sm flex-col items-center rounded border border-border bg-card p-8 text-center">
          <Cartograph name="compass" className="h-28 w-auto" />
          <h2 className="mt-5 text-lg font-medium">Кажется, мы сбились с курса</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Интерфейс не смог отрисоваться · <span className="font-mono">{error.name || 'Ошибка'}</span>. Обычно помогает обновить страницу.
          </p>
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
