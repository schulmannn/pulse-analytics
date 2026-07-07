import { Link } from 'react-router-dom';
import { useIgData } from '@/lib/useIgData';
import { useDemo } from '@/lib/demo-context';
import { ChartSection } from '@/components/ChartWidget';
import { TrendCard, FollowsByDayCard, IgKpiBlock, SubscriberMovement } from '@/components/instagram/shared';

/**
 * Self-fetching Home wrappers for the two genuine IG daily series — the missing piece that kept
 * ALL Instagram widgets out of the Home registry (the in-feed cards take `ig` as a prop threaded
 * from IgFeed). Each wrapper calls useIgData() itself (react-query dedupes with the feed), so a
 * pinned copy is fully self-contained. HONESTY GUARD: when the server answers with ig_mock (no
 * Instagram connected), the card says so instead of quietly charting demo numbers on a board of
 * real metrics — the in-feed pages have a page-level demo banner, a lone Home card has none.
 */

function IgConnectPrompt({ id, homeKey, title }: { id?: string; homeKey?: string; title: string }) {
  return (
    <ChartSection id={id} homeKey={homeKey} title={title} noExpand>
      <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm text-muted-foreground">Подключите Instagram — карточка покажет реальные данные.</p>
        <Link to="/connect" className="text-xs font-medium text-primary hover:underline">
          Подключить →
        </Link>
      </div>
    </ChartSection>
  );
}

export function IgReachHomeCard({ id, homeKey }: { id?: string; homeKey?: string }) {
  const ig = useIgData();
  const { demo } = useDemo();
  // In the app-wide demo EVERYTHING is sample data — the mock chart is the point, not a lie.
  if (ig.error || (ig.isMock && !demo)) return <IgConnectPrompt id={id} homeKey={homeKey} title="IG · Охват по дням" />;
  return <TrendCard id={id} homeKey={homeKey} title="IG · Охват по дням" series={ig.series.reach} drillTo="/metrics/ig-reach" />;
}

export function IgFollowsHomeCard({ id, homeKey }: { id?: string; homeKey?: string }) {
  const ig = useIgData();
  const { demo } = useDemo();
  if (ig.error || (ig.isMock && !demo)) return <IgConnectPrompt id={id} homeKey={homeKey} title="IG · Подписки по дням" />;
  return <FollowsByDayCard id={id} homeKey={homeKey} title="IG · Подписки по дням" data={ig.series.follower} drillTo="/metrics/ig-follows" />;
}

export function IgMovementHomeCard({ id, homeKey }: { id?: string; homeKey?: string }) {
  const ig = useIgData();
  const { demo } = useDemo();
  if (ig.error || (ig.isMock && !demo)) return <IgConnectPrompt id={id} homeKey={homeKey} title="IG · Движение подписчиков" />;
  return (
    <ChartSection id={id} homeKey={homeKey} title="IG · Движение подписчиков" defaultSize="full" noExpand>
      <SubscriberMovement follows={ig.pairs.follows} unfollows={ig.pairs.unfollows} net={ig.netMovement} />
    </ChartSection>
  );
}

export function IgKpiHomeCard({ id, homeKey }: { id?: string; homeKey?: string }) {
  const ig = useIgData();
  const { demo } = useDemo();
  if (ig.error || (ig.isMock && !demo)) return <IgConnectPrompt id={id} homeKey={homeKey} title="IG · Показатели" />;
  return (
    <ChartSection id={id} homeKey={homeKey} title="IG · Показатели" defaultSize="full" drillTo="/metrics/ig-reach">
      <IgKpiBlock ig={ig} />
    </ChartSection>
  );
}
