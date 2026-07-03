import { useMemo, type ReactNode } from 'react';
import { useChannels, useHistory, useTgFull } from '@/api/queries';
import { latestDataMs } from '@/lib/freshness';
import { ChannelRecencyProvider } from '@/lib/period';
import { NotFound } from '@/components/NotFound';
import { Overview } from '@/panels/Overview';
import { Analytics } from '@/panels/AnalyticsTabs';
import { Posts } from '@/panels/Posts';
import { Mentions } from '@/panels/Mentions';
import { useFeed, FeedBlock, type FeedBlockDef } from '@/panels/feed/useFeed';

/**
 * TG feed — the steep-Home reading model (owner call): Обзор → Аналитика → Посты →
 * Упоминания as ONE scrollable page. The scroll machinery (deep-link jump, scrollspy,
 * lazy blocks) lives in the shared {@link useFeed} engine, which IgFeed reuses verbatim.
 * The four old routes stay valid: they all resolve to this feed scrolled to the right block.
 */

const BLOCKS: readonly FeedBlockDef<'' | 'analytics' | 'posts' | 'mentions'>[] = [
  { section: '', path: '/', title: 'Обзор' },
  { section: 'analytics', path: '/analytics', title: 'Аналитика' },
  { section: 'posts', path: '/posts', title: 'Посты' },
  { section: 'mentions', path: '/mentions', title: 'Упоминания' },
];
type FeedSection = (typeof BLOCKS)[number]['section'];

function renderBlock(section: FeedSection): ReactNode {
  switch (section) {
    case '':
      return <Overview />;
    case 'analytics':
      return <Analytics />;
    case 'posts':
      return <Posts />;
    case 'mentions':
      return <Mentions />;
  }
}

export function TgFeed() {
  const { data: channelsData } = useChannels();
  // Same wide fetch every block already makes (React Query dedupes → no extra request); used only to
  // learn the channel's newest-data timestamp so widget cards can widen an empty window (dormant /
  // just-connected channels whose posts are all old otherwise render «0» and look broken).
  const { data: tgFull } = useTgFull(0);
  const { data: history } = useHistory(730);
  const recency = useMemo(() => latestDataMs(tgFull?.posts, history), [tgFull, history]);
  const feed = useFeed(BLOCKS);

  if (feed.unknownSection) return <NotFound />;

  // Without a single channel the Overview shows the GetStarted onboarding — the rest of the feed
  // would be empty-state noise below it.
  const noChannels = channelsData !== undefined && (channelsData.channels?.length ?? 0) === 0;
  if (noChannels) return <Overview />;

  return (
    <ChannelRecencyProvider value={recency}>
      <div ref={feed.containerRef} className="space-y-10">
        {BLOCKS.map((block, i) => (
          <FeedBlock
            key={block.section}
            section={block.section}
            title={block.title}
            eager={i <= Math.max(feed.mountedUpTo, 0)}
            onMount={() => feed.markMounted(i)}
          >
            {renderBlock(block.section)}
          </FeedBlock>
        ))}
      </div>
    </ChannelRecencyProvider>
  );
}
