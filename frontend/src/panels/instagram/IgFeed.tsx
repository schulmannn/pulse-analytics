import { useEffect, useState } from 'react';
import { Outlet, useLocation, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useIgData } from '@/lib/useIgData';
import type { IgData } from '@/lib/useIgData';
import { useSelectedChannel } from '@/lib/channel-context';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { usePagePeriod } from '@/lib/period';
import { PeriodChips } from '@/components/PeriodChips';
import { IgConnectPanel } from '@/components/instagram/health';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { IgContentPageSkeleton } from '@/panels/instagram/IgContentDesktop';
import { IgOverview } from '@/panels/instagram/IgOverview';
import { IgAnalytics } from '@/panels/instagram/IgAnalytics';
import { IgContent } from '@/panels/instagram/IgContent';
import { IgAudience } from '@/panels/instagram/IgAudience';

/**
 * IG feed SHELL — the IG side now runs the SAME focused-pages model as TG: one layout route with
 * network-wide chrome (account header, data health, OAuth-callback notices, the demo connect
 * panel, the loading/error gates) and the addressed section rendered через <Outlet/>. What each
 * section renders lives in the FEED REGISTRY (panels/feed/feeds.tsx) — this closed the last
 * structural TG↔IG fork (TG = pages, IG = scroll-feed), and the scroll engine (useFeed) retired
 * with it.
 *
 * Data delivery: the shell calls {@link useIgData} ONCE and hands the cluster to the section
 * pages via Outlet context (the focused-pages twin of the old feed's prop threading) — the ig-*
 * queries stay deduped by React Query, and the igMetrics math runs once per page, not once per
 * section body.
 */

// Plain-language messages for the ?ig_error= codes the OAuth callback bounces back with.
const IG_ERROR_MESSAGES: Record<string, string> = {
  denied: 'Доступ в Instagram не подтверждён — подключение отменено.',
  state: 'Ссылка подключения истекла — попробуйте ещё раз.',
  server: 'Подключение Instagram не настроено на сервере.',
  auth: 'Сессия недействительна — войдите снова и повторите.',
  channel: 'Нет доступа к выбранному каналу.',
  exchange: 'Instagram не выдал токен — попробуйте ещё раз.',
  identity: 'Не удалось получить данные аккаунта Instagram.',
  busy: 'Сейчас слишком много подключений Instagram — повторите через минуту.',
};

/** Reads the OAuth callback flag (?ig=connected / ?ig_error=…) once, refetches IG data on success,
 *  then strips the flag from the URL so a reload doesn't re-show the banner. */
function useIgConnectNotice() {
  const qc = useQueryClient();
  const { setChannelId } = useSelectedChannel();
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
    if (connected) {
      // The callback names the (possibly freshly created) source — switch to it so the user
      // lands on the account they just connected, not whatever was selected before.
      const ch = parseInt(params.get('ch') ?? '', 10);
      if (Number.isFinite(ch) && ch > 0) {
        setChannelId(ch);
        qc.invalidateQueries({ queryKey: ['channels'] });
      }
      qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('ig-') });
    }
    // Strip the flag so a reload doesn't re-show it. setParams is stable, so this re-runs the effect
    // once with the flag already gone → early return, no loop. Keeping params in deps makes the
    // banner react to a fresh ?ig= landing even if the component is already mounted.
    const next = new URLSearchParams(params);
    next.delete('ig');
    next.delete('ig_error');
    next.delete('ch');
    setParams(next, { replace: true });
  }, [params, qc, setParams, setChannelId]);
  return { notice, dismiss: () => setNotice(null) };
}

/** IG period chips — the PAGE period (same follow/«Стр.» contract as the TG feed), plus the
    «Свой период» calendar the IG bodies honour (useIgData windows by the page range). One shared
    PeriodChips component for both networks; the control sits in each section's sticky header. */
export function IgPeriodControl() {
  const pp = usePagePeriod();
  if (!pp) return null;
  return <PeriodChips value={pp.days} onChange={pp.setDays} range={pp.range} onRangeChange={pp.setRange} />;
}

export function IgShell() {
  // The whole IG data cluster, fetched ONCE (React Query dedupes the underlying ig-* queries).
  const ig = useIgData();
  const { notice, dismiss } = useIgConnectNotice();
  const location = useLocation();
  const isDesktop = useMediaQuery('(min-width: 768px)');
  // A cold load landing on the desktop publications table shows a table-shaped skeleton (its own
  // geometry) rather than the generic dashboard card; every other IG route keeps the generic one.
  const onContentTable =
    isDesktop &&
    location.pathname.endsWith('/instagram/content') &&
    new URLSearchParams(location.search).get('view') !== 'campaigns';

  const banner = notice ? (
    <div
      className={cn(
        'flex items-start justify-between gap-3 rounded-lg border px-4 py-3 text-sm',
        notice.kind === 'ok' ? 'border-verdant/40 bg-verdant/5' : 'border-destructive/40 bg-destructive/4',
      )}
    >
      <span className="text-foreground">{notice.msg}</span>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Закрыть"
        className="shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="h-4 w-4" aria-hidden="true">
          <path d="M18 6 6 18" />
          <path d="M6 6l12 12" />
        </svg>
      </button>
    </div>
  ) : null;

  if (ig.loading) {
    return <div className="space-y-6">{banner}{onContentTable ? <IgContentPageSkeleton /> : <InstagramSkeleton />}</div>;
  }
  if (ig.error) {
    return (
      <div className="space-y-6">
        {banner}
        <ErrorState
          title="Не удалось загрузить данные Instagram"
          onRetry={() => {
            void ig.queries.profile.refetch();
            void ig.queries.insights.refetch();
          }}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {banner}
      {ig.isMock && <IgConnectPanel />}

      <Outlet context={ig} />
    </div>
  );
}

/** The section pages read the shell's IG cluster from the Outlet context. */
function useIg(): IgData {
  return useOutletContext<IgData>();
}

export function IgOverviewPage() {
  return <IgOverview ig={useIg()} />;
}
export function IgAnalyticsPage() {
  return <IgAnalytics ig={useIg()} />;
}
export function IgContentPage() {
  return <IgContent ig={useIg()} />;
}
export function IgAudiencePage() {
  return <IgAudience ig={useIg()} />;
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
