import { Suspense, lazy } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useMe } from '@/api/queries';
import { ApiError } from '@/api/client';
import { DashboardLayout } from '@/components/DashboardLayout';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { ErrorState } from '@/components/ErrorState';
import { NotFound } from '@/components/NotFound';
import { PeriodUrlSync } from '@/lib/period-url';
import { FEEDS, FeedSectionPage } from '@/panels/feed/feeds';
import { NETWORKS } from '@/lib/networks';
import { Home } from '@/panels/Home';
import { MetricRoute } from '@/panels/IgMetricPage';
import { ReportPage } from '@/panels/ReportPage';
import { ReportsList } from '@/panels/ReportsList';
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
const Admin = lazyFrom(() => import('@/panels/Admin'), 'Admin');
const Bugs = lazyFrom(() => import('@/panels/Bugs'), 'Bugs');
const Connect = lazyFrom(() => import('@/pages/Connect'), 'Connect');
// Страница кампании — редкий standalone-роут, живёт вне entry-чанка (bundle-size гейт).
const CampaignPage = lazyFrom(() => import('@/panels/CampaignPage'), 'CampaignPage');
// Public legal pages (Instagram / Meta App Review requires reachable Privacy + Data Deletion URLs).
const Privacy = lazyFrom(() => import('@/pages/Legal'), 'Privacy');
const DataDeletion = lazyFrom(() => import('@/pages/Legal'), 'DataDeletion');

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
      {/* Public, no-auth legal pages (Meta App Review + user transparency). */}
      <Route path="privacy" element={<Suspense fallback={<div className="min-h-screen bg-background" />}><Privacy /></Suspense>} />
      <Route path="data-deletion" element={<Suspense fallback={<div className="min-h-screen bg-background" />}><DataDeletion /></Suspense>} />
      <Route element={<ProtectedLayout />}>
        {/* Personal Home — a per-user board of pinned widgets. Static import (it's light) and
            declared BEFORE the catch-all `:section?` so /home resolves here, not to the TG feed. */}
        <Route path="home" element={<Home />} />
        {/* One dispatcher for both worlds: TG keys → MetricPage, ig-* keys → IgMetricPage. */}
        <Route path="metrics/:key" element={<MetricRoute />} />
        <Route path="reports" element={<ReportsList />} />
        <Route path="reports/:id" element={<ReportPage />} />
        {/* Страница кампании — standalone, как reports/:id. Списка-маршрута нет намеренно:
            список кампаний живёт вкладкой в «Контенте» (и не появляется в sidebar). */}
        <Route path="campaigns/:id" element={<PanelSuspense><CampaignPage /></PanelSuspense>} />
        {/* Pre-multi-reports bookmarks land on the index. */}
        <Route path="report" element={<Navigate to="/reports" replace />} />
        <Route path="settings" element={<Settings />} />
        <Route path="admin" element={<PanelSuspense><Admin /></PanelSuspense>} />
        <Route path="bugs" element={<PanelSuspense><Bugs /></PanelSuspense>} />
        <Route path="connect" element={<PanelSuspense><Connect /></PanelSuspense>} />
        {/* Network dashboards — FOCUSED pages for EVERY network, built from the feed registry
            (panels/feed/feeds.tsx) over the network registry (lib/networks): a layout route per
            network (its Shell owns providers/chrome/gates), one child route per declared section.
            TG is the prefixless default (index at the root); a future source appears here by
            registering itself — no new route family. Unknown segments fall to the 404 below. */}
        {NETWORKS.map((net) => {
          const feed = FEEDS[net.key];
          return (
            <Route key={net.key} path={'prefix' in net ? net.prefix.slice(1) : undefined} element={<feed.Shell />}>
              {feed.sections.map((s) =>
                s.section === '' ? (
                  <Route key={`${net.key}:index`} index element={<FeedSectionPage net={net.key} section="" />} />
                ) : (
                  <Route
                    key={`${net.key}:${s.section}`}
                    path={s.section}
                    element={<FeedSectionPage net={net.key} section={s.section} />}
                  />
                ),
              )}
            </Route>
          );
        })}
        {/* Real 404 for any unknown path. Renders in the content area, so the shell/nav stay. */}
        <Route path="*" element={<NotFound />} />
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
        <ErrorState
          className="max-w-sm"
          title="Не удалось загрузить"
          reason={me.error instanceof Error ? me.error.message : 'Неизвестная ошибка'}
          onRetry={() => void me.refetch()}
          retrying={me.isFetching}
        />
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
