import { Suspense, lazy } from 'react';
import type { ComponentType, ReactNode } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import type { Me } from '@/api/schemas';
import { DashboardLayout } from '@/components/DashboardLayout';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { NotFound } from '@/components/NotFound';
import { lazyWithReload } from '@/lib/lazyWithReload';
import { PeriodUrlSync } from '@/lib/period-url';
import { FEEDS, FeedSectionPage } from '@/panels/feed/feeds';
import { NETWORKS } from '@/lib/networks';
import { Skeleton } from '@/components/ui/skeleton';
import { ChannelProvider } from '@/lib/channel-context';
import { DemoProvider } from '@/lib/demo-context';
import { PeriodProvider } from '@/lib/period';
import { ConfirmProvider } from '@/components/ConfirmDialogProvider';
import { Toaster } from '@/components/ui/sonner';

// ── Code splitting ────────────────────────────────────────────────────────────
// The heavy/rare route groups load on demand instead of riding in the entry chunk:
// This whole protected route graph is imported only after AuthGate has received a successful
// `/api/auth/me` response. The IG cluster, Admin/Bugs (superuser-only) and Connect are visited rarely.
// The IG five all import the same barrel, so they land in ONE async chunk. The metric
// explorers (metrics/:key), the reports index + report document, and Settings are also
// lazy: none is the default landing surface (TG Overview is), each is entered by an
// explicit click/deep-link, and together they keep the entry chunk under its size gate.
// Route bodies stay out of the shell closure. The matched TG Overview starts immediately behind a
// layout-stable section skeleton; Personal Home is an explicit /home visit and is lazy as well.
// Lightweight dispatcher: each metric family (including generic TG and IG) is its own async chunk.
const MetricRoute = lazyFrom(() => import('@/panels/MetricRoute'), 'MetricRoute');
const Home = lazyFrom(() => import('@/panels/Home'), 'Home');
const CommandPalette = lazyFrom(
  () => import('@/components/CommandPalette'),
  'CommandPalette',
);
// Reports index + the report document. ReportsList re-uses ReportPage's error state, so
// both live lazy together (else ReportPage would be pulled back into the entry chunk).
const ReportsList = lazyFrom(() => import('@/panels/ReportsList'), 'ReportsList');
const ReportPage = lazyFrom(() => import('@/panels/ReportPage'), 'ReportPage');
const Settings = lazyFrom(() => import('@/panels/Settings'), 'Settings');
const Admin = lazyFrom(() => import('@/panels/Admin'), 'Admin');
const Bugs = lazyFrom(() => import('@/panels/Bugs'), 'Bugs');
const Connect = lazyFrom(() => import('@/pages/Connect'), 'Connect');
// Страница кампании — редкий standalone-роут, живёт вне entry-чанка (bundle-size гейт).
const CampaignPage = lazyFrom(() => import('@/panels/CampaignPage'), 'CampaignPage');
const CampaignMetricPage = lazyFrom(
  () => import('@/panels/campaign/CampaignMetricPage'),
  'CampaignMetricPage',
);
const WidgetMetricPage = lazyFrom(
  () => import('@/panels/WidgetMetricPage'),
  'WidgetMetricPage',
);
// AI-чат — lazy: стриминговая механика (lib/aiStream) не едет в entry-чанк; на Главной живёт
// только лёгкий hero (panels/ai/HomeAiHero), который сюда лишь навигирует.
const AiChatPage = lazyFrom(() => import('@/panels/ai/AiChatPage'), 'AiChatPage');
/** React.lazy over a NAMED export (all pages here export by name, not default). The factory is
    wrapped in lazyWithReload: after a deploy a stale tab requests a chunk that no longer exists —
    the wrapper reloads the page ONCE (fresh index → fresh chunks) instead of showing an error. */
// biome-ignore lint/suspicious/noExplicitAny: generic-граница React.lazy — пропсы компонента здесь не сужаются
function lazyFrom<M extends Record<K, ComponentType<any>>, K extends keyof M & string>(
  load: () => Promise<M>,
  name: K,
) {
  return lazy(lazyWithReload(() => load().then((m) => ({ default: m[name] }))));
}

export default function ProtectedApp({ me }: { me: Me }) {
  return (
    <ChannelProvider>
      <PeriodProvider>
        <DemoProvider>
          <ConfirmProvider>
            <ProtectedRoutes me={me} />
          </ConfirmProvider>
          <Toaster />
        </DemoProvider>
      </PeriodProvider>
    </ChannelProvider>
  );
}

function ProtectedRoutes({ me }: { me: Me }) {
  return (
    <Routes>
      <Route element={<ProtectedLayout me={me} />}>
        {/* Personal Home — a per-user board of pinned widgets. Static import (it's light) and
            declared BEFORE the catch-all `:section?` so /home resolves here, not to the TG feed. */}
        <Route path="home" element={<PanelSuspense><Home /></PanelSuspense>} />
        {/* One dispatcher for both worlds: TG keys → MetricPage, ig-* keys → IgMetricPage. */}
        <Route path="metrics/:key" element={<PanelSuspense><MetricRoute /></PanelSuspense>} />
        <Route path="widgets/:widgetId" element={<PanelSuspense><WidgetMetricPage /></PanelSuspense>} />
        <Route path="reports" element={<PanelSuspense><ReportsList /></PanelSuspense>} />
        <Route path="reports/:id" element={<PanelSuspense><ReportPage /></PanelSuspense>} />
        {/* Страница кампании — standalone, как reports/:id. Списка-маршрута нет намеренно:
            список кампаний живёт вкладкой в «Контенте» (и не появляется в sidebar). */}
        <Route path="campaigns/:id" element={<PanelSuspense><CampaignPage /></PanelSuspense>} />
        <Route
          path="campaigns/:id/metrics/:metricKey"
          element={<PanelSuspense><CampaignMetricPage /></PanelSuspense>}
        />
        {/* AI-чат: индекс + тред. Виден только при me.ai.enabled (страница сама гейтится). */}
        <Route path="ai" element={<PanelSuspense><AiChatPage /></PanelSuspense>} />
        <Route path="ai/:chatId" element={<PanelSuspense><AiChatPage /></PanelSuspense>} />
        {/* Pre-multi-reports bookmarks land on the index. */}
        <Route path="report" element={<Navigate to="/reports" replace />} />
        <Route path="settings" element={<PanelSuspense><Settings /></PanelSuspense>} />
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

function ProtectedLayout({ me }: { me: Me }) {
  return (
    <ErrorBoundary>
      <PeriodUrlSync />
      <DashboardLayout
        email={me.email ?? undefined}
        role={me.role}
        avatar={me.avatar ?? undefined}
      />
      <Suspense fallback={null}>
        <CommandPalette />
      </Suspense>
    </ErrorBoundary>
  );
}
