import { Suspense, lazy, useEffect } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { installScrollEdgeFade } from '@/lib/scrollEdgeFade';
import { RouteCommitSignal } from '@/lib/viewTransitionNavigate';
import { Route, Routes } from 'react-router-dom';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { lazyWithReload } from '@/lib/lazyWithReload';

const AuthGate = lazy(
  lazyWithReload(() =>
    import('@/AuthGate').then((module) => ({ default: module.AuthGate })),
  ),
);
const LoginPage = lazyFrom(() => import('@/pages/Auth'), 'LoginPage');
const RegisterPage = lazyFrom(() => import('@/pages/Auth'), 'RegisterPage');
const VerifyPage = lazyFrom(() => import('@/pages/Auth'), 'VerifyPage');
const ResetPage = lazyFrom(() => import('@/pages/Auth'), 'ResetPage');
const Privacy = lazyFrom(() => import('@/pages/Legal'), 'Privacy');
const DataDeletion = lazyFrom(() => import('@/pages/Legal'), 'DataDeletion');

// biome-ignore lint/suspicious/noExplicitAny: generic boundary around React.lazy named exports
function lazyFrom<M extends Record<K, ComponentType<any>>, K extends keyof M & string>(
  load: () => Promise<M>,
  name: K,
) {
  return lazy(lazyWithReload(() => load().then((module) => ({ default: module[name] }))));
}

/**
 * Public route graph. The protected graph is intentionally absent from this module and is reached
 * only through AuthGate's post-probe dynamic import. Login/legal deep links therefore never parse
 * dashboard feeds, charts or navigation before they can become interactive.
 */
export default function App() {
  // Глобальный драйвер scroll-edge fade всех .data-table-scroll (см. lib/scrollEdgeFade):
  // один вызов на всё приложение, идемпотентный.
  useEffect(() => {
    installScrollEdgeFade();
  }, []);
  return (
    <ErrorBoundary>
      {/* Сигнал коммита роута для View Transitions (см. lib/viewTransitionNavigate). */}
      <RouteCommitSignal />
      <Routes>
        <Route path="login" element={<AuthSuspense><LoginPage /></AuthSuspense>} />
        <Route path="register" element={<AuthSuspense><RegisterPage /></AuthSuspense>} />
        <Route path="verify" element={<AuthSuspense><VerifyPage /></AuthSuspense>} />
        <Route path="reset" element={<AuthSuspense><ResetPage /></AuthSuspense>} />
        <Route
          path="privacy"
          element={<Suspense fallback={<PublicPageFallback />}><Privacy /></Suspense>}
        />
        <Route
          path="data-deletion"
          element={<Suspense fallback={<PublicPageFallback />}><DataDeletion /></Suspense>}
        />
        <Route path="*" element={<Suspense fallback={<AuthGateFallback />}><AuthGate /></Suspense>} />
      </Routes>
    </ErrorBoundary>
  );
}

function PublicPageFallback() {
  return <div className="min-h-screen bg-background" />;
}

/** Auth page scaffold mirrors AuthShell so loading its async chunk does not move the card. */
function AuthSuspense({ children }: { children: ReactNode }) {
  return (
    <Suspense fallback={<AuthCardFallback />}>
      {children}
    </Suspense>
  );
}

function AuthCardFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-5 py-12">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex justify-center">
          <Pulse className="h-6 w-28" />
        </div>
        <div className="rounded-2xl border border-border bg-card p-7 sm:p-8">
          <Pulse className="h-8 w-2/3" />
          <div className="mt-6 space-y-4">
            {Array.from({ length: 2 }).map((_, index) => (
              <div key={index} className="space-y-1.5">
                <Pulse className="h-4 w-16" />
                <Pulse className="h-10 w-full" />
              </div>
            ))}
            <Pulse className="mt-5 h-10 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

function AuthGateFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm space-y-3">
        <Pulse className="h-5 w-1/3" />
        <Pulse className="h-10 w-full" />
        <Pulse className="h-10 w-full" />
      </div>
    </div>
  );
}

function Pulse({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-muted motion-reduce:animate-none ${className}`} />;
}
