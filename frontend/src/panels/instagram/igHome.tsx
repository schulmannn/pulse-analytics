import { Link } from 'react-router-dom';
import { useIgData, type IgData } from '@/lib/useIgData';
import { useDemo } from '@/lib/demo-context';
import { ChartSection } from '@/components/ChartWidget';
import { TrendCard, IgKpiBlock, SubscriberMovement, igPeriodRows } from '@/components/instagram/shared';
import { InsightsBlock, PeriodCompareBlock } from '@/components/instagram/insights';

/**
 * Self-fetching Home wrappers for the two genuine IG daily series — the missing piece that kept
 * ALL Instagram widgets out of the Home registry (the in-feed cards take `ig` as a prop threaded
 * from IgFeed). Each wrapper calls useIgData() itself (react-query dedupes with the feed), so a
 * pinned copy is fully self-contained. HONESTY GUARD: when the server answers with ig_mock (no
 * Instagram connected), the card says so instead of quietly charting demo numbers on a board of
 * real metrics — the in-feed pages have a page-level demo banner, a lone Home card has none.
 */

type PromptProps = { id?: string; homeKey?: string; title: string };

function IgConnectPrompt({ id, homeKey, title }: PromptProps) {
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

/** Истёкший доступ ≠ «не подключено»: путь наружу другой (переподключить, а не подключить), и на
 *  доске реальных метрик карточка обязана назвать причину, а не молча предлагать подключение. */
function IgReauthPrompt({ id, homeKey, title }: PromptProps) {
  return (
    <ChartSection id={id} homeKey={homeKey} title={title} noExpand>
      <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm text-muted-foreground">Доступ к Instagram истёк — данные не обновляются.</p>
        <Link to="/connect?source=instagram" className="text-xs font-medium text-primary hover:underline">
          Переподключить →
        </Link>
      </div>
    </ChartSection>
  );
}

/** Одна заглушка на все шесть карточек: порядок проверок — состояние доступа, потом сбой, потом
 *  демо. `null` = карточке есть что показать. */
function igCardFallback(ig: IgData, demo: boolean, props: PromptProps) {
  if (ig.reauth) return <IgReauthPrompt {...props} />;
  if (ig.error || (ig.isMock && !demo)) return <IgConnectPrompt {...props} />;
  return null;
}

export function IgReachHomeCard({ id, homeKey }: { id?: string; homeKey?: string }) {
  const ig = useIgData();
  const { demo } = useDemo();
  // In the app-wide demo EVERYTHING is sample data — the mock chart is the point, not a lie.
  const fallback = igCardFallback(ig, demo, { id, homeKey, title: 'IG · Охват по дням' });
  if (fallback) return fallback;
  return <TrendCard id={id} homeKey={homeKey} title="IG · Охват по дням" series={ig.series.reach} drillTo="/metrics/ig-reach" />;
}

export function IgFollowsHomeCard({ id, homeKey }: { id?: string; homeKey?: string }) {
  const ig = useIgData();
  const { demo } = useDemo();
  const fallback = igCardFallback(ig, demo, { id, homeKey, title: 'IG · Динамика подписчиков' });
  if (fallback) return fallback;
  return (
    <TrendCard
      id={id}
      homeKey={homeKey}
      title="IG · Динамика подписчиков"
      series={ig.series.followerLevel}
      seriesKind="level"
      drillTo="/metrics/ig-follows"
    />
  );
}

export function IgMovementHomeCard({ id, homeKey }: { id?: string; homeKey?: string }) {
  const ig = useIgData();
  const { demo } = useDemo();
  const fallback = igCardFallback(ig, demo, { id, homeKey, title: 'IG · Движение подписчиков' });
  if (fallback) return fallback;
  return (
    <ChartSection id={id} homeKey={homeKey} title="IG · Движение подписчиков" defaultSize="full" noExpand>
      <SubscriberMovement follows={ig.pairs.follows} unfollows={ig.pairs.unfollows} net={ig.netMovement} />
    </ChartSection>
  );
}

export function IgCompareHomeCard({ id, homeKey }: { id?: string; homeKey?: string }) {
  const ig = useIgData();
  const { demo } = useDemo();
  const fallback = igCardFallback(ig, demo, { id, homeKey, title: 'IG · Сравнение периодов' });
  if (fallback) return fallback;
  return (
    <ChartSection id={id} homeKey={homeKey} title="IG · Сравнение периодов" defaultSize="full" noExpand>
      <PeriodCompareBlock rows={igPeriodRows(ig)} />
    </ChartSection>
  );
}

export function IgInsightsHomeCard({ id, homeKey }: { id?: string; homeKey?: string }) {
  const ig = useIgData();
  const { demo } = useDemo();
  const fallback = igCardFallback(ig, demo, { id, homeKey, title: 'IG · Главное' });
  if (fallback) return fallback;
  return (
    <ChartSection id={id} homeKey={homeKey} title="IG · Главное" defaultSize="full" noExpand>
      <InsightsBlock insights={ig.insights} limit={4} />
    </ChartSection>
  );
}

export function IgKpiHomeCard({ id, homeKey }: { id?: string; homeKey?: string }) {
  const ig = useIgData();
  const { demo } = useDemo();
  const fallback = igCardFallback(ig, demo, { id, homeKey, title: 'IG · Показатели' });
  if (fallback) return fallback;
  return (
    <ChartSection id={id} homeKey={homeKey} title="IG · Показатели" defaultSize="full" drillTo="/metrics/ig-reach">
      <IgKpiBlock ig={ig} />
    </ChartSection>
  );
}
