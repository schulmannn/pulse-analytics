import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  useIgProfile,
  useIgInsights,
  useIgPosts,
  useIgBreakdowns,
  useIgOnline,
  useIgStories,
} from '@/api/queries';
import type { IgBreakdowns, IgInsights, IgOnline, IgPost, IgStory } from '@/api/schemas';
import { fmt } from '@/lib/format';
import { pctDelta } from '@/lib/delta';
import type { MetricDelta } from '@/lib/delta';
import { usePeriod } from '@/lib/period';
import { Card, CardContent } from '@/components/ui/card';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { Breakdown } from '@/components/Breakdown';
import { DeltaPill } from '@/components/DeltaPill';
import { RichText } from '@/components/RichText';
import { ExpandableChart } from '@/components/ExpandableChart';
import { ChartTooltip, type TooltipState } from '@/components/ChartTooltip';
import { Skeleton } from '@/components/ui/skeleton';
import { SectionNav, type Section } from '@/components/SectionNav';
import { downloadCsv, type CsvRow } from '@/lib/csv';
import { buildIgInsights, type IgInsight } from '@/lib/igInsights';
import { loadIgGoals, saveIgGoals, goalPct, type IgGoals } from '@/lib/igGoals';

const DAY_MS = 24 * 60 * 60 * 1000;

const SECTIONS: readonly Section[] = [
  { id: 'ig-metrics', label: 'Метрики', group: 'Обзор' },
  { id: 'ig-insights', label: 'Инсайты', group: 'Обзор' },
  { id: 'ig-goals', label: 'Цели', group: 'Обзор' },
  { id: 'ig-periods', label: 'Период', group: 'Обзор' },
  { id: 'ig-trends', label: 'Динамика', group: 'Динамика' },
  { id: 'ig-formats', label: 'Форматы', group: 'Динамика' },
  { id: 'ig-growth', label: 'Рост', group: 'Динамика' },
  { id: 'ig-audience', label: 'Аудитория', group: 'Аудитория' },
  { id: 'ig-timing', label: 'Время', group: 'Аудитория' },
  { id: 'ig-reels', label: 'Reels', group: 'Публикации' },
  { id: 'ig-posts', label: 'Посты', group: 'Публикации' },
  { id: 'ig-hashtags', label: 'Хэштеги', group: 'Публикации' },
  { id: 'ig-compare', label: 'Сравнение', group: 'Публикации' },
  { id: 'ig-stories', label: 'Stories', group: 'Stories' },
  { id: 'ig-actions', label: 'Профиль', group: 'Профиль' },
];

const MEDIA_PRODUCT_LABEL: Record<string, string> = {
  POST: 'Лента', FEED: 'Лента', REEL: 'Reels', REELS: 'Reels', STORY: 'Stories', CAROUSEL_ALBUM: 'Карусель',
};
// Stable format → chart-series colour, keyed off media_product_type so a format keeps its hue
// regardless of sort order. Uses the categorical data-viz palette (index.css --chart-*).
const MEDIA_PRODUCT_CHART: Record<string, string> = {
  POST: 'hsl(var(--chart-1))', FEED: 'hsl(var(--chart-1))',
  REEL: 'hsl(var(--chart-2))', REELS: 'hsl(var(--chart-2))',
  STORY: 'hsl(var(--chart-3))', CAROUSEL_ALBUM: 'hsl(var(--chart-4))',
};
// Cycle through the palette for categorical breakdowns without a fixed per-category colour.
const CHART_CYCLE = [
  'hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))',
  'hsl(var(--chart-4))', 'hsl(var(--chart-5))', 'hsl(var(--chart-6))',
];
// Post card badge keys off media_type (IMAGE/VIDEO/CAROUSEL_ALBUM/REELS), not product_type.
const MEDIA_TYPE_LABEL: Record<string, string> = {
  IMAGE: 'Фото', VIDEO: 'Видео', CAROUSEL_ALBUM: 'Карусель', REELS: 'Reels',
};
const GENDER_LABEL: Record<string, string> = { F: 'Женщины', M: 'Мужчины', U: 'Не указан' };
const AGE_ORDER = ['13-17', '18-24', '25-34', '35-44', '45-54', '55-64', '65+'];
const CONTACT_LABEL: Record<string, string> = {
  WEBSITE: 'Сайт', EMAIL: 'Почта', CALL: 'Звонок', DIRECTION: 'Маршрут', TEXT: 'Сообщение', BOOK_NOW: 'Бронь',
};
const CONTACT_ICON: Record<string, string> = {
  WEBSITE: '🔗', EMAIL: '✉️', CALL: '📞', DIRECTION: '📍', TEXT: '💬', BOOK_NOW: '🗓️',
};
const COUNTRY_NAME: Record<string, string> = {
  US: 'США', GB: 'Великобритания', DE: 'Германия', BR: 'Бразилия', RU: 'Россия', UA: 'Украина',
  PL: 'Польша', ES: 'Испания', FR: 'Франция', IN: 'Индия', CA: 'Канада', IT: 'Италия',
};
const NAV_LABEL: Record<string, string> = {
  tap_forward: 'Вперёд', tap_back: 'Назад', tap_exit: 'Выход', swipe_forward: 'Свайп к следующему',
};

interface Point {
  day: string;
  value: number;
}

/** Daily time_series metric → {day,value}[] (oldest→newest). On the Instagram-Login API the
    engagement metrics (views/saves/total_interactions/…) come as a single total_value aggregate
    with no daily series — surface that as one point so KPI sums read the real per-period number. */
function metricSeries(insights: IgInsights | undefined, name: string): Point[] {
  const metric = insights?.data?.find((m) => m.name === name);
  if (!metric) return [];
  const series = (metric.values ?? [])
    .map((v) => ({ day: v.end_time ?? '', value: Number(typeof v.value === 'object' ? 0 : v.value ?? 0) }))
    .filter((p) => p.day !== '');
  if (series.length) return series;
  const tv = metric.total_value?.value;
  return tv != null ? [{ day: 'total', value: Number(tv) }] : [];
}

