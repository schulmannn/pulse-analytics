import type { ReactNode } from 'react';
import { Navigate, Routes, Route } from 'react-router-dom';
import { useMe } from '@/api/queries';
import { ApiError } from '@/api/client';
import { DashboardLayout } from '@/components/DashboardLayout';
import { LoginPage, RegisterPage, ResetPage, VerifyPage } from '@/pages/Auth';
import { Landing } from '@/pages/Landing';
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
        <Route path="charts" element={<Charts />} />
        <Route path="posts" element={<Posts />} />
        <Route path="mentions" element={<Mentions />} />
        <Route path="settings" element={<Settings />} />
        <Route path="admin" element={<Admin />} />
        <Route path="bugs" element={<Bugs />} />
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
          <h2 className="text-lg font-semibold">Не удалось загрузить</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {me.error instanceof Error ? me.error.message : 'Неизвестная ошибка'}
          </p>
        </div>
      </Centered>
    );
  }

  return (
    <>
      <DashboardLayout email={me.data?.email} role={me.data?.role} />
      <CommandPalette />
    </>
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
