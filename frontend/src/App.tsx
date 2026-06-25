import type { ReactNode } from 'react';
import { Routes, Route } from 'react-router-dom';
import { useMe } from '@/api/queries';
import { ApiError } from '@/api/client';
import { DashboardLayout } from '@/components/DashboardLayout';
import { Hero } from '@/panels/Hero';
import { KpiGrid } from '@/panels/KpiGrid';
import { Charts } from '@/panels/Charts';
import { Posts } from '@/panels/Posts';
import { Mentions } from '@/panels/Mentions';
import { TgAnalytics } from '@/panels/TgAnalytics';
import { Hashtags } from '@/panels/Hashtags';
import { Digest } from '@/panels/Digest';
import { Settings } from '@/panels/Settings';
import { Admin } from '@/panels/Admin';
import { Bugs } from '@/panels/Bugs';

export default function App() {
  const me = useMe();

  if (me.isLoading) {
    return <Centered><p className="text-sm text-muted-foreground">Загрузка…</p></Centered>;
  }

  if (me.isError) {
    const unauthorized = me.error instanceof ApiError && me.error.status === 401;
    return (
      <Centered>
        <div className="max-w-sm rounded-lg border bg-card p-6 text-center">
          <h2 className="text-lg font-semibold">{unauthorized ? 'Нужен вход' : 'Не удалось загрузить'}</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {unauthorized
              ? 'Войдите в основном дашборде, затем вернитесь сюда.'
              : me.error instanceof Error
                ? me.error.message
                : 'Неизвестная ошибка'}
          </p>
          <a href="/" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">
            ← На главный дашборд
          </a>
        </div>
      </Centered>
    );
  }

  return (
    <Routes>
      <Route element={<DashboardLayout email={me.data?.email} role={me.data?.role} />}>
        <Route index element={<Overview />} />
        <Route path="analytics" element={<Analytics />} />
        <Route path="charts" element={<Charts />} />
        <Route path="posts" element={<Posts />} />
        <Route path="mentions" element={<Mentions />} />
        <Route path="settings" element={<Settings />} />
        <Route path="admin" element={<Admin />} />
        <Route path="bugs" element={<Bugs />} />
        <Route path="*" element={<Overview />} />
      </Route>
    </Routes>
  );
}

/** Landing tab — greeting + KPI cards. */
function Overview() {
  return (
    <div className="space-y-8">
      <Hero />
      <KpiGrid />
    </div>
  );
}

/** Analytics tab — TG breakdowns + hashtag lift + auto-digest. */
function Analytics() {
  return (
    <div className="space-y-8">
      <TgAnalytics />
      <Hashtags />
      <Digest />
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      {children}
    </div>
  );
}