/** total_value breakdown reader → {label,value}[] for a metric+dimension. */
function tvBreakdown(data: IgBreakdowns['data'] | undefined, name: string, dim: string): { label: string; value: number }[] {
  for (const entry of (data ?? []).filter((m) => m.name === name)) {
    const block = entry.total_value?.breakdowns?.find((b) => (b.dimension_keys ?? []).includes(dim));
    if (block) {
      return (block.results ?? []).map((r) => ({ label: r.dimension_values?.[0] ?? '', value: Number(r.value ?? 0) }));
    }
  }
  return [];
}

const fmtDay = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '';
};

const flag = (iso: string) => {
  const cc = (iso || '').toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...[...cc].map((c) => 127397 + c.charCodeAt(0)));
};

/** Sum a daily series over the current vs previous window (for ratio/Δ math). */
// Sum a daily series over the window [startMs, endMs] vs the equal-length window right
// before it. Explicit bounds so a custom date range maps to its exact span (not a
// windowDays reconstruction that drifts on >90d / non-day-aligned picks).
function windowPair(series: Point[], startMs: number, endMs: number) {
  const span = Math.max(endMs - startMs, DAY_MS);
  const prevStart = startMs - span;
  let cur = 0;
  let prev = 0;
  let hasCur = false;
  let hasPrev = false;
  for (const p of series) {
    const t = Date.parse(p.day);
    if (!Number.isFinite(t) || t > endMs) continue;
    if (t >= startMs) { cur += p.value; hasCur = true; }
    else if (t >= prevStart) { prev += p.value; hasPrev = true; }
  }
  return { cur, prev, hasCur, hasPrev };
}
const pairDelta = (p: ReturnType<typeof windowPair>): MetricDelta | null =>
  p.hasCur && p.hasPrev ? pctDelta(p.cur, p.prev) : null;

const DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

/** Aggregate the online_followers daily hour-maps into a weekday×hour grid + best slot. */
function aggregateOnline(online: IgOnline | undefined) {
  const dayValues = online?.data?.[0]?.values ?? [];
  const sum: number[][] = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  const cnt: number[][] = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
  dayValues.forEach((d) => {
    const t = Date.parse(d.end_time ?? '');
    if (!Number.isFinite(t)) return;
    const w = (new Date(t).getUTCDay() + 6) % 7;
    const map = d.value ?? {};
    for (let h = 0; h < 24; h++) {
      const v = Number(map[String(h)] ?? 0);
      if (!Number.isFinite(v)) continue;
      sum[w][h] += v;
      cnt[w][h] += 1;
    }
  });
  const grid = sum.map((row, w) => row.map((s, h) => (cnt[w][h] ? s / cnt[w][h] : 0)));
  const max = Math.max(1, ...grid.flat());
  let best = { w: -1, h: -1, v: -1 };
  grid.forEach((row, w) => row.forEach((v, h) => { if (v > best.v) best = { w, h, v }; }));
  return { dayValues, grid, max, best };
}

