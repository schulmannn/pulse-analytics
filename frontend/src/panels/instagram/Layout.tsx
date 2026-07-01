import { Outlet } from 'react-router-dom';
import { useIgData } from '@/lib/useIgData';
import { IgConnectPanel, IgDataHealth } from '@/components/instagram/health';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Instagram shell — the parent route for /instagram/*. Loads the IG data once and hands it to the
 * active view via Outlet context, so the four views (Обзор / Аналитика / Контент / Аудитория) stay
 * presentational and the data is computed in one place. Shows the account identity + the connect
 * panel (when in demo mode) above whichever view is mounted.
 */
export function InstagramLayout() {
  const ig = useIgData();

  if (ig.loading) return <InstagramSkeleton />;
  if (ig.error) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Не удалось загрузить данные Instagram.
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-medium tracking-tight">
            Instagram{ig.profile?.username ? ` · @${ig.profile.username}` : ''}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {ig.isMock ? 'Демо-режим — примерные данные' : 'Аккаунт, аудитория, форматы и публикации'}
          </p>
        </div>
        {/* Tiny data-status indicator lives in the header (account-card area), not the content column. */}
        <div className="min-w-[180px] shrink-0 pt-1">
          <IgDataHealth accountName={ig.profile?.username} lastSync={ig.lastSync} isMock={ig.isMock} />
        </div>
      </header>
      {ig.isMock && <IgConnectPanel />}
      <Outlet context={ig} />
    </div>
  );
}

function InstagramSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="space-y-3 p-4">
          <Skeleton className="h-3 w-1/4" />
          <Skeleton className="h-10 w-2/5" />
          <Skeleton className="h-16 w-full" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Skeleton key={i} className="h-32 w-full" />
        ))}
      </div>
    </div>
  );
}
