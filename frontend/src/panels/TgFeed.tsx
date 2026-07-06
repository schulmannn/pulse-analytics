import { useMemo, type ReactNode } from 'react';
import { Navigate, Outlet } from 'react-router-dom';
import { useChannels, useHistory, useTgFull } from '@/api/queries';
import { latestDataMs } from '@/lib/freshness';
import { ChannelRecencyProvider, PagePeriodProvider, usePagePeriod } from '@/lib/period';
import { PeriodChips } from '@/components/PeriodChips';
import { Overview } from '@/panels/Overview';
import { Analytics } from '@/panels/AnalyticsTabs';
import { Posts } from '@/panels/Posts';
import { Mentions } from '@/panels/Mentions';
import { FeedBlock } from '@/panels/feed/useFeed';

/**
 * TG dashboard — FOCUSED pages (Страницы/IA split): Обзор · Аналитика · Посты · Упоминания are now
 * their OWN routes rather than one long scroll-feed. Each renders a single panel inside the same
 * section shell it had in the feed (rounded card + sticky fat header — reused via {@link FeedBlock}),
 * so the per-section look is unchanged; only the model flips from scroll-anchors to real navigation.
 * The sidebar's NavLinks drive it directly (the scrollspy is gone here). The single-scroll engine
 * ({@link useFeed}) still powers IgFeed verbatim — the IG split is a separate follow-up card.
 */

type TgSection = '' | 'analytics' | 'posts' | 'mentions';

const SECTION_META: Record<TgSection, { title: string; render: () => ReactNode }> = {
  '': { title: 'Обзор', render: () => <Overview /> },
  analytics: { title: 'Аналитика', render: () => <Analytics /> },
  posts: { title: 'Посты', render: () => <Posts /> },
  mentions: { title: 'Упоминания', render: () => <Mentions /> },
};

/**
 * Layout route for the four TG feed pages: owns the channel-recency context they all read (the same
 * wide fetch every panel already makes — React Query dedupes, so no extra request) and renders the
 * addressed page through <Outlet/>. Without a channel the whole set collapses to the Overview
 * onboarding (GetStarted), exactly as the old feed did — no empty analytics/posts noise.
 */
export function TgSectionLayout() {
  const { data: channelsData } = useChannels();
  const { data: tgFull } = useTgFull(0);
  const { data: history } = useHistory(730);
  const recency = useMemo(() => latestDataMs(tgFull?.posts, history), [tgFull, history]);

  const noChannels = channelsData !== undefined && (channelsData.channels?.length ?? 0) === 0;
  if (noChannels) return <Overview />; // GetStarted onboarding (Overview self-gates it)

  // PagePeriodProvider persists the header period across TG page navigation (Обзор ↔ Аналитика);
  // it is the default window for every card without its own per-widget override.
  return (
    <PagePeriodProvider>
      <ChannelRecencyProvider value={recency}>
        <Outlet />
      </ChannelRecencyProvider>
    </PagePeriodProvider>
  );
}

/** Feed-header period chips wired to the page period — re-windows every card on the page that has
    no per-card override. Null outside the provider (defensive; TG pages always have one). */
function TgPagePeriodControl() {
  const pp = usePagePeriod();
  if (!pp) return null;
  return <PeriodChips value={pp.days} onChange={pp.setDays} />;
}

/** Sections whose cards are period-scoped analytics — they get the header period control. Posts and
    Упоминания are lists, not windowed metric cards, so they show no period selector. */
const PERIOD_SECTIONS: TgSection[] = ['', 'analytics'];

/**
 * One focused TG page: the section's panel inside its (static) section shell. `eager` mounts it
 * immediately — the lazy progressive-disclosure guard only matters for the multi-block IG feed.
 */
export function TgSection({ section }: { section: TgSection }) {
  const meta = SECTION_META[section];
  if (!meta) return <Navigate to="/" replace />;
  return (
    <FeedBlock
      section={section}
      title={meta.title}
      eager
      onMount={() => {}}
      headerRight={PERIOD_SECTIONS.includes(section) ? <TgPagePeriodControl /> : undefined}
    >
      {meta.render()}
    </FeedBlock>
  );
}
