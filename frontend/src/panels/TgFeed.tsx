import { useMemo } from 'react';
import { Outlet } from 'react-router-dom';
import { useChannels, useHistory, useTgFull } from '@/api/queries';
import { latestDataMs } from '@/lib/freshness';
import { ChannelRecencyProvider, PagePeriodProvider, usePagePeriod } from '@/lib/period';
import { PeriodChips } from '@/components/PeriodChips';
import { Overview } from '@/panels/Overview';

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
  const { data: channelsData } = useChannels();
  const { data: tgFull } = useTgFull(0);
  const { data: history } = useHistory(730);
  const recency = useMemo(() => latestDataMs(tgFull?.posts, history), [tgFull, history]);

  const noChannels = channelsData !== undefined && (channelsData.channels?.length ?? 0) === 0;
  if (noChannels) return <Overview />; // GetStarted onboarding (Overview self-gates it)

  // PagePeriodProvider persists the authoritative header period across TG page navigation
  // (Обзор ↔ Аналитика); every feed card resolves to this same window.
  return (
    <PagePeriodProvider>
      <ChannelRecencyProvider value={recency}>
        <Outlet />
      </ChannelRecencyProvider>
    </PagePeriodProvider>
  );
}

/** Feed-header period chips wired to the page period — re-windows every card on the page. Null
    outside the provider (defensive; TG pages always have one). Exported as the TG sections'
    HeaderRight in the feed registry. */
export function TgPagePeriodControl() {
  const pp = usePagePeriod();
  if (!pp) return null;
  return <PeriodChips value={pp.days} onChange={pp.setDays} />;
}
