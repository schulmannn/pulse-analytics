import { useState } from 'react';
import type { ReactNode } from 'react';
import { Navigate, Routes, Route } from 'react-router-dom';
import { cn } from '@/lib/utils';
import { useMe } from '@/api/queries';
import { ApiError } from '@/api/client';
import { DashboardLayout } from '@/components/DashboardLayout';
import { LoginPage, RegisterPage, ResetPage, VerifyPage } from '@/pages/Auth';
import { Landing } from '@/pages/Landing';
import { Connect } from '@/pages/Connect';
import { Overview } from '@/panels/Overview';
import { Posts } from '@/panels/Posts';
import { Mentions } from '@/panels/Mentions';
import { InstagramLayout } from '@/panels/instagram/Layout';
import { IgOverview } from '@/panels/instagram/IgOverview';
import { IgAnalytics } from '@/panels/instagram/IgAnalytics';
import { IgContent } from '@/panels/instagram/IgContent';
import { IgAudience } from '@/panels/instagram/IgAudience';
import { TgAnalytics } from '@/panels/TgAnalytics';
import { Insights } from '@/panels/Insights';
import { Compare } from '@/panels/Compare';
import { HistoryChartBlock, HeatmapChartBlock, VelocityChartBlock } from '@/panels/Charts';
import { Hashtags } from '@/panels/Hashtags';
import { Settings } from '@/panels/Settings';
import { Admin } from '@/panels/Admin';
import { Bugs } from '@/panels/Bugs';
import { Skeleton } from '@/components/ui/skeleton';
import { CommandPalette } from '@/components/CommandPalette';

export default function App() {
  return (
    <Routes>
      <Route path="login" element={<LoginPage />} />
      <Route path="register" element={<RegisterPage />} />
      <Route path="verify" element={<VerifyPage />} />
      <Route path="reset" element={<ResetPage />} />
      <Route element={<ProtectedLayout />}>
        <Route index element={<Overview />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="posts" element={<Posts />} />
        <Route path="mentions" element={<Mentions />} />
        <Route path="instagram" element={<InstagramLayout />}>
          <Route index element={<IgOverview />} />
          <Route path="analytics" element={<IgAnalytics />} />
          <Route path="content" element={<IgContent />} />
          <Route path="audience" element={<IgAudience />} />
        </Route>
        <Route path="settings" element={<Settings />} />
        <Route path="admin" element={<Admin />} />
        <Route path="bugs" element={<Bugs />} />
        <Route path="connect" element={<Connect />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
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
    if (unauthorized) return <Landing />;
    return (
      <Centered>
        <div className="max-w-sm rounded-lg border bg-card p-6 text-center">
          <h2 className="text-lg font-medium">Не удалось загрузить</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {me.error instanceof Error ? me.error.message : 'Неизвестная ошибка'}
          </p>
        </div>
      </Centered>
    );
  }

  return (
    <>
      <DashboardLayout email={me.data?.email ?? undefined} role={me.data?.role} avatar={me.data?.avatar} />
      <CommandPalette />
    </>
  );
}

/**
 * Analytics — the deep breakdowns. The Overview is now a focused summary (Figma), so the detailed
 * sections that used to sit there (auto-insights, рост/история, лучшее время, скорость, сравнение)
 * live here alongside the TG breakdowns + hashtag lift.
 */
const ANALYTICS_TABS = [
  { key: 'dynamics', label: 'Динамика' },
  { key: 'audience', label: 'Аудитория' },
  { key: 'content', label: 'Контент' },
  { key: 'compare', label: 'Сравнение' },
] as const;
type AnalyticsTab = (typeof ANALYTICS_TABS)[number]['key'];

function Analytics() {
  const [tab, setTab] = useState<AnalyticsTab>('dynamics');
  return (
    <div className="space-y-8">
      {/* Grouped tabs break the 20-chart wall into Динамика / Аудитория / Контент / Сравнение —
          each tab renders only its section family (progressive disclosure). */}
      <div role="tablist" aria-label="Разделы аналитики" className="flex gap-1 overflow-x-auto border-b border-border">
        {ANALYTICS_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={cn(
              'shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none',
              tab === t.key ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'dynamics' && (
        <div className="space-y-10">
          <TgAnalytics group="dynamics" />
          <HistoryChartBlock />
          <VelocityChartBlock />
        </div>
      )}
      {tab === 'audience' && (
        <div className="space-y-10">
          <TgAnalytics group="audience" />
          <HeatmapChartBlock />
        </div>
      )}
      {tab === 'content' && (
        <div className="space-y-10">
          <TgAnalytics group="content" />
          <Hashtags />
        </div>
      )}
      {tab === 'compare' && (
        <div className="space-y-10">
          <AnalyticsSection title="Сравнение периодов">
            <Compare />
          </AnalyticsSection>
          <AnalyticsSection title="Авто-инсайты">
            <Insights />
          </AnalyticsSection>
        </div>
      )}
    </div>
  );
}

function AnalyticsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-base font-medium tracking-tight text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      {children}
    </div>
  );
}