export function Instagram() {
  const { days, range } = usePeriod();
  const timeframe = days === 7 ? 'last_14_days' : days === 90 || days === 0 ? 'last_90_days' : 'last_30_days';

  const profile = useIgProfile();
  const insights = useIgInsights();
  const posts = useIgPosts(24);
  const breakdowns = useIgBreakdowns(timeframe);
  const online = useIgOnline();
  const stories = useIgStories();

  if (profile.isLoading || insights.isLoading || posts.isLoading) return <InstagramSkeleton />;
  if (profile.isError && insights.isError) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Не удалось загрузить данные Instagram.
        </CardContent>
      </Card>
    );
  }

  // Window: custom range (from the shared period picker) overrides the days preset.
  // Instagram insights cap at ~90 days, so the window is clamped accordingly.
  const now = Date.now();
  let windowDays: number;
  let since: number;
  let until = now;
  if (range) {
    since = range.from;
    until = range.to;
    windowDays = Math.min(90, Math.max(1, Math.ceil((range.to - range.from) / DAY_MS)));
  } else {
    windowDays = days && days > 0 ? Math.min(days, 90) : 90;
    since = now - windowDays * DAY_MS;
  }
  const inWindow = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= since && t <= until;
  };

  const reachS = metricSeries(insights.data, 'reach');
  const viewsS = metricSeries(insights.data, 'views');
  const tiS = metricSeries(insights.data, 'total_interactions');
  const engagedS = metricSeries(insights.data, 'accounts_engaged');
  const followerS = metricSeries(insights.data, 'follower_count');
  const savesS = metricSeries(insights.data, 'saves');

  const reachP = windowPair(reachS, since, until);
  const viewsP = windowPair(viewsS, since, until);
  const tiP = windowPair(tiS, since, until);
  const engagedP = windowPair(engagedS, since, until);
  const followerP = windowPair(followerS, since, until);
  const savesP = windowPair(savesS, since, until);

  const followers = profile.data?.followers_count ?? 0;
  const erReach = reachP.cur > 0 ? (tiP.cur / reachP.cur) * 100 : 0;
  const erReachPrev = reachP.prev > 0 ? (tiP.prev / reachP.prev) * 100 : 0;

  const igPosts = posts.data?.data ?? [];
  const isMock = !!(profile.data?.mock || insights.data?.mock || posts.data?.mock || breakdowns.data?.mock);

  const kpis: KpiCardProps[] = [
    { label: 'Подписчики', value: fmt.num(followers), feature: true, trend: pairDelta(followerP), hint: 'всего в аккаунте' },
    { label: 'Охват за период', value: fmt.short(reachP.cur), trend: pairDelta(reachP) },
    { label: 'Просмотры', value: fmt.short(viewsP.cur), trend: pairDelta(viewsP) },
    {
      label: 'Вовлечённость (ER)',
      value: erReach > 0 ? `${erReach.toFixed(2)}%` : '—',
      trend: reachP.hasCur && reachP.hasPrev && erReachPrev > 0 ? pctDelta(erReach, erReachPrev) : null,
      hint: 'взаимодействия / охват',
    },
    { label: 'Вовлечено аккаунтов', value: fmt.short(engagedP.cur), trend: pairDelta(engagedP) },
    { label: 'Сохранения', value: fmt.short(savesP.cur), trend: pairDelta(savesP) },
  ];

  // New followers per day — Graph `follower_count` is daily new followers; show recent 30.
  const newFollowersByDay = followerS.filter((p) => inWindow(p.day)).slice(-30);

  const exportPosts = () =>
    downloadCsv(
      'instagram-posts.csv',
      igPosts.map((p) => ({
        date: p.timestamp ?? '',
        type: p.media_type ?? '',
        reach: p.reach ?? 0,
        views: p.views ?? 0,
        likes: p.like_count ?? 0,
        comments: p.comments_count ?? 0,
        saved: p.saved ?? 0,
        shares: p.shares ?? 0,
        caption: (p.caption ?? '').replace(/\s+/g, ' ').slice(0, 200),
        permalink: p.permalink ?? '',
      })),
    );

  const exportDaily = () => {
    const byDay = new Map<string, CsvRow>();
    const put = (series: Point[], key: string) =>
      series.forEach((p) => {
        const d = p.day.slice(0, 10);
        const row = byDay.get(d) ?? { day: d };
        row[key] = p.value;
        byDay.set(d, row);
      });
    put(reachS, 'reach');
    put(viewsS, 'views');
    put(tiS, 'total_interactions');
    put(engagedS, 'accounts_engaged');
    put(followerS, 'new_followers');
    put(savesS, 'saves');
    const rows = [...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
    downloadCsv('instagram-daily.csv', rows);
  };

  // Period-over-period comparison rows (current window vs the equal-length prior window).
  const likesS = metricSeries(insights.data, 'likes');
  const commentsS = metricSeries(insights.data, 'comments');
  const sharesS = metricSeries(insights.data, 'shares');
  const periodRows: { label: string; pair: ReturnType<typeof windowPair> }[] = [
    { label: 'Охват', pair: reachP },
    { label: 'Просмотры', pair: viewsP },
    { label: 'Взаимодействия', pair: tiP },
    { label: 'Вовлечено аккаунтов', pair: engagedP },
    { label: 'Новые подписчики', pair: followerP },
    { label: 'Лайки', pair: windowPair(likesS, since, until) },
    { label: 'Комментарии', pair: windowPair(commentsS, since, until) },
    { label: 'Сохранения', pair: savesP },
    { label: 'Репосты', pair: windowPair(sharesS, since, until) },
  ];

  // Auto-insight inputs (derived from the sections' own data).
  const formatItems = tvBreakdown(breakdowns.data?.data, 'total_interactions', 'media_product_type');
  const formatTotal = formatItems.reduce((acc, it) => acc + it.value, 0);
  const topFormat = [...formatItems].sort((a, b) => b.value - a.value)[0];
  const onlineBest = aggregateOnline(online.data).best;
  // For the insight, surface the highest-LIFT hashtag (used ≥2×), not the most frequent.
  const topTag = [...hashtagStats(igPosts)].filter((t) => t.count >= 2).sort((a, b) => b.lift - a.lift)[0];
  const topCountryRaw = [...tvBreakdown(breakdowns.data?.data, 'follower_demographics', 'country')]
    .sort((a, b) => b.value - a.value)[0];
  const topAgeRaw = [...tvBreakdown(breakdowns.data?.data, 'follower_demographics', 'age')]
    .sort((a, b) => b.value - a.value)[0];
  const autoInsights = buildIgInsights({
    followersDelta: pairDelta(followerP),
    newFollowers: followerP.cur,
    erReach,
    erReachPrev,
    bestFormat:
      topFormat && formatTotal > 0
        ? { label: MEDIA_PRODUCT_LABEL[topFormat.label] ?? topFormat.label, sharePct: (topFormat.value / formatTotal) * 100 }
        : null,
    bestSlot: onlineBest.w >= 0 ? { day: DAY_NAMES[onlineBest.w], hour: onlineBest.h } : null,
    topHashtag: topTag ? { tag: topTag.tag, lift: topTag.lift } : null,
    topPostReach: igPosts.length ? Math.max(...igPosts.map((p) => Number(p.reach ?? 0))) : null,
    topCountry: topCountryRaw ? COUNTRY_NAME[topCountryRaw.label] ?? topCountryRaw.label : null,
    topAge: topAgeRaw ? topAgeRaw.label : null,
  });

  return (
    <div>
      <section className="flex flex-wrap items-center gap-3">
        <div>
          <h2 className="text-xl font-medium tracking-tight">
            Instagram{profile.data?.username ? ` · @${profile.data.username}` : ''}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Аккаунт, аудитория, форматы и публикации
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={exportPosts}
            className="rounded-lg border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            Экспорт постов
          </button>
          <button
            type="button"
            onClick={exportDaily}
            className="rounded-lg border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          >
            Экспорт метрик
          </button>
        </div>
      </section>

      {isMock && <DemoModeBanner />}

      <SectionNav sections={SECTIONS} />

      <div className="space-y-12">
        <ClusterHeading>Обзор</ClusterHeading>
        {/* Метрики */}
        <IgSection id="ig-metrics" title="Ключевые метрики">
          <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
            {kpis.map((k) => <KpiCard key={k.label} {...k} />)}
          </div>
        </IgSection>

        {/* Авто-инсайты */}
        <IgSection id="ig-insights" title="Авто-инсайты">
          <InsightsBlock insights={autoInsights} />
        </IgSection>

        {/* Цели */}
        <IgSection id="ig-goals" title="Цели и ориентиры">
          <GoalsBlock followers={followers} erReach={erReach} reachCur={reachP.cur} accountKey={profile.data?.username ?? 'default'} />
        </IgSection>

        {/* Период vs предыдущий */}
        <IgSection id="ig-periods" title="Период vs предыдущий">
          <PeriodCompareBlock rows={periodRows} />
        </IgSection>

        <ClusterHeading>Динамика</ClusterHeading>
        {/* Динамика */}
        <IgSection id="ig-trends" title="Динамика охвата и просмотров">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <TrendCard title="Охват по дням" series={reachS.filter((p) => inWindow(p.day))} />
            <TrendCard title="Просмотры по дням" series={viewsS.filter((p) => inWindow(p.day))} />
          </div>
        </IgSection>

        {/* Форматы */}
        <IgSection id="ig-formats" title="Вовлечённость по форматам">
          <Breakdown
            items={tvBreakdown(breakdowns.data?.data, 'total_interactions', 'media_product_type')
              .sort((a, b) => b.value - a.value)
              .map((it) => ({
                label: MEDIA_PRODUCT_LABEL[it.label] ?? it.label,
                value: it.value,
                display: fmt.short(it.value),
                color: MEDIA_PRODUCT_CHART[it.label],
              }))}
          />
        </IgSection>

        {/* Рост */}
        <IgSection id="ig-growth" title="Новые подписчики по дням">
          {newFollowersByDay.length > 0 ? (
            <ExpandableChart title="Новые подписчики по дням">
              <BarChart
                values={newFollowersByDay.map((d) => d.value)}
                labels={newFollowersByDay.map((d) => fmtDay(d.day))}
                titles={newFollowersByDay.map((d) => `${fmtDay(d.day)}: +${fmt.num(d.value)}`)}
              />
            </ExpandableChart>
          ) : (
            <EmptyChart />
          )}
          <p className="mt-3 text-xs font-medium text-muted-foreground">
            Всего за период: <span className="text-verdant">+{fmt.num(followerP.cur)}</span> новых подписчиков
          </p>
        </IgSection>

        <ClusterHeading>Аудитория</ClusterHeading>
        {/* Аудитория */}
        <IgSection id="ig-audience" title="Аудитория">
          <AudienceBlock breakdowns={breakdowns.data} followers={followers} />
        </IgSection>

        {/* Лучшее время */}
        <IgSection id="ig-timing" title="Лучшее время для публикации">
          <BestTimeHeatmap online={online.data} />
        </IgSection>

        <ClusterHeading>Публикации</ClusterHeading>
        {/* Reels */}
        <IgSection id="ig-reels" title="Reels: удержание и просмотры">
          <ReelsBlock posts={igPosts} />
        </IgSection>

        {/* Топ-посты */}
        <IgSection id="ig-posts" title="Лучшие публикации">
          <TopPostsBlock posts={igPosts} />
        </IgSection>

        {/* Хэштеги */}
        <IgSection id="ig-hashtags" title="Эффективность хэштегов">
          <HashtagsBlock posts={igPosts} />
        </IgSection>

        {/* Сравнение публикаций */}
        <IgSection id="ig-compare" title="Сравнение публикаций">
          <CompareBlock posts={igPosts} />
        </IgSection>

        <ClusterHeading>Stories</ClusterHeading>
        {/* Stories */}
        <IgSection id="ig-stories" title="Stories за 24 часа">
          <StoriesBlock stories={stories.data?.data} />
        </IgSection>

        <ClusterHeading>Профиль</ClusterHeading>
        {/* Профиль */}
        <IgSection id="ig-actions" title="Действия в профиле">
          {(() => {
            const items = tvBreakdown(breakdowns.data?.data, 'profile_links_taps', 'contact_button_type')
              .sort((a, b) => b.value - a.value);
            return items.length > 0 ? (
              <Breakdown
                items={items.map((it) => ({
                  label: CONTACT_LABEL[it.label] ?? it.label,
                  value: it.value,
                  display: fmt.short(it.value),
                  icon: CONTACT_ICON[it.label],
                }))}
              />
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">Нет данных о действиях.</p>
            );
          })()}
        </IgSection>

        {isMock && <DataHealthNote />}
      </div>
    </div>
  );
}

function IgSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-28 space-y-4">
      <h3 className="text-lg font-medium tracking-tight">{title}</h3>
      {children}
    </section>
  );
}

/** Hairline-delimited chart section (no card) — a title with a 1px rule + the chart body. */
function ChartSection({ title, children }: { title: string; children: ReactNode }) {
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

/** Group divider that chunks the long page into labeled clusters (label + hairline rule). */
function ClusterHeading({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 pt-2">
      <span className="text-xs font-medium tracking-wider text-muted-foreground">{children}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function TrendCard({ title, series }: { title: string; series: Point[] }) {
  return (
    <ChartSection title={title}>
      {series.length > 1 ? (
        <ExpandableChart title={title}>
          <LineChart
            values={series.map((p) => p.value)}
            labels={pickLabels(series)}
            titles={series.map((p) => `${fmtDay(p.day)}: ${fmt.num(p.value)}`)}
            height={220}
          />
        </ExpandableChart>
      ) : (
        <EmptyChart />
      )}
    </ChartSection>
  );
}

function pickLabels(series: Point[]): string[] {
  if (series.length === 0) return [];
  const first = series[0];
  const mid = series[Math.floor(series.length / 2)];
  const last = series[series.length - 1];
  return [first?.day ?? '', mid?.day ?? '', last?.day ?? ''].map(fmtDay);
}

function AudienceBlock({ breakdowns, followers }: { breakdowns: IgBreakdowns | undefined; followers: number }) {
  const ageRaw = tvBreakdown(breakdowns?.data, 'follower_demographics', 'age');
  const age = AGE_ORDER.map((bucket) => ageRaw.find((a) => a.label === bucket)).filter(Boolean) as { label: string; value: number }[];
  const gender = tvBreakdown(breakdowns?.data, 'follower_demographics', 'gender');
  const countries = tvBreakdown(breakdowns?.data, 'follower_demographics', 'country').sort((a, b) => b.value - a.value).slice(0, 8);
  const cities = tvBreakdown(breakdowns?.data, 'follower_demographics', 'city').sort((a, b) => b.value - a.value).slice(0, 8);

  const covered = age.reduce((acc, a) => acc + a.value, 0);
  const coverage = followers > 0 && covered > 0 ? covered / followers : 1;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartSection title="Возраст">
          {age.length > 0 ? (
            <ExpandableChart title="Возраст аудитории">
              <BarChart
                values={age.map((a) => a.value)}
                labels={age.map((a) => a.label)}
                titles={age.map((a) => `${a.label}: ${fmt.num(a.value)}`)}
                height={200}
              />
            </ExpandableChart>
          ) : (
            <EmptyChart />
          )}
        </ChartSection>
        <ChartSection title="Пол">
          <Breakdown
            items={gender
              .sort((a, b) => b.value - a.value)
              .map((g, i) => ({
                label: GENDER_LABEL[g.label] ?? g.label,
                value: g.value,
                display: fmt.short(g.value),
                color: CHART_CYCLE[i % CHART_CYCLE.length],
              }))}
          />
        </ChartSection>
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartSection title="Топ стран">
          <Breakdown
            items={countries.map((c) => ({
              label: COUNTRY_NAME[c.label] ?? c.label,
              value: c.value,
              display: fmt.short(c.value),
              icon: flag(c.label),
            }))}
          />
        </ChartSection>
        <ChartSection title="Топ городов">
          <Breakdown items={cities.map((c) => ({ label: c.label, value: c.value, display: fmt.short(c.value) }))} />
        </ChartSection>
      </div>
      {coverage < 0.98 && (
        <p className="px-1 text-xs text-muted-foreground">
          Данные частичны (≈{Math.round(coverage * 100)}% аудитории) — Instagram отдаёт демографию только по топ-сегментам и при 100+ подписчиках.
        </p>
      )}
    </div>
  );
}

function BestTimeHeatmap({ online }: { online: IgOnline | undefined }) {
  const [tip, setTip] = useState<TooltipState>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { dayValues, grid, max, best } = aggregateOnline(online);
  // `max` is clamped to a floor of 1, so an all-zero grid still yields best={w:0,h:0,v:0}. Only treat
  // a slot as "best" on a real signal — otherwise the check would render faded (opacity 0.06) and the
  // caption/aria-label would announce a meaningless "Пн 0:00".
  const hasSignal = best.v > 0;

  if (dayValues.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Недостаточно данных об активности аудитории (метрика требует 100+ подписчиков и иногда недоступна).
      </p>
    );
  }

  return (
    <div ref={wrapRef} className="relative" onMouseLeave={() => setTip(null)}>
      <div className="overflow-x-auto pb-2">
        <div className="min-w-[440px] space-y-[2px]">
          <div className="grid gap-[2px]" style={{ gridTemplateColumns: '30px repeat(24, minmax(14px, 1fr))' }}>
            <div />
            {Array.from({ length: 24 }).map((_, h) => (
              <div key={h} className="select-none text-center text-[10px] font-medium text-muted-foreground">
                {h % 3 === 0 ? `${h}` : ''}
              </div>
            ))}
          </div>
          {DAY_NAMES.map((name, w) => (
            <div key={w} className="grid items-center gap-[2px]" style={{ gridTemplateColumns: '30px repeat(24, minmax(14px, 1fr))' }}>
              <div className="select-none text-[11px] font-medium text-muted-foreground">{name}</div>
              {Array.from({ length: 24 }).map((_, h) => {
                const v = grid[w][h];
                const opacity = max > 0 ? Math.max(0.06, v / max) : 0;
                const isBest = hasSignal && best.w === w && best.h === h;
                return (
                  <div
                    key={h}
                    className="flex h-4 cursor-pointer items-center justify-center rounded-sm"
                    style={{
                      backgroundColor: 'hsl(var(--brand-iris))',
                      opacity,
                      border: isBest ? '2px solid hsl(var(--brand-verdant))' : undefined,
                    }}
                    aria-label={isBest ? `Лучший слот: ${name} ${h}:00` : undefined}
                    onMouseMove={(event) => {
                      const rect = wrapRef.current?.getBoundingClientRect();
                      if (rect) setTip({ x: event.clientX - rect.left, y: event.clientY - rect.top, text: `${name} ${h}:00 · ${fmt.short(v)} онлайн` });
                    }}
                  >
                    {/* Non-colour cue for the best slot (a11y) — a ✓ that contrasts on iris in both themes. */}
                    {isBest && (
                      <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="hsl(var(--primary-foreground))" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <ChartTooltip tip={tip} />
      <div className="mt-3 text-xs font-medium text-muted-foreground">
        {hasSignal ? (
          <span>лучший слот: <strong className="text-foreground">{DAY_NAMES[best.w]} {best.h}:00</strong></span>
        ) : 'Мало данных.'}
      </div>
    </div>
  );
}

function ReelsBlock({ posts }: { posts: IgPost[] }) {
  const reels = posts.filter((p) => p.media_product_type === 'REELS');
  if (reels.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">Reels пока нет.</CardContent>
      </Card>
    );
  }
  const avgSec = (r: IgPost) => Math.round(Number(r.ig_reels_avg_watch_time ?? 0) / 1000);
  const totalWatchHours = reels.reduce((acc, r) => acc + Number(r.ig_reels_video_view_total_time ?? 0) / 1000 / 3600, 0);
  const avgWatchAll = reels.length ? Math.round(reels.reduce((acc, r) => acc + avgSec(r), 0) / reels.length) : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3">
        <KpiCard label="Reels" value={fmt.num(reels.length)} />
        <KpiCard label="Ср. время просмотра" value={`${avgWatchAll} сек`} />
        <KpiCard label="Суммарно просмотрено" value={`${fmt.short(Math.round(totalWatchHours))} ч`} />
      </div>
      <ChartSection title="Ср. время просмотра по Reels">
        <ExpandableChart title="Ср. время просмотра по Reels">
          <BarChart
            values={reels.map(avgSec)}
            labels={reels.map((_, i) => `R${i + 1}`)}
            titles={reels.map((r, i) => `R${i + 1}: ${avgSec(r)} сек · ${fmt.short(Number(r.views ?? 0))} просм`)}
          />
        </ExpandableChart>
      </ChartSection>
    </div>
  );
}

type SortKey = 'reach' | 'views' | 'saved' | 'shares';
const SORT_LABEL: Record<SortKey, string> = { reach: 'Охват', views: 'Просмотры', saved: 'Сохранения', shares: 'Репосты' };

function TopPostsBlock({ posts }: { posts: IgPost[] }) {
  const [sort, setSort] = useState<SortKey>('reach');
  if (posts.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">Публикаций пока нет.</CardContent>
      </Card>
    );
  }
  const top = [...posts].sort((a, b) => Number(b[sort] ?? 0) - Number(a[sort] ?? 0)).slice(0, 9);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1">
        {(Object.keys(SORT_LABEL) as SortKey[]).map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setSort(key)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              sort === key ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            }`}
          >
            {SORT_LABEL[key]}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {top.map((post, idx) => <IgPostCard key={post.id ?? idx} post={post} rank={idx + 1} />)}
      </div>
    </div>
  );
}

function InsightsBlock({ insights }: { insights: IgInsight[] }) {
  if (insights.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Недостаточно данных для инсайтов.
        </CardContent>
      </Card>
    );
  }
  const dot = (t: IgInsight['tone']) => (t === 'up' ? 'bg-verdant' : t === 'down' ? 'bg-ember' : 'bg-primary');
  return (
    <div className="grid grid-cols-1 gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2">
      {insights.map((ins, i) => (
        <div key={i} className="flex items-start gap-3 bg-background p-4">
          <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot(ins.tone)}`} />
          <p className="text-sm leading-relaxed text-foreground">{ins.text}</p>
        </div>
      ))}
    </div>
  );
}

function GoalsBlock({ followers, erReach, reachCur, accountKey }: { followers: number; erReach: number; reachCur: number; accountKey: string }) {
  const defaults: IgGoals = {
    followers: Math.ceil((followers || 1000) / 1000) * 1000 + 1000,
    er: 3,
    reach: Math.max(1000, Math.round((reachCur || 5000) * 1.25)),
  };
  const [goals, setGoals] = useState<IgGoals>(() => loadIgGoals(defaults, accountKey));
  // Draft string per field so the user can clear/retype freely; only a finite >0 value is
  // committed + persisted (an empty/invalid entry never clobbers the saved target).
  const [draft, setDraft] = useState<Partial<Record<keyof IgGoals, string>>>({});
  const onType = (key: keyof IgGoals, raw: string) => {
    setDraft((d) => ({ ...d, [key]: raw }));
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      const next = { ...goals, [key]: n };
      setGoals(next);
      saveIgGoals(next, accountKey);
    }
  };
  const commit = (key: keyof IgGoals) =>
    setDraft((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });
  const bars = [
    { key: 'followers' as const, label: 'Подписчики', current: followers, target: goals.followers, render: (n: number) => fmt.num(Math.round(n)), step: 100 },
    { key: 'er' as const, label: 'Вовлечённость (ER), %', current: erReach, target: goals.er, render: (n: number) => n.toFixed(2), step: 0.1 },
    { key: 'reach' as const, label: 'Охват за период', current: reachCur, target: goals.reach, render: (n: number) => fmt.short(n), step: 100 },
  ];
  return (
    <div className="space-y-5">
      {bars.map((b) => {
        const pct = goalPct(b.current, b.target);
        return (
          <div key={b.key} className="space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">{b.label}</span>
              <span className="flex items-center gap-1.5">
                <span className="tabular-nums text-foreground">{b.render(b.current)}</span>
                <span className="text-muted-foreground">/</span>
                <input
                  type="number"
                  min={0}
                  step={b.step}
                  value={draft[b.key] ?? String(b.target)}
                  onChange={(e) => onType(b.key, e.target.value)}
                  onBlur={() => commit(b.key)}
                  className="w-24 rounded-md border bg-background px-2 py-1 text-right text-xs tabular-nums text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                  aria-label={`Цель: ${b.label}`}
                />
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
            <div className="text-right text-xs tabular-nums text-muted-foreground">{Math.round(pct)}%</div>
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        Ориентиры: ER 1–3% — норма, выше 3% — отлично. Цели хранятся локально в браузере.
      </p>
    </div>
  );
}

function PeriodCompareBlock({ rows }: { rows: { label: string; pair: ReturnType<typeof windowPair> }[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs font-medium tracking-wider text-muted-foreground">
            <th className="p-4">Метрика</th>
            <th className="p-4 text-right">Текущий</th>
            <th className="p-4 text-right">Предыдущий</th>
            <th className="p-4 text-right">Δ</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((r) => (
            <tr key={r.label} className="hover:bg-hover-row">
              <td className="p-4 text-muted-foreground">{r.label}</td>
              <td className="p-4 text-right font-medium tabular-nums">{fmt.short(r.pair.cur)}</td>
              <td className="p-4 text-right tabular-nums text-muted-foreground">
                {r.pair.hasPrev ? fmt.short(r.pair.prev) : '—'}
              </td>
              <td className="p-4 text-right">
                <span className="inline-flex justify-end">
                  <DeltaPill delta={pairDelta(r.pair)} />
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface HashtagStat {
  tag: string;
  count: number;
  avgReach: number;
  avgEr: number;
  lift: number;
}

const postEr = (p: IgPost): number => {
  const reach = Number(p.reach ?? 0);
  if (reach <= 0) return 0;
  const ti =
    Number(p.total_interactions ?? 0) ||
    Number(p.like_count ?? 0) + Number(p.comments_count ?? 0) + Number(p.saved ?? 0) + Number(p.shares ?? 0);
  return (ti / reach) * 100;
};

function hashtagStats(posts: IgPost[]): HashtagStat[] {
  const map = new Map<string, { count: number; reach: number; er: number }>();
  let erSum = 0;
  let erCount = 0;
  for (const p of posts) {
    const reach = Number(p.reach ?? 0);
    if (reach <= 0) continue; // skip zero-reach posts for BOTH the baseline and per-tag stats
    const er = postEr(p);
    erSum += er;
    erCount += 1;
    const tags = (p.caption ?? '').match(/#[\p{L}\p{N}_]+/gu) ?? [];
    for (const tag of new Set(tags.map((t) => t.toLowerCase()))) {
      const e = map.get(tag) ?? { count: 0, reach: 0, er: 0 };
      e.count += 1;
      e.reach += reach;
      e.er += er;
      map.set(tag, e);
    }
  }
  const globalEr = erCount > 0 ? erSum / erCount : 0;
  return [...map.entries()]
    .map(([tag, e]) => ({
      tag,
      count: e.count,
      avgReach: e.reach / e.count,
      avgEr: e.er / e.count,
      lift: globalEr > 0 ? ((e.er / e.count - globalEr) / globalEr) * 100 : 0,
    }))
    .sort((a, b) => b.count - a.count || b.avgEr - a.avgEr);
}

function HashtagsBlock({ posts }: { posts: IgPost[] }) {
  const stats = hashtagStats(posts).slice(0, 12);
  if (stats.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          В публикациях нет хэштегов.
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-border text-xs font-medium tracking-wider text-muted-foreground">
            <th className="p-4">Хэштег</th>
            <th className="p-4 text-right">Постов</th>
            <th className="p-4 text-right">Ср. охват</th>
            <th className="p-4 text-right">ER</th>
            <th className="p-4 text-right">Lift к ER</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {stats.map((s) => (
            <tr key={s.tag} className="transition-colors hover:bg-hover-row">
              <td className="p-4 font-medium text-foreground">{s.tag}</td>
              <td className="p-4 text-right tabular-nums text-muted-foreground">{s.count}</td>
              <td className="p-4 text-right tabular-nums">{fmt.short(s.avgReach)}</td>
              <td className="p-4 text-right tabular-nums">{s.avgEr.toFixed(2)}%</td>
              <td className="p-4 text-right font-medium tabular-nums">
                {Math.abs(s.lift) < 0.5 ? (
                  <span className="text-muted-foreground/60">≈0%</span>
                ) : (
                  <span className={s.lift > 0 ? 'text-verdant' : 'text-ember'}>
                    {s.lift > 0 ? '+' : ''}{s.lift.toFixed(0)}%
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const COMPARE_ROWS: { label: string; get: (p: IgPost) => number; pct?: boolean }[] = [
  { label: 'Охват', get: (p) => Number(p.reach ?? 0) },
  { label: 'Просмотры', get: (p) => Number(p.views ?? 0) },
  { label: 'Лайки', get: (p) => Number(p.like_count ?? 0) },
  { label: 'Комментарии', get: (p) => Number(p.comments_count ?? 0) },
  { label: 'Сохранения', get: (p) => Number(p.saved ?? 0) },
  { label: 'Репосты', get: (p) => Number(p.shares ?? 0) },
  { label: 'ER', get: (p) => postEr(p), pct: true },
];

function CompareBlock({ posts }: { posts: IgPost[] }) {
  const pool = posts.slice(0, 12);
  const [sel, setSel] = useState<number[]>(() => [0, 1].filter((i) => i < pool.length));
  const toggle = (i: number) =>
    setSel((cur) => (cur.includes(i) ? cur.filter((x) => x !== i) : cur.length < 4 ? [...cur, i] : cur));
  const chosen = sel.map((i) => ({ i, post: pool[i] })).filter((x) => x.post);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        {pool.map((p, i) => (
          <button
            key={p.id ?? i}
            type="button"
            onClick={() => toggle(i)}
            aria-pressed={sel.includes(i)}
            className={`max-w-[220px] truncate rounded-lg border px-2.5 py-1.5 text-xs font-medium transition-colors ${
              sel.includes(i)
                ? 'border-primary/40 bg-primary/10 text-foreground'
                : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            }`}
          >
            #{i + 1} {MEDIA_TYPE_LABEL[p.media_type ?? ''] ?? 'Пост'}: {(p.caption ?? 'Без подписи').slice(0, 22)}
          </button>
        ))}
      </div>
      {chosen.length < 2 ? (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Выберите минимум 2 публикации для сравнения (до 4).
          </CardContent>
        </Card>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-border text-xs font-medium tracking-wider text-muted-foreground">
                <th className="p-4">Метрика</th>
                {chosen.map((c) => (
                  <th key={c.i} className="p-4 text-right">#{c.i + 1} {MEDIA_TYPE_LABEL[c.post.media_type ?? ''] ?? 'Пост'}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {COMPARE_ROWS.map((row) => {
                const values = chosen.map((c) => row.get(c.post));
                const max = Math.max(...values, 0);
                return (
                  <tr key={row.label} className="hover:bg-hover-row">
                    <td className="p-4 text-muted-foreground">{row.label}</td>
                    {chosen.map((c, idx) => {
                      const v = values[idx];
                      const best = chosen.length > 1 && max > 0 && v === max;
                      return (
                        <td key={c.i} className={`p-4 text-right tabular-nums ${best ? 'font-medium text-verdant' : ''}`}>
                          {best && (
                            <>
                              <span className="sr-only">лучший: </span>
                              <span aria-hidden="true">▲ </span>
                            </>
                          )}
                          {row.pct ? `${v.toFixed(2)}%` : fmt.short(v)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function StoriesBlock({ stories }: { stories: IgStory[] | undefined }) {
  const list = stories ?? [];
  if (list.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">Активных историй нет.</CardContent>
      </Card>
    );
  }
  const sum = (k: keyof IgStory) => list.reduce((acc, s) => acc + Number(s[k] ?? 0), 0);
  const completion = (s: IgStory) => {
    const v = Number(s.views ?? 0);
    if (v <= 0) return 0;
    const drop = Number(s.navigation?.tap_exit ?? 0) + Number(s.navigation?.swipe_forward ?? 0);
    return Math.max(0, Math.min(1, 1 - drop / v));
  };
  const avgCompletion = list.length ? list.reduce((acc, s) => acc + completion(s), 0) / list.length : 0;
  const nav = ['tap_forward', 'tap_back', 'tap_exit', 'swipe_forward'];
  const navItems = nav
    .map((k) => ({ label: NAV_LABEL[k] ?? k, value: list.reduce((acc, s) => acc + Number(s.navigation?.[k] ?? 0), 0) }))
    .filter((x) => x.value > 0);

  const soonest = list
    .map((s) => Date.parse(s.expires_at ?? ''))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)[0];
  const hoursLeft = soonest ? Math.max(0, Math.round((soonest - Date.now()) / 3600000)) : null;

  return (
    <div className="space-y-4">
      {hoursLeft != null && (
        <p className="px-1 text-xs text-ember">Данные историй исчезнут через ~{hoursLeft} ч (24-часовое окно Instagram).</p>
      )}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border lg:grid-cols-4">
        <KpiCard label="Историй" value={fmt.num(list.length)} />
        <KpiCard label="Охват" value={fmt.short(sum('reach'))} />
        <KpiCard label="Ответы" value={fmt.num(sum('replies'))} />
        <KpiCard label="Досматриваемость" value={`${Math.round(avgCompletion * 100)}%`} />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartSection title="Навигация по историям">
          <Breakdown items={navItems.map((n) => ({ label: n.label, value: n.value, display: fmt.short(n.value) }))} />
        </ChartSection>
        <ChartSection title="По историям">
          <div className="space-y-2">
            {list.map((s, i) => (
              <div key={s.id ?? i} className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">{s.media_type === 'VIDEO' ? 'Видео' : 'Фото'} · <span className="font-mono">{fmtDay(s.timestamp ?? '')}</span></span>
                <span className="tabular-nums">
                  {fmt.short(Number(s.reach ?? 0))} охв · {Math.round(completion(s) * 100)}%
                </span>
              </div>
            ))}
          </div>
        </ChartSection>
      </div>
    </div>
  );
}

/**
 * Prominent demo-mode state for the IG tab (shown while data is mock-backed). Replaces the
 * old quiet badge: an explicit "Демо-режим" header, a "Подключить Instagram" CTA that reveals
 * the connection requirements (there's no OAuth flow — connecting = configuring server env),
 * and a "что станет доступно" list so the value is clear before anyone wires it up.
 */
function DemoModeBanner() {
  const [open, setOpen] = useState(false);
  const steps = [
    'Аккаунт Instagram Business или Creator, привязанный к странице Facebook.',
    'Приложение Facebook с доступом к Instagram Graph API.',
    'Добавить в окружение сервера IG_ACCESS_TOKEN (long-lived) и IG_ACCOUNT_ID.',
  ];
  const unlocks = [
    'Охват и просмотры по дням',
    'Вовлечённость по форматам (Reels / посты / Stories)',
    'Демография и география аудитории',
    'Лучшее время для публикации',
    'Метрики Stories и действий в профиле',
  ];
  return (
    <Card className="mt-4 border-status-warn/40 bg-status-warn/[0.02]">
      <CardContent className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-status-warn/15 text-status-warn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="h-4 w-4" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 8h.01M11 12h1v4h1" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-medium text-foreground">Демо-режим</h3>
                <span className="rounded-full bg-status-warn/15 px-1.5 py-0.5 text-[10px] font-medium text-status-warn">
                  примерные данные
                </span>
              </div>
              <p className="mt-1 max-w-prose text-sm text-muted-foreground">
                Цифры на этой странице — образец. Подключите аккаунт Instagram Business, чтобы видеть
                реальные охваты, аудиторию и публикации.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-expanded={open}
            className="shrink-0 rounded-lg bg-primary px-3.5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Подключить Instagram
          </button>
        </div>

        {open && (
          <div className="mt-4 grid gap-5 border-t pt-4 sm:grid-cols-2">
            <div>
              <div className="text-[11px] font-medium tracking-wide text-muted-foreground">Что нужно для подключения</div>
              <ol className="mt-2 space-y-2">
                {steps.map((step, i) => (
                  <li key={i} className="flex gap-2 text-sm text-muted-foreground">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-medium">
                      {i + 1}
                    </span>
                    <span className="leading-relaxed">{step}</span>
                  </li>
                ))}
              </ol>
              <p className="mt-2 text-xs text-muted-foreground">После этого демо-режим отключится автоматически.</p>
            </div>
            <div>
              <div className="text-[11px] font-medium tracking-wide text-muted-foreground">Что станет доступно</div>
              <ul className="mt-2 space-y-1.5">
                {unlocks.map((item, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-muted-foreground">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="mt-0.5 h-3.5 w-3.5 shrink-0 text-verdant" aria-hidden="true">
                      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span className="leading-relaxed">{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DataHealthNote() {
  return (
    <Card className="border-dashed">
      <CardContent className="space-y-1.5 p-5 text-xs text-muted-foreground">
        <p className="font-medium text-foreground">О данных Instagram</p>
        <p>• <span className="text-foreground">impressions</span> и <span className="text-foreground">website_clicks</span> отключены Meta в 2025 — используем <span className="text-foreground">просмотры (views)</span> и <span className="text-foreground">действия в профиле</span>.</p>
        <p>• Демография — только топ-сегменты и при 100+ подписчиках; возможна задержка до 48 ч.</p>
        <p>• Активность по часам (лучшее время) — метрика нестабильна, иногда пуста.</p>
        <p>• Stories живут 24 ч; для истории нужен снапшот в БД (запланировано).</p>
      </CardContent>
    </Card>
  );
}

interface KpiCardProps {
  label: string;
  value: string;
  hint?: string;
  feature?: boolean;
  trend?: MetricDelta | null;
}
function KpiCard({ label, value, hint, feature, trend }: KpiCardProps) {
  return (
    <div className={`bg-background p-4${feature ? ' ring-1 ring-inset ring-primary/40' : ''}`}>
      <div className="text-xs tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-2 flex items-center gap-2">
        <div className="text-3xl font-medium tabular-nums tracking-tight">{value}</div>
        <DeltaPill delta={trend} />
      </div>
      {hint ? <div className="mt-2 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}


function IgPostCard({ post, rank }: { post: IgPost; rank: number }) {
  const typeLabel = MEDIA_TYPE_LABEL[post.media_type ?? ''] ?? 'Пост';
  return (
    <Card className="flex flex-col justify-between overflow-hidden">
      <div>
        <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden bg-muted/50">
          {post.thumbnail_url || post.media_url ? (
            <img src={post.thumbnail_url || post.media_url || ''} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />
          ) : (
            <span className="font-mono text-xs text-muted-foreground">{typeLabel}</span>
          )}
          <div className="absolute left-2 top-2 rounded bg-background/90 px-2 py-0.5 text-xs font-medium text-foreground">#{rank}</div>
          <div className="absolute right-2 top-2 rounded bg-primary px-2 py-0.5 text-[10px] font-medium tracking-wide text-primary-foreground">{typeLabel}</div>
        </div>
        <div className="p-4">
          <p className="line-clamp-3 text-sm leading-relaxed text-foreground">
            {post.caption ? <RichText text={post.caption} /> : <span className="italic text-muted-foreground">Без подписи</span>}
          </p>
        </div>
      </div>
      <div className="grid grid-cols-4 gap-1 border-t border-border/40 bg-muted/10 p-4 pt-0 text-center">
        <Stat label="Охват" value={fmt.short(Number(post.reach ?? 0))} />
        <Stat label="Просм." value={fmt.short(Number(post.views ?? 0))} />
        <Stat label="Сохр." value={fmt.short(Number(post.saved ?? 0))} />
        <Stat label="Репосты" value={fmt.short(Number(post.shares ?? 0))} />
      </div>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="pt-2">
      <div className="text-[10px] font-medium tracking-wider text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-medium tabular-nums">{value}</div>
    </div>
  );
}

function EmptyChart() {
  return <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">Нет данных за период</div>;
}

function InstagramSkeleton() {
  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Skeleton className="h-6 w-1/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="space-y-3 p-5">
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-8 w-2/3" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="space-y-4 p-5">
              <Skeleton className="h-4 w-1/4" />
              <Skeleton className="h-48 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
