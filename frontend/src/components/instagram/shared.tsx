import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { lttbDownsample } from '@/lib/downsample';
import { CHART_MAX_POINTS } from '@/lib/msSeries';
import { fmt } from '@/lib/format';
import { pctDelta, type MetricDelta } from '@/lib/delta';
import { DeltaPill } from '@/components/DeltaPill';
import { EmptyState } from '@/components/EmptyState';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { ChartCardBody, ChartSection as WidgetChartSection } from '@/components/ChartWidget';
import { CompactStatHeadline } from '@/components/CompareStat';
import { Sparkline } from '@/components/Sparkline';
import type { WidgetSize } from '@/lib/widgetPrefsStore';
import { fmtDay, pairDelta, windowIgSeries, type Point, type WindowPair } from '@/lib/igMetrics';
import type { IgOverviewChart } from '@/lib/igWindowMetrics';
import { calendarWindowForPeriod, periodDateTimestamp, splitCalendarRows } from '@/lib/period';
import type { WidgetPeriodValue } from '@/lib/period';
import type { IgData } from '@/lib/useIgData';

// windowIgSeries moved to lib/igMetrics (pure home, shared by the metric page + narrative widget;
// re-exported here so existing `.../instagram/shared` importers keep working).
export { windowIgSeries };

/** A top-level view section — an h2 heading with an optional right-aligned action. */
export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-base font-medium tracking-tight text-foreground">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Hairline-delimited section (no card) — a small caption with a 1px rule + the body. */
export function ChartSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-3 text-xs font-medium tracking-wider text-muted-foreground">
        <span className="whitespace-nowrap">{title}</span>
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </h3>
      {children}
    </section>
  );
}

export function EmptyChart() {
  return <EmptyState compact size="chart" title="Нет данных за период" />;
}

/** Signed integer with a typographic minus, e.g. +595 / −23 / 0. */
export const signedNum = (n: number): string => `${n > 0 ? '+' : n < 0 ? '−' : ''}${fmt.num(Math.abs(n))}`;

export interface KpiCardProps {
  label: string;
  value: string;
  hint?: string;
  trend?: MetricDelta | null;
  /** A pre-formatted inline delta (e.g. "−23"); shown instead of the percent pill when set. */
  deltaText?: string;
  deltaTone?: 'up' | 'down' | 'flat';
  /** Drill to the metric's page — the number becomes a real button (TG StatTile parity). */
  onDrill?: () => void;
}

/** A single ledger cell — label, big number, optional delta + hint. BARE (no plate): ledgers are
    separated by SPACING in a plain grid, not a `gap-px` hairline mesh — the surrounding card
    already frames them, and a bg-background plate inside a card read as a sharp-cornered inset
    box (owner report on the IG «Показатели» hero; the TG KpiGrid rule). */
