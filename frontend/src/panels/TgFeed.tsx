import { Suspense, lazy, useMemo } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useChannels, useHistory, useTgFull } from '@/api/queries';
import { latestDataMs } from '@/lib/freshness';
import { ChannelRecencyProvider, PagePeriodProvider, usePagePeriod } from '@/lib/period';
import { PeriodChips } from '@/components/PeriodChips';
import { parseContentPeriod } from '@/lib/contentFilters';
import { lazyWithReload } from '@/lib/lazyWithReload';

const Overview = lazy(
  lazyWithReload(() =>
    import('@/panels/Overview').then((module) => ({ default: module.Overview })),
  ),
);

/**
 * TG feed SHELL — the network-wide chrome for the four focused TG pages (Обзор · Аналитика ·
 * Контент · Упоминания). What each section renders lives in the FEED REGISTRY
 * (panels/feed/feeds.tsx) — this module only owns what is genuinely network-wide: the
 * channel-recency context, the page-period provider, and the no-channels onboarding gate.
 */

/**
 * Layout route for the TG feed pages: owns the channel-recency context they all read (the same
 * wide fetch every panel already makes — React Query dedupes, so no extra request) and renders the
 * addressed page through <Outlet/>. Without a channel the whole set collapses to the Overview
 * onboarding (GetStarted), exactly as before — no empty analytics/posts noise.
 */
export function TgSectionLayout() {
  const location = useLocation();
  const { data: channelsData } = useChannels();
  const { data: tgFull } = useTgFull(0);
  const { data: history } = useHistory(730);
  const recency = useMemo(() => latestDataMs(tgFull?.posts, history), [tgFull, history]);

  const noChannels = channelsData !== undefined && (channelsData.channels?.length ?? 0) === 0;
  if (noChannels) {
    // Overview self-gates to GetStarted; keep its chart stack out of the protected shell closure.
    return (
      <Suspense fallback={<div className="min-h-[70vh]" />}>
        <Overview />
      </Suspense>
    );
  }

  // PagePeriodProvider persists the authoritative header period across TG page navigation
  // (Обзор ↔ Аналитика); every feed card resolves to this same window.
  // ТОЛЬКО когда `?period=` реально стоит в ссылке. parseContentPeriod возвращает дефолтные 30 и
  // при отсутствии параметра, поэтому передавать его безусловно значило бы, что /posts и /mentions
  // вечно перебивают сохранённое окно тридцаткой — ровно тот сброс, который чинится общим store.
  const periodParam = new URLSearchParams(location.search).get('period');
  const initialDays =
    periodParam != null && (location.pathname === '/posts' || location.pathname === '/mentions')
      ? parseContentPeriod(periodParam)
      : undefined;

  return (
    <PagePeriodProvider initialDays={initialDays}>
      <ChannelRecencyProvider value={recency}>
        <Outlet />
      </ChannelRecencyProvider>
    </PagePeriodProvider>
  );
}

/** Feed-header period chips wired to the page period — re-windows every card on the page. Now at
    full IG parity: 7д/30д/90д/Всё + a «Свой период» custom range (the TG card bodies read the page
    range through widgetPeriodValue). Null outside the provider (defensive; TG pages always have one).
    Exported as the TG sections' HeaderRight in the feed registry. */
export function TgPagePeriodControl() {
  const pp = usePagePeriod();
  if (!pp) return null;
  return <PeriodChips value={pp.days} onChange={pp.setDays} range={pp.range} onRangeChange={pp.setRange} />;
}
