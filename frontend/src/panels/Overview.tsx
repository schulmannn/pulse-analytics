import { Link, useNavigate } from 'react-router-dom';
import { useChannels, useHistory, useTgFull, useTgQrStatus } from '@/api/queries';
import { useSelectedChannel } from '@/lib/channel-context';
import { useWidgetPeriod } from '@/lib/period';
import { pctDelta, subscriberChange } from '@/lib/delta';
import { fmt } from '@/lib/format';
import { freshness, latestHistoryDay } from '@/lib/freshness';
import { overviewHealthBanner } from '@/lib/connectionHealth';
import { cn } from '@/lib/utils';
import { CollectorEmptyState } from '@/components/CollectorEmptyState';
import { GetStarted } from '@/pages/GetStarted';
import { useDemo } from '@/lib/demo-context';
import { Sparkline } from '@/components/Sparkline';
import { ChartCardBody, ChartSection } from '@/components/ChartWidget';
import { WidgetGroup } from '@/components/widgets/WidgetGroup';
import { SubscriberHistoryChart, SubscriberHistoryBars } from '@/panels/Charts';
import { TgViewsBody, TgAvgReachBody, TgReactionsBody, TgErBody, useTgKpis } from '@/panels/KpiGrid';
import { NarrativeWeekBlock } from '@/panels/NarrativeWeek';
import { TopPosts } from '@/panels/TopPosts';
import { ChangeSummary } from '@/panels/ChangeSummary';

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
  // One canonical derive for all five Overview KPI cards. React Query already shares the fetches;
  // sharing this state also avoids repeating the period-window reductions in every sibling.
  const kpis = useTgKpis();

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
      <HealthBanner source={channel?.source} />

      {/* Independent, source-honest widgets on the 6-col grid (the old aggregate «Показатели» hero
          split into five): row 1 = the two primary cards (Просмотры half + Подписчики half), row 2 =
          the three compact non-temporal comparisons (Ср. охват / Реакции / Вовлечённость, third
          each), then the week narrative, the period-context strip and top posts. Every card reads
          the page period (feed-controlled), so one header change re-windows the whole board.
          grid-flow-dense backfills the holes a CSS-order move of a span-2 card would leave. */}
      <WidgetGroup id="overview-v2" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
        {/* Explicit ids: the Аналитика block renders widgets with the same display titles on
            the SAME feed page — default title-ids would make them share prefs (hide one →
            both vanish). id kept as `overview-hero` (this IS the lead card now) so deep-links and
            the shared page-period plumbing keep resolving. */}
        <ChartSection id="overview-hero" title="Просмотры" defaultSize="half" defaultColor={1} periodControl drillTo="/metrics/views">
          {/* The one honest daily series at the lead: channel views over the period (area spark). */}
          <TgViewsBody state={kpis} />
        </ChartSection>
        {/* Subscriber base + movement — the second primary channel signal (reuses the `growth`
            curated Home key, so «На главную» pins the same card it already knew). */}
        <GrowthChartBlock id="overview-growth" homeKey="growth" defaultColor={5} />
        {/* Row 2 — compact comparisons at third width (NEVER a tiny timeline here): value + Δ + a
            two-bar current/previous read, each with its own title, menu and drill route. */}
        <ChartSection id="overview-avg-reach" title="Ср. охват" defaultSize="third" defaultColor={2} drillTo="/metrics/avgReach">
          <TgAvgReachBody state={kpis} />
        </ChartSection>
        <ChartSection id="overview-reactions" title="Реакции" defaultSize="third" defaultColor={4} drillTo="/metrics/reactions">
          <TgReactionsBody state={kpis} />
        </ChartSection>
        <ChartSection id="overview-er" title="Вовлечённость" defaultSize="third" defaultColor={6} drillTo="/metrics/er">
          <TgErBody state={kpis} />
        </ChartSection>
        {/* The product grid supports S / M / L (33 / 50 / 100), so the narrative pairs honestly at
            M / M with one strongest measured period change. An unsupported two-thirds footprint
            would violate the widget contract. */}
        <NarrativeWeekBlock id="overview-week" homeKey="week" fixedSize="half" />
        <ChartSection
          id="overview-change-summary"
          title="Главное изменение"
          fixedSize="half"
          noExpand
        >
          <ChangeSummary compact />
        </ChartSection>
        <ChartSection
          id="overview-top-posts"
          title="Лучшие публикации"
          defaultSize="full"
          periodControl
          homeKey="top-posts"
          action={
            <Link to="/posts" className="shrink-0 text-xs font-medium text-primary hover:underline">
              <span className="md:hidden">Контент →</span><span className="hidden md:inline">Открыть контент →</span>
            </Link>
          }
        >
          <TopPosts />
        </ChartSection>
      </WidgetGroup>
    </div>
  );
}