export function KpiCard({ label, value, hint, trend, deltaText, deltaTone, onDrill }: KpiCardProps) {
  // Quiet register (steep): the delta reads muted — direction lives in its sign/arrow, never in
  // an evaluative colour. deltaTone stays in the props contract for call-site compatibility.
  void deltaTone;
  const deltaColor = 'text-muted-foreground';
  return (
    <div className="py-1">
      {/* Паритет с TG StatTile (аудит: «twin» расходился кеглем и базовой линией дельты). */}
      <div className="text-2xs tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1.5 flex items-baseline gap-2">
        {onDrill ? (
          <button
            type="button"
            aria-label={`Разбор: ${label}`}
            title="Подробный разбор"
            onClick={onDrill}
            className="rounded text-left text-2xl font-medium tabular-nums tracking-tight transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {value}
          </button>
        ) : (
          <div className="text-2xl font-medium tabular-nums tracking-tight">{value}</div>
        )}
        {deltaText ? (
          <span className={`shrink-0 text-xs font-medium tabular-nums ${deltaColor}`}>{deltaText}</span>
        ) : (
          <DeltaPill delta={trend} />
        )}
      </div>
      {hint ? <div className="mt-2 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

/** The lead KPI — a large number + delta and (only for a metric with a real daily series) a small
    area chart. Used for Охват on the Overview, since reach is one of the few honest daily series. */
export function KpiHero({
  label,
  value,
  delta,
  series,
  drillTo,
}: {
  label: string;
  value: string;
  delta?: MetricDelta | null;
  series?: Point[];
  /** Route of the metric's explorer page (/metrics/ig-*). The ↗ Link is the semantic
      (keyboard/AT) path; the whole chart block is a mouse convenience — the same drill
      contract as widget cards, so the hero chart is never a dead end. */
  drillTo?: string;
}) {
  const navigate = useNavigate();
  const daily = (series ?? []).filter((p) => p.day !== 'total');
  // Метки оси ровные: акцент-пилюля последней метки удалена продуктово (прод-фидбек по Обзору:
  // читалась как залипший ховер) — см. компакт-метки в LineChart.
  // Кап длинной линии (канон CLAUDE.md): на «Всё» дневной архив уходил в чарт целиком —
  // LTTB прореживает до CHART_MAX_POINTS, labels/titles строятся из тех же выбранных точек.
  const shown = lttbDownsample(daily, CHART_MAX_POINTS, (p) => p.value);
  const chart = shown.length > 1 && (
    <LineChart
      values={shown.map((p) => p.value)}
      labels={pickLabels(shown)}
      titles={shown.map((p) => `${fmtDay(p.day)}: ${fmt.num(p.value)}`)}
      height={112}
    />
  );
  // Steep anatomy (owner rule): label + number + delta bottom-left, the chart inset to the RIGHT.
  return (
    <ChartCardBody hero label={label} value={value} delta={delta} onValueClick={drillTo ? () => navigate(drillTo) : undefined} drillLabel={label}>
      {chart &&
        (drillTo ? (
          <div className="relative h-full">
            <Link
              to={drillTo}
              aria-label={`Разбор: ${label}`}
              title="Подробный разбор"
              className="absolute right-1 top-1 z-10 rounded-full border border-transparent p-1 text-muted-foreground transition-colors hover:border-border hover:bg-background hover:text-foreground"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M7 17 17 7M9 7h8v8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
            {/* Mouse convenience only (no button role — the ↗ Link above is the semantic path). */}
            <div className="h-full cursor-pointer" onClick={() => navigate(drillTo)}>
              {chart}
            </div>
          </div>
        ) : (
          <div className="h-full">{chart}</div>
        ))}
    </ChartCardBody>
  );
}

/** Daily gross-follows bars — full series in, resolved feed/Home calendar window out. */
export function FollowsByDayCard({ data, drillTo, id, homeKey, title = 'Подписки по дням' }: { data: Point[]; drillTo?: string; id?: string; homeKey?: string; title?: string }) {
  const pts = data.filter((p) => p.day !== 'total');
  return (
    <WidgetChartSection
      id={id}
      homeKey={homeKey}
      title={title}
      drillTo={drillTo}
      periodControl
      variants={(period: WidgetPeriodValue) => {
        const selected = splitCalendarRows(
          pts,
          calendarWindowForPeriod(period),
          (point) => periodDateTimestamp(point.day),
        );
        const w = selected.current;
        const total = w.reduce((acc, p) => acc + p.value, 0);
        const prev = selected.previous
          ? selected.previous.reduce((acc, p) => acc + p.value, 0)
          : null;
        const delta = prev != null && prev > 0 ? pctDelta(total, prev) : null;
        return [
          {
            key: 'bar',
            label: 'Столбцы',
            render:
              w.length > 0 ? (
                <ChartCardBody value={`+${fmt.kpi(total)}`} delta={delta} caption={delta ? 'к пред. периоду' : period.days === 0 ? 'за всё время' : undefined}>
                  <BarChart
                    values={w.map((d) => d.value)}
                    labels={w.map((d) => fmtDay(d.day))}
                    titles={w.map((d) => `${fmtDay(d.day)}: +${fmt.num(d.value)}`)}
                  />
                </ChartCardBody>
              ) : (
                <EmptyChart />
              ),
          },
        ];
      }}
    />
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="pt-2">
      <div className="text-2xs tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-medium tabular-nums">{value}</div>
    </div>
  );
}

export function pickLabels(series: Point[]): string[] {
  if (series.length === 0) return [];
  const first = series[0];
  const mid = series[Math.floor(series.length / 2)];
  const last = series[series.length - 1];
  return [first?.day ?? '', mid?.day ?? '', last?.day ?? ''].map(fmtDay);
}

/** A daily line chart for reach/new followers. Feed top bar owns its calendar window; a Home copy
    uses the same code with its independently saved period. */
export function TrendCard({ title, series, drillTo, id, homeKey, defaultSize }: { title: string; series: Point[]; drillTo?: string; id?: string; homeKey?: string; defaultSize?: WidgetSize }) {
  const pts = series.filter((p) => p.day !== 'total');
  return (
    <WidgetChartSection
      id={id}
      homeKey={homeKey}
      title={title}
      drillTo={drillTo}
      defaultSize={defaultSize}
      periodControl
      variants={(period: WidgetPeriodValue) => {
        const selected = splitCalendarRows(
          pts,
          calendarWindowForPeriod(period),
          (point) => periodDateTimestamp(point.day),
        );
        const w = selected.current;
        // Steep anatomy: the window's total + the MANDATORY comparison vs the previous
        // same-length window (honest: none on «Всё» or when the archive is too short).
        const total = w.reduce((acc, p) => acc + p.value, 0);
        const prev = selected.previous
          ? selected.previous.reduce((acc, p) => acc + p.value, 0)
          : null;
        const delta = prev != null && prev > 0 ? pctDelta(total, prev) : null;
        // Кап линии (канон CLAUDE.md): «Всё» отдаёт многосотневный дневной архив — итог/дельта
        // выше посчитаны от ПОЛНОГО окна, прореживается только рисуемая линия.
        const line = lttbDownsample(w, CHART_MAX_POINTS, (p) => p.value);
        return [
          {
            key: 'line',
            label: 'Линия',
            render:
              w.length > 1 ? (
                <ChartCardBody value={fmt.kpi(total)} delta={delta} caption={delta ? 'к пред. периоду' : period.days === 0 ? 'за всё время' : undefined}>
                  <LineChart
                    values={line.map((p) => p.value)}
                    labels={pickLabels(line)}
                    titles={line.map((p) => `${fmtDay(p.day)}: ${fmt.num(p.value)}`)}
                  />
                </ChartCardBody>
              ) : (
                <EmptyChart />
              ),
          },
        ];
      }}
    />
  );
}

// A whole window without a single non-zero sample is «нет данных», not a real zero — insights
// quota burn / missing metrics must read as a dash with no delta, never as a crash (D6.1).
const isLive = (p: WindowPair) => p.hasCur && p.cur > 0;

/**
 * The IG «Показатели» body — KPI hero (Охват, a real daily series) + the 4-cell ledger. BARE
 * content (no own card): the Обзор renders it inside its widget group's «Показатели» ChartSection,
 * and the Home registry pins it via the self-fetching IgKpiHomeCard — the IG twin of TG's KpiGrid.
 */
export function IgKpiBlock({ ig }: { ig: IgData }) {
  const navigate = useNavigate();
  const erTrend =
    ig.erReach > 0 && ig.pairs.reach.hasCur && ig.pairs.reach.hasPrev && ig.erReachPrev > 0
      ? pctDelta(ig.erReach, ig.erReachPrev)
      : null;
  return (
    // TG KpiGrid composition: the hero sits straight on the card and the ledger splits off with
    // ONE quiet top hairline + spacing — no inner plate, no hairline mesh (the card is the frame).
    <div className="space-y-5">
      {/* Без hero-drillTo: оба хоста («Показатели» на IG-Обзоре и IG·Показатели на Home) несут
          drillTo на СЕКЦИИ — corner-↗ + whole-card клик + хедер-кнопка. Своя стрелка hero рядом
          с карточной читалась дублем (визуальный аудит №1). */}
      <KpiHero
        label={`Охват · ${ig.window.days} дн.`}
        value={fmt.kpi(ig.pairs.reach.cur)}
        delta={pairDelta(ig.pairs.reach)}
        series={ig.series.reach.filter((p) => ig.inWindow(p.day))}
      />
      <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-border pt-4 lg:grid-cols-4">
        <KpiCard
          label="Подписчики"
          value={fmt.kpi(ig.followers)}
          deltaText={ig.netMovement.hasCur ? signedNum(ig.netMovement.cur) : undefined}
          deltaTone={ig.netMovement.cur > 0 ? 'up' : ig.netMovement.cur < 0 ? 'down' : 'flat'}
          onDrill={() => navigate('/metrics/ig-follows')}
        />
        <KpiCard
          label="Просмотры"
          value={isLive(ig.pairs.views) ? fmt.kpi(ig.pairs.views.cur) : '—'}
          trend={isLive(ig.pairs.views) ? pairDelta(ig.pairs.views) : null}
          onDrill={() => navigate('/metrics/ig-views')}
        />
        <KpiCard
          label="Вовлечённость"
          value={ig.erReach > 0 ? `${ig.erReach.toFixed(2)}%` : '—'}
          trend={erTrend}
          onDrill={() => navigate('/metrics/ig-er')}
        />
        <KpiCard
          label="Взаимодействия"
          value={isLive(ig.pairs.ti) ? fmt.kpi(ig.pairs.ti.cur) : '—'}
          trend={isLive(ig.pairs.ti) ? pairDelta(ig.pairs.ti) : null}
          onDrill={() => navigate('/metrics/ig-interactions')}
        />
      </div>
    </div>
  );
}

/**
 * Real subscriber movement for the window: gross follows, gross unfollows, and the net of the two.
 * The previous "+595 подписчиков" reported gross follows alone — this shows that 595 follows came
 * with 618 unfollows, so the channel actually moved −23.
 */
export function SubscriberMovement({
  follows,
  unfollows,
  net,
  compact = false,
}: {
  follows: WindowPair;
  unfollows: WindowPair;
  net: { cur: number; prev: number; hasCur: boolean; hasPrev: boolean };
  compact?: boolean;
}) {
  // Окно без единого сэмпла по всем трём строкам (hasCur=false, т.е. данных нет — валидный ноль
  // ставит hasCur=true и рисуется как обычно): три прочерка рядом с «пред. период» читались как
  // сломанная загрузка — вместо колонок одна честная приглушённая строка, футнота скрыта.
  if (!follows.hasCur && !unfollows.hasCur && !net.hasCur) {
    return (
      <div className={`border-t border-border ${compact ? 'pt-3' : 'pt-4'}`}>
        <p className={`${compact ? 'text-2xs' : 'text-xs'} text-muted-foreground`}>
          Подписки и отписки за этот период недоступны
        </p>
      </div>
    );
  }
  // Quiet register (steep): signs (+/−) carry direction; no evaluative red/green on the stats.
  const cells = [
    { label: 'Подписки', text: follows.hasCur ? `+${fmt.num(follows.cur)}` : '—', color: follows.hasCur ? 'text-foreground' : 'text-muted-foreground' },
    { label: 'Отписки', text: unfollows.hasCur ? `−${fmt.num(unfollows.cur)}` : '—', color: unfollows.hasCur ? 'text-foreground' : 'text-muted-foreground' },
    {
      label: 'Чистый прирост',
      text: net.hasCur ? signedNum(net.cur) : '—',
      color: net.hasCur ? 'text-foreground' : 'text-muted-foreground',
    },
  ];
  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      <div className={`grid grid-cols-1 border-t border-border sm:grid-cols-3 ${compact ? 'gap-x-4 gap-y-2 pt-3' : 'gap-x-6 gap-y-4 pt-4'}`}>
        {cells.map((c) => (
          <div key={c.label} className={compact ? '' : 'py-1'}>
            <div className={`${compact ? 'text-2xs' : 'text-xs'} tracking-wide text-muted-foreground`}>{c.label}</div>
            <div className={`${compact ? 'mt-1 text-2xl' : 'mt-2 text-3xl'} font-medium tabular-nums tracking-tight ${c.color}`}>{c.text}</div>
            {c.label === 'Чистый прирост' && net.hasPrev && (
              <div className={`${compact ? 'mt-1 text-2xs' : 'mt-2 text-xs'} text-muted-foreground`}>пред. период: {signedNum(net.prev)}</div>
            )}
          </div>
        ))}
      </div>
      {!compact && <p className="px-1 text-xs text-muted-foreground">Чистый прирост = подписки − отписки за период.</p>}
    </div>
  );
}

// ── Redesigned IG Overview cards ──────────────────────────────────────────────────────────────
// The old aggregate «Показатели» hero (IgKpiBlock, still used by the legacy `ig-kpi` Home key)
// is split into independent, source-honest widgets. Each is a BARE body (no own ChartSection) so the
// Обзор hosts it inside the widget grid, drilling to its own /metrics/ig-* page. Reach is a full
// daily series (line hero); Просмотры / Взаимодействия / Вовлечённость carry compact active-window
// sparklines (parity with the redesigned TG third-width cards — see KpiGrid TgTrendStat), each built
// from the CANONICAL account daily series (igOverviewCharts): daily views, daily total interactions,
// and daily ER = 100·interactions ÷ reach aligned by calendar day. The chart depends ONLY on the
// active window, never on previous-window coverage. Delta stays honest (absent when no previous
// window). Below the required real daily samples the card keeps its headline and says so.

/** «Охват» — the primary IG daily series (half width): area line + paired-window Δ. Section carries
    the drill, so KpiHero has no own ↗ (a lone arrow next to the card's read as a dup — visual audit). */
export function IgReachBody({ ig }: { ig: IgData }) {
  return (
    <KpiHero
      label={`Охват · ${ig.window.days} дн.`}
      value={fmt.kpi(ig.pairs.reach.cur)}
      delta={pairDelta(ig.pairs.reach)}
      series={ig.series.reach.filter((p) => ig.inWindow(p.day))}
    />
  );
}

/** «Динамика аудитории» (half): the base follower level + net movement on the LEFT with a compact
    active-window follower-level area line on the RIGHT (the established horizontal hero anatomy),
    then the honest follows/unfollows/net breakdown (SubscriberMovement) below. The chart is the
    CANONICAL absolute base level (ig.series.followerLevel) filtered to the exact active window and
    sorted ascending — an honest daily line (label «по дням»), drawn ONLY with ≥2 real dated values;
    below that the card keeps its base + net headline and the ledger, never a zero-filled line. One
    card answers «сколько нас и куда движется». Drill lives on the section (/metrics/ig-follows). */
export function IgAudienceBody({ ig }: { ig: IgData }) {
  const net = ig.netMovement;
  // Exact active window (top-bar preset OR custom range) + ascending — the same window contract as
  // the reach hero; no invention or zero-fill, just the real dated level points inside the window.
  const level = ig.series.followerLevel
    .filter((p) => {
      const timestamp = periodDateTimestamp(p.day);
      return p.day !== 'total' && Number.isFinite(timestamp) && timestamp >= ig.window.since && timestamp <= ig.window.until;
    })
    .sort((a, b) => a.day.localeCompare(b.day));
  const hasChart = level.length >= 2;
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex min-h-0 items-end gap-4">
        <div className="flex shrink-0 flex-col items-start gap-1.5 pb-0.5">
          <div className="text-xs tracking-wide text-muted-foreground">База · {ig.window.days} дн.</div>
          <div className="flex items-baseline gap-2">
            <div className="kpi-accent text-hero font-medium leading-none tabular-nums tracking-tight">{fmt.kpi(ig.followers)}</div>
            {net.hasCur && net.cur !== 0 && (
              <span className="text-sm font-medium tabular-nums text-muted-foreground">
                {signedNum(net.cur)}
              </span>
            )}
          </div>
        </div>
        {hasChart && (
          <div className="min-h-0 min-w-0 flex-1 self-stretch">
            <Sparkline
              values={level.map((p) => p.value)}
              labels={level.map((p) => fmtDay(p.day))}
              area
              strokeWidth={2}
              interactive
              caption="по дням"
              formatValue={(n) => fmt.num(Math.round(n))}
              className="h-full min-h-14 w-full"
            />
          </div>
        )}
      </div>
      <SubscriberMovement follows={ig.pairs.follows} unfollows={ig.pairs.unfollows} net={net} compact />
    </div>
  );
}

/**
 * Compact IG comparison body (Просмотры / Взаимодействия / Вовлечённость): the headline (number +
 * honest delta) over an active-window sparkline built from the canonical account daily series
 * (igOverviewCharts). Parity with the redesigned TG third-width cards (KpiGrid TgTrendStat): the
 * chart depends ONLY on the active window, never on previous-window coverage. ≥2 canonical daily
 * points draw it (caption «по дням»); below the required real daily samples the card keeps its
 * headline and says «Недостаточно дневных данных для графика».
 */
function IgTrendStat({
  value,
  delta,
  chart,
  format,
  onDrill,
  drillLabel,
  hasValue = true,
}: {
  value: number | null;
  delta?: MetricDelta | null;
  chart: IgOverviewChart;
  format: (n: number) => string;
  onDrill?: () => void;
  drillLabel?: string;
  hasValue?: boolean;
}) {
  const live = hasValue && value != null && Number.isFinite(value);
  const hasChart = live && chart.values.length >= 2;
  return (
    <div className="flex h-full min-h-0 flex-col justify-between gap-4">
      <CompactStatHeadline text={live ? format(value as number) : '—'} delta={delta} onDrill={onDrill} drillLabel={drillLabel} live={live} />
      {hasChart ? (
        <Sparkline
          values={chart.values}
          labels={chart.labels}
          area
          strokeWidth={2}
          interactive
          caption="по дням"
          formatValue={format}
          className="h-full min-h-14 w-full"
        />
      ) : (
        <p className="text-2xs text-muted-foreground">Недостаточно дневных данных для графика.</p>
      )}
    </div>
  );
}

/** «Просмотры» (third): daily account views over the active window. */
export function IgViewsBody({ ig }: { ig: IgData }) {
  const navigate = useNavigate();
  const live = isLive(ig.pairs.views);
  return (
    <IgTrendStat
      value={live ? ig.pairs.views.cur : null}
      delta={live ? pairDelta(ig.pairs.views) : null}
      chart={ig.overviewCharts.views}
      format={(n) => fmt.short(Math.round(n))}
      hasValue={live}
      onDrill={() => navigate('/metrics/ig-views')}
      drillLabel="Просмотры"
    />
  );
}

/** «Взаимодействия» (third): daily total interactions over the active window. */
export function IgInteractionsBody({ ig }: { ig: IgData }) {
  const navigate = useNavigate();
  const live = isLive(ig.pairs.ti);
  return (
    <IgTrendStat
      value={live ? ig.pairs.ti.cur : null}
      delta={live ? pairDelta(ig.pairs.ti) : null}
      chart={ig.overviewCharts.interactions}
      format={(n) => fmt.short(Math.round(n))}
      hasValue={live}
      onDrill={() => navigate('/metrics/ig-interactions')}
      drillLabel="Взаимодействия"
    />
  );
}

/** «Вовлечённость» (third): daily ER = 100·interactions ÷ reach, aligned by calendar day. */
export function IgEngagementBody({ ig }: { ig: IgData }) {
  const navigate = useNavigate();
  const erTrend =
    ig.erReach > 0 && ig.pairs.reach.hasCur && ig.pairs.reach.hasPrev && ig.erReachPrev > 0
      ? pctDelta(ig.erReach, ig.erReachPrev)
      : null;
  return (
    <IgTrendStat
      value={ig.erReach > 0 ? ig.erReach : null}
      delta={erTrend}
      chart={ig.overviewCharts.engagement}
      format={(n) => `${n.toFixed(2)}%`}
      hasValue={ig.erReach > 0}
      onDrill={() => navigate('/metrics/ig-er')}
      drillLabel="Вовлечённость"
    />
  );
}

/** The IG period-comparison rows — ONE builder for the Аналитика card and its Home pin. */
export function igPeriodRows(ig: IgData): { label: string; pair: WindowPair }[] {
  return [
    { label: 'Подписки', pair: ig.pairs.follows.hasCur ? ig.pairs.follows : ig.pairs.follower },
    { label: 'Охват', pair: ig.pairs.reach },
    { label: 'Просмотры', pair: ig.pairs.views },
    { label: 'Взаимодействия', pair: ig.pairs.ti },
    { label: 'Вовлечено аккаунтов', pair: ig.pairs.engaged },
    { label: 'Лайки', pair: ig.pairs.likes },
    { label: 'Комментарии', pair: ig.pairs.comments },
    { label: 'Сохранения', pair: ig.pairs.saves },
    { label: 'Репосты', pair: ig.pairs.shares },
  ];
}
