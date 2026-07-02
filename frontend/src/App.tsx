import { Suspense, lazy } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { Routes, Route } from 'react-router-dom';
import { useMe } from '@/api/queries';
import { ApiError } from '@/api/client';
import { DashboardLayout } from '@/components/DashboardLayout';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { PeriodUrlSync } from '@/lib/period-url';
import { TgFeed } from '@/panels/TgFeed';
import { MetricPage } from '@/panels/MetricPage';
import { ReportPage } from '@/panels/ReportPage';
import { Settings } from '@/panels/Settings';
import { Skeleton } from '@/components/ui/skeleton';
import { CommandPalette } from '@/components/CommandPalette';

// ── Code splitting ────────────────────────────────────────────────────────────
// The heavy/rare route groups load on demand instead of riding in the entry chunk:
// Landing carries framer-motion (~100 kB) that a logged-in user never needs; the IG
// cluster, Admin/Bugs (superuser-only), Connect and the auth pages are visited rarely.
// The IG five all import the same barrel, so they land in ONE async chunk.
const Landing = lazy(() => import('@/pages/Landing').then((m) => ({ default: m.Landing })));
const LoginPage = lazyFrom(() => import('@/pages/Auth'), 'LoginPage');
const RegisterPage = lazyFrom(() => import('@/pages/Auth'), 'RegisterPage');
const VerifyPage = lazyFrom(() => import('@/pages/Auth'), 'VerifyPage');
const ResetPage = lazyFrom(() => import('@/pages/Auth'), 'ResetPage');
const InstagramLayout = lazyFrom(() => import('@/panels/instagram/ig-cluster'), 'InstagramLayout');
const IgOverview = lazyFrom(() => import('@/panels/instagram/ig-cluster'), 'IgOverview');
const IgAnalytics = lazyFrom(() => import('@/panels/instagram/ig-cluster'), 'IgAnalytics');
const IgContent = lazyFrom(() => import('@/panels/instagram/ig-cluster'), 'IgContent');
const IgAudience = lazyFrom(() => import('@/panels/instagram/ig-cluster'), 'IgAudience');
const Admin = lazyFrom(() => import('@/panels/Admin'), 'Admin');
const Bugs = lazyFrom(() => import('@/panels/Bugs'), 'Bugs');
const Connect = lazyFrom(() => import('@/pages/Connect'), 'Connect');

/** React.lazy over a NAMED export (all pages here export by name, not default). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lazyFrom<M extends Record<K, ComponentType<any>>, K extends keyof M & string>(
  load: () => Promise<M>,
  name: K,
) {
  return lazy(() => load().then((m) => ({ default: m[name] })));
}

export default function App() {
  return (
    <Routes>
      <Route path="login" element={<AuthSuspense><LoginPage /></AuthSuspense>} />
      <Route path="register" element={<AuthSuspense><RegisterPage /></AuthSuspense>} />
      <Route path="verify" element={<AuthSuspense><VerifyPage /></AuthSuspense>} />
      <Route path="reset" element={<AuthSuspense><ResetPage /></AuthSuspense>} />
      <Route element={<ProtectedLayout />}>
        <Route path="metrics/:key" element={<MetricPage />} />
        <Route path="report" element={<ReportPage />} />
        <Route path="instagram" element={<PanelSuspense><InstagramLayout /></PanelSuspense>}>
          <Route index element={<PanelSuspense><IgOverview /></PanelSuspense>} />
          <Route path="analytics" element={<PanelSuspense><IgAnalytics /></PanelSuspense>} />
          <Route path="content" element={<PanelSuspense><IgContent /></PanelSuspense>} />
          <Route path="audience" element={<PanelSuspense><IgAudience /></PanelSuspense>} />
        </Route>
        <Route path="settings" element={<Settings />} />
        <Route path="admin" element={<PanelSuspense><Admin /></PanelSuspense>} />
        <Route path="bugs" element={<PanelSuspense><Bugs /></PanelSuspense>} />
        <Route path="connect" element={<PanelSuspense><Connect /></PanelSuspense>} />
        {/* The TG feed serves '/', '/analytics', '/posts', '/mentions' as ONE scrolled page —
            a single optional-param route so the scrollspy's replace-navigation never remounts
            it. Unknown sections redirect home inside the feed. */}
        <Route path=":section?" element={<TgFeed />} />
      </Route>
    </Routes>
  );
}

// ── Suspense fallbacks — layout-matching skeleton scaffolds, never spinners ──

/** Content-area scaffold (inside the dashboard shell): section title + ledger + block. */
function PanelSuspense({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="space-y-6">
          <Skeleton className="h-6 w-48" />
          <div className="grid grid-cols-2 gap-px border-t border-border bg-border lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="bg-background p-4">
                <Skeleton className="h-2.5 w-16" />
                <Skeleton className="mt-2 h-6 w-20" />
              </div>
            ))}
          </div>
          <Skeleton className="h-40 w-full" />
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

/** Auth page scaffold: brand mark corner + the centered 380px form column (mirrors AuthShell). */
function AuthSuspense({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <div className="relative flex min-h-screen items-center justify-center bg-background px-5 py-16">
          <div className="absolute left-6 top-6">
            <Skeleton className="h-5 w-24" />
          </div>
          <div className="w-full max-w-[380px]">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="mt-3 h-4 w-full" />
            <div className="mt-6 space-y-4">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="mt-5 h-10 w-full rounded-full" />
            </div>
          </div>
        </div>
      }
    >
      {children}
    </Suspense>
  );
}

/** Landing scaffold: top nav row + hero copy column + CTA pills (mirrors the page grid). */
function LandingFallback() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-[1200px] px-6 sm:px-10">
        <div className="flex items-center justify-between py-5">
          <Skeleton className="h-6 w-28" />
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-20 rounded-full" />
            <Skeleton className="h-9 w-36 rounded-full" />
          </div>
        </div>
        <div className="max-w-xl space-y-4 pt-16 sm:pt-24">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-4/5" />
          <Skeleton className="h-4 w-2/3" />
          <div className="flex gap-3 pt-4">
            <Skeleton className="h-11 w-40 rounded-full" />
            <Skeleton className="h-11 w-32 rounded-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

function ProtectedLayout() {
  const me = useMe();

  if (me.isLoading) {
    return (
      <Centered>
        <div className="w-full max-w-sm space-y-3">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </Centered>
    );
  }

  if (me.isError) {
    const unauthorized = me.error instanceof ApiError && me.error.status === 401;
    if (unauthorized) {
      return (
        <Suspense fallback={<LandingFallback />}>
          <Landing />
        </Suspense>
      );
    }
    return (
      <Centered>
        <div className="max-w-sm rounded-lg border bg-card p-6 text-center">
          <h2 className="text-lg font-medium">Не удалось загрузить</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {me.error instanceof Error ? me.error.message : 'Неизвестная ошибка'}
          </p>
          <button
            type="button"
            onClick={() => void me.refetch()}
            disabled={me.isFetching}
            className="btn-pill mt-5 bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {me.isFetching ? 'Загрузка…' : 'Повторить'}
          </button>
        </div>
      </Centered>
    );
  }

  return (
    <ErrorBoundary>
      <PeriodUrlSync />
      <DashboardLayout email={me.data?.email ?? undefined} role={me.data?.role} avatar={me.data?.avatar} />
      <CommandPalette />
    </ErrorBoundary>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      {children}
    </div>
  );
}
