import { Link } from 'react-router-dom';
import { useChannels, useHistory, useTgFull } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { useWidgetPeriod } from '@/lib/period';
import { subscriberChange } from '@/lib/delta';
import { fmt } from '@/lib/format';
import { freshness, latestHistoryDay } from '@/lib/freshness';
import { CollectorEmptyState } from '@/components/CollectorEmptyState';
import { GetStarted } from '@/pages/GetStarted';
import { useDemo } from '@/lib/demo-context';
import { Sparkline } from '@/components/Sparkline';
import { ChartSection, WidgetGroup } from '@/components/ChartWidget';
import { Digest } from '@/panels/Digest';
import { KpiGrid } from '@/panels/KpiGrid';
import { TopPosts } from '@/panels/TopPosts';

/**
 * Overview — a focused summary, all of it widgets: KPI hero + ledger («Показатели»), then
 * Insight | subscriber-growth (the second most important channel signal), then top posts —
 * one reorderable WidgetGroup grid. The data-health tech block is NOT here — a healthy
 * status only needs the tiny sidebar indicator; it surfaces on the Overview only as a warning when
 * something is wrong. The full status lives in Настройки. Analytics deep-dives are one click away.
 */
export function Overview() {
  const { demo } = useDemo();
  const { channelId } = useSelectedChannel();
  const { data: channelsData } = useChannels();
  // ONE wide fetch (limit 100 = server cap) for the whole panel — every widget below filters
  // this payload to its OWN window. The panel-level fetch only gates the empty-state, so it must
  // NOT depend on any widget's period (a narrow window could wrongly read as "empty").
  const { data, isPending, isError } = useTgFull(0);

  // First-run: a signed-in user with no channels (and not exploring the demo) gets onboarding
  // instead of an empty dashboard.
  if (!demo && channelsData && (channelsData.channels?.length ?? 0) === 0) {
    return <GetStarted />;
  }

  const channel = channelsData?.channels.find((c) => c.id === channelId);
  const isCollector = channel?.source === 'collector';
  const isEmpty = !isPending && !isError && !data?.channel && (data?.posts?.length ?? 0) === 0;

  if (isCollector && isEmpty) {
    return <CollectorEmptyState username={channel?.username ?? ''} />;
  }

  return (
    <div>
      <StaleWarning />

      {/* Показатели | Инсайт | Рост подписчиков | Топ постов — ONE reorderable widget grid
          (owner call: the hero is a widget like everything else; grid-flow-dense backfills
          the holes a CSS-order move of a span-2 card would otherwise leave). */}
      <WidgetGroup id="overview" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
        {/* Explicit ids: the Аналитика block renders widgets with the same display titles on
            the SAME feed page — default title-ids would make them share prefs (hide one →
            both vanish). */}
        {/* Widget label «Показатели», NOT «Обзор» — the feed block's h2 right above already
            says «Обзор»; repeating it in the menu row would read as a stutter. */}
        <ChartSection id="overview-hero" title="Показатели" defaultSize="full" periodControl>
          {/* KPI hero (Просмотры · окно виджета) + ledger (Подписчики / Ср.охват / Реакции / ER) */}
          <KpiGrid />
        </ChartSection>
        <ChartSection id="overview-digest" title="Инсайт" periodControl>
          <Digest />
        </ChartSection>
        <ChartSection id="overview-growth" title="Рост подписчиков" periodControl>
          <SubscriberGrowth />
        </ChartSection>
        <ChartSection
          id="overview-top-posts"
          title="Топ постов"
          defaultSize="full"
          periodControl
          action={
            <Link to="/analytics" className="shrink-0 text-xs font-medium text-primary hover:underline">
              <span className="md:hidden">Аналитика →</span><span className="hidden md:inline">Открыть аналитику →</span>
            </Link>
          }
        >
          <TopPosts />
        </ChartSection>
      </WidgetGroup>
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
      Данные устарели — последний сбор {fresh.label}.
      <Link to="/settings" className="ml-auto text-xs font-medium underline underline-offset-2">Настроить сбор →</Link>
    </div>
  );
}

/** Subscriber base over the period — the second most important channel state (the hero is views).
    Reads its OWN widget window (useWidgetPeriod), not the global period. */
function SubscriberGrowth() {
  const { days, inRange } = useWidgetPeriod();
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
  // Per-widget windows are presets only (no custom range), so the paired-window Δ always applies.
  const change = subscriberChange(history?.rows ?? [], days);
  const periodLabel = days === 0 ? 'всё время' : `${days} дн.`;

  return (
    <div>
      {/* The widget shell carries the «Рост подписчиков» title; the period label stays as a caption. */}
      <div className="text-2xs tracking-wide text-muted-foreground">за {periodLabel}</div>
      <div className="mt-2 flex items-baseline gap-2.5">
        {/* The number opens the subscriber metric page (same affordance as the KPI ledger). */}
        <Link
          to="/metrics/subscribers"
          aria-label="Страница метрики: Подписчики"
          className="rounded text-hero font-medium leading-none tabular-nums tracking-tight transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          {fmt.num(currentSubs)}
        </Link>
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
