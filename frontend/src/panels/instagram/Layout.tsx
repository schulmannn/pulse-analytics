import { useEffect, useState } from 'react';
import { Outlet, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useIgData } from '@/lib/useIgData';
import { IgConnectPanel, IgDataHealth } from '@/components/instagram/health';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

// Plain-language messages for the ?ig_error= codes the OAuth callback bounces back with.
const IG_ERROR_MESSAGES: Record<string, string> = {
  denied: 'Доступ в Instagram не подтверждён — подключение отменено.',
  state: 'Ссылка подключения истекла — попробуйте ещё раз.',
  server: 'Подключение Instagram не настроено на сервере.',
  auth: 'Сессия недействительна — войдите снова и повторите.',
  channel: 'Нет доступа к выбранному каналу.',
  exchange: 'Instagram не выдал токен — попробуйте ещё раз.',
  identity: 'Не удалось получить данные аккаунта Instagram.',
};

/** Reads the OAuth callback flag (?ig=connected / ?ig_error=…) once, refetches IG data on success,
 *  then strips the flag from the URL so a reload doesn't re-show the banner. */
function useIgConnectNotice() {
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; msg: string } | null>(null);
  useEffect(() => {
    const connected = params.get('ig') === 'connected';
    const err = params.get('ig_error');
    if (!connected && !err) return;
    setNotice(
      connected
        ? { kind: 'ok', msg: 'Instagram подключён — загружаем реальные данные.' }
        : { kind: 'err', msg: IG_ERROR_MESSAGES[err ?? ''] || 'Не удалось подключить Instagram.' },
    );
    if (connected) qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('ig-') });
    // Strip the flag so a reload doesn't re-show it. setParams is stable, so this re-runs the effect
    // once with the flag already gone → early return, no loop. Keeping params in deps makes the
    // banner react to a fresh ?ig= landing even if the component is already mounted.
    const next = new URLSearchParams(params);
    next.delete('ig');
    next.delete('ig_error');
    setParams(next, { replace: true });
  }, [params, qc, setParams]);
  return { notice, dismiss: () => setNotice(null) };
}

/**
 * Instagram shell — the parent route for /instagram/*. Loads the IG data once and hands it to the
 * active view via Outlet context, so the four views (Обзор / Аналитика / Контент / Аудитория) stay
 * presentational and the data is computed in one place. Shows the account identity + the connect
 * panel (when in demo mode) above whichever view is mounted.
 */
export function InstagramLayout() {
  const ig = useIgData();
  const { notice, dismiss } = useIgConnectNotice();

  const banner = notice ? (
    <div
      className={cn(
        'flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm',
        notice.kind === 'ok' ? 'border-verdant/40 bg-verdant/[0.05]' : 'border-destructive/40 bg-destructive/[0.04]',
      )}
    >
      <span className="text-foreground">{notice.msg}</span>
      <button type="button" onClick={dismiss} aria-label="Закрыть" className="shrink-0 text-muted-foreground hover:text-foreground">
        ✕
      </button>
    </div>
  ) : null;

  if (ig.loading) return <div className="space-y-6">{banner}<InstagramSkeleton /></div>;
  if (ig.error) {
    return (
      <div className="space-y-6">
        {banner}
        <Card className="border-destructive/40">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Не удалось загрузить данные Instagram.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {banner}
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