/** Data health on the Overview appears ONLY as a warning — a healthy "200 OK" doesn't earn a slot.
    Exact state drives copy/tone/CTA (see lib/connectionHealth): a managed-QR channel (source='qr')
    reads the shared GET /api/tg/qr/status — connection_state='reauth_required' means the stored
    Telegram session actually died, so we warn immediately (error tone) with a reconnect CTA even
    BEFORE the archive goes stale; 'degraded' is a transient outage (no reconnect ask); otherwise only
    genuinely stale history earns an honest freshness nudge. Collector/central sources warn on stale
    history alone with source-appropriate copy — freshness NEVER implies revocation. The QR status
    query stays disabled unless the source is 'qr' (the hook call itself is unconditional). */
function HealthBanner({ source }: { source?: string | null }) {
  const isQr = source === 'qr';
  const isCentral = source === 'central';
  // Fetch the shared session status for QR OR central (the central owner is discovered FROM the
  // response's `central_owner`, so the fetch must run before we know ownership). Non-owner central and
  // other sources ignore connection_state and fall back to freshness-only banners.
  const { data: history } = useHistory(730);
  const { data: qrStatus } = useTgQrStatus(isQr || isCentral);
  const centralOwner = isCentral ? !!qrStatus?.central_owner : false;
  const managed = isQr || (isCentral && centralOwner);
  const fresh = freshness(latestHistoryDay(history), Date.now());
  const banner = overviewHealthBanner({
    source,
    connectionState: managed ? qrStatus?.connection_state ?? null : null,
    fresh,
    centralOwner,
  });
  if (!banner) return null;
  const toneClasses =
    banner.tone === 'error' ? 'border-ember/30 text-ember' : 'border-status-warn/30 text-status-warn';
  const dotClass = banner.tone === 'error' ? 'bg-ember' : 'bg-status-warn';
  return (
    <div className={cn('mb-6 flex flex-wrap items-center gap-2 rounded border px-3 py-2 text-sm', toneClasses)}>
      <span aria-hidden="true" className={cn('h-1.5 w-1.5 shrink-0 rounded-full', dotClass)} />
      <span>{banner.message}</span>
      {banner.cta && (
        <Link to={banner.cta.to} className="ml-auto shrink-0 text-xs font-medium underline underline-offset-2">
          {banner.cta.label}
        </Link>
      )}
    </div>
  );
}

/** Subscriber base over the period — the second most important channel state (the hero is views).
    Reads its OWN widget window (useWidgetPeriod), not the global period. Exported (bare content,
    no own ChartSection) so the personal-Home registry can reuse it under a home-scoped card. */
/** «Рост подписчиков» wrapper: the compact SubscriberGrowth card body, but «Развернуть» now opens the
    SAME full subscriber chart the history widget does (full-height axes + Мин/Макс/Среднее stats strip
    + period pills + line↔bar + reference lines) instead of a tiny sparkline over an empty fullscreen. */
export function GrowthChartBlock({ id, homeKey, defaultColor }: { id?: string; homeKey?: string; defaultColor?: number } = {}) {
  const { data } = useHistory(730);
  const rows = (data?.rows ?? []).filter((r) => r.subscribers != null);
  return (
    <ChartSection
      id={id}
      homeKey={homeKey}
      title="Рост подписчиков"
      drillTo="/metrics/subscribers"
      defaultSize="half"
      defaultColor={defaultColor}
      periodControl
      expand={
        rows.length >= 2
          ? {
              renderExpanded: (days) => <SubscriberHistoryChart rows={days === 0 ? rows : rows.slice(-days)} />,
              renderExpandedBar: (days) => <SubscriberHistoryBars rows={days === 0 ? rows : rows.slice(-days)} />,
              statsFor: (days) => (days === 0 ? rows : rows.slice(-days)).map((r) => Number(r.subscribers)),
              statsSum: false, // сумма УРОВНЕЙ подписчиков по дням не имеет смысла
            }
          : undefined
      }
    >
      <SubscriberGrowth />
    </ChartSection>
  );
}

export function SubscriberGrowth() {
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

  const navigate = useNavigate();
  // Steep anatomy (owner rule): label + number + delta + signed caption bottom-left, the
  // sparkline inset to the RIGHT — the layered number-over-chart hack (and its bleed guards,
  // two prod bugs' worth) retired by construction.
  return (
    <ChartCardBody
      hero
      label={`за ${periodLabel}`}
      value={fmt.kpi(currentSubs)}
      delta={change != null ? pctDelta(currentSubs, currentSubs - change) : null}
      caption={
        change != null && change !== 0
          ? `${change > 0 ? '+' : '−'}${fmt.num(Math.abs(change))} к пред. периоду`
          : undefined
      }
      onValueClick={() => navigate('/metrics/subscribers')}
      drillLabel="Рост подписчиков"
    >
      {values.length > 1 ? (
        <Sparkline values={values} labels={labels} area strokeWidth={2} interactive caption="по дням" formatValue={fmt.num} className="h-full min-h-14 w-full" />
      ) : (
        <p className="mt-4 text-xs text-muted-foreground">Недостаточно истории для графика.</p>
      )}
    </ChartCardBody>
  );
}
