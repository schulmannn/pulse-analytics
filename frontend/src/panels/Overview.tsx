import { Link } from 'react-router-dom';
import { useChannels, useHistory, useTgFull } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { usePeriod } from '@/lib/period';
import { subscriberChange } from '@/lib/delta';
import { fmt } from '@/lib/format';
import { freshness, latestHistoryDay } from '@/lib/freshness';
import { CollectorEmptyState } from '@/components/CollectorEmptyState';
import { GetStarted } from '@/pages/GetStarted';
import { useDemo } from '@/lib/demo-context';
import { Sparkline } from '@/components/Sparkline';
import { Digest } from '@/panels/Digest';
import { KpiGrid } from '@/panels/KpiGrid';
import { TopPosts } from '@/panels/TopPosts';

/**
 * Overview — a focused summary: KPI hero + ledger, then Insight | subscriber-growth (the second
 * most important channel signal), then top posts. The data-health tech block is NOT here — a healthy
 * status only needs the tiny sidebar indicator; it surfaces on the Overview only as a warning when
 * something is wrong. The full status lives in Настройки. Analytics deep-dives are one click away.
 */
export function Overview() {
  const { demo } = useDemo();
  const { channelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();
  const { days } = usePeriod();
  const { data, isLoading, isError } = useTgFull(days);

  // First-run: a signed-in user with no channels (and not exploring the demo) gets onboarding
  // instead of an empty dashboard.
  if (!demo && channelsData && (channelsData.channels?.length ?? 0) === 0) {
    return <GetStarted />;
  }

  const channel = channelsData?.channels.find((c) => c.id === channelId);
  const isCollector = channel?.source === 'collector';
  const isEmpty = !isLoading && !isError && !data?.channel && (data?.posts?.length ?? 0) === 0;

  if (isCollector && isEmpty) {
    return <CollectorEmptyState username={channel?.username ?? ''} />;
  }

  return (
    <div>
      <StaleWarning />

      {/* KPI hero (Просмотры) + ledger (Подписчики / Ср.охват / Реакции / ER) */}
      <KpiGrid />

      {/* Главный инсайт | Рост подписчиков (мини-график) */}
      <div className="mt-8 grid grid-cols-1 gap-8 border-t border-border pt-8 lg:grid-cols-2 lg:gap-12">
        <Digest />
        <SubscriberGrowth />
      </div>

      {/* Топ постов */}
      <section className="mt-8 space-y-4 border-t border-border pt-8">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium tracking-wide text-muted-foreground">Топ постов</h2>
          <Link to="/analytics" className="shrink-0 text-sm font-medium text-primary hover:underline">
            <span className="md:hidden">Аналитика →</span><span className="hidden md:inline">Открыть аналитику →</span>
          </Link>
        </div>
        <TopPosts />
      </section>
    </div>
  );
}

/** Data health on the Overview appears ONLY as a warning — a healthy "200 OK" doesn't earn a slot. */
function StaleWarning() {
  const { data: history } = useHistory(730);
  const fresh = freshness(latestHistoryDay(history), Date.now());
  if (!fresh || !fresh.stale) return null;
  return (
    <div className="mb-6 flex flex-wrap items-center gap-2 rounded border border-status-warn/30 px-3 py-2 text-sm text-status-warn">
      <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-status-warn" />
      Данные устарели — обновлено {fresh.label}.
      <Link to="/settings" className="ml-auto text-xs font-medium underline underline-offset-2">Настроить сбор →</Link>
    </div>
  );
}

/** Subscriber base over the period — the second most important channel state (the hero is views). */
function SubscriberGrowth() {
  const { days, range, inRange } = usePeriod();
  const { data: history } = useHistory(730);
  const { channelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();
  const current = channelsData?.channels.find((c) => c.id === channelId);

  const rows = (history?.rows ?? [])
    .filter((r) => r.subscribers != null && inRange(r.day))
    .sort((a, b) => a.day.localeCompare(b.day));
  const values = rows.map((r) => Number(r.subscribers));
  const labels = rows.map((r) => fmt.day(r.day));
  const currentSubs = current?.memberCount ?? (values.length ? values[values.length - 1] : 0);
  const change = range ? null : subscriberChange(history?.rows ?? [], days);
  const periodLabel = days === 0 ? 'всё время' : `${days} дн.`;

  return (
    <div>
      <h2 className="text-sm font-medium tracking-wide text-muted-foreground">Рост подписчиков · {periodLabel}</h2>
      <div className="mt-3 flex items-baseline gap-2.5">
        <div className="text-hero font-medium leading-none tabular-nums tracking-tight">{fmt.num(currentSubs)}</div>
        {change != null && change !== 0 && (
          <span className={`text-sm font-medium tabular-nums ${change > 0 ? 'text-verdant' : 'text-ember'}`}>
            {change > 0 ? '+' : '−'}{fmt.num(Math.abs(change))}
          </span>
        )}
      </div>
      {values.length > 1 ? (
        <div className="mt-4 max-w-md">
          <Sparkline values={values} labels={labels} area strokeWidth={2} interactive caption="по дням" formatValue={fmt.num} className="h-16 w-full" />
        </div>
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">Недостаточно истории для графика.</p>
      )}
    </div>
  );
}
