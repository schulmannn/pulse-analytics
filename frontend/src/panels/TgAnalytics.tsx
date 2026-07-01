import { useTgFull, useTgStats, useTgGraphs } from '@/api/queries';
import { normalizeTgPosts } from '@/lib/posts';
import { fmt } from '@/lib/format';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { Breakdown } from '@/components/Breakdown';
import { DivergingBars } from '@/components/DivergingBars';
import { ExpandableChart } from '@/components/ExpandableChart';
import type { ReactNode } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { usePeriod } from '@/lib/period';
import { Skeleton } from '@/components/ui/skeleton';

const SRC_NAMES: Record<string, string> = {
  Followers: 'Подписчики',
  URL: 'Ссылки',
  Search: 'Поиск',
  'Telegram Search': 'Поиск',
  Groups: 'Группы',
  Channels: 'Каналы',
  PM: 'Личные сообщения',
  Other: 'Прочее',
  'Shareable Chat Folders': 'Папки',
  'Shareable Folder Links': 'Папки',
};

const SENT_NAME: Record<string, string> = {
  Positive: 'Положительные',
  Other: 'Прочие',
  Negative: 'Отрицательные',
};

// Sentiment coding via colour dots (Breakdown), not emoji: verdant = positive, ember = negative,
// ink3 = neutral/other — consistent with the delta palette (verdant up / ember down).
const SENT_COLOR: Record<string, string> = {
  Positive: 'hsl(var(--brand-verdant))',
  Other: 'hsl(var(--ink3))',
  Negative: 'hsl(var(--brand-ember))',
};

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

export type TgAnalyticsGroup = 'dynamics' | 'audience' | 'content';

/** `group` renders only that section family (the Analytics tabs); undefined = all sections. The KPI
    ledger always shows as the group header. */
export function TgAnalytics({ group }: { group?: TgAnalyticsGroup } = {}) {
  const inGroup = (g: TgAnalyticsGroup) => !group || group === g;
  const { days, inRange } = usePeriod();
  const { data: full, isLoading: isFullLoading } = useTgFull(days);
  const { data: cs, isLoading: isStatsLoading } = useTgStats();
  const { data: graphs, isLoading: isGraphsLoading } = useTgGraphs();

  if (isFullLoading || isStatsLoading || isGraphsLoading) {
    return <TgAnalyticsSkeletons />;
  }

  if (!full && !cs && !graphs) {
    return <EmptyState title="Данных аналитики пока нет." reason="Как только collector-агент пришлёт первый снимок, здесь появятся графики." />;
  }

  const vs = full?.views_summary;
  const posts = normalizeTgPosts(full?.posts ?? [], full?.channel ?? {}).filter((post) =>
    inRange(post.date),
  );

  const cur = (o: { current?: number | null } | null | undefined) =>
    o && o.current != null ? o.current : null;

  // 1) KPI
  const activeErvs = posts.map((p) => p.erv).filter((v): v is number => v !== null);
  const avgErv = activeErvs.length ? activeErvs.reduce((a, b) => a + b, 0) / activeErvs.length : null;
  const activeVirs = posts.map((p) => p.virality).filter((v): v is number => v !== null);
  const avgVir = activeVirs.length ? activeVirs.reduce((a, b) => a + b, 0) / activeVirs.length : null;
  const notif = cs?.enabled_notifications;
  const notifPct = notif?.total ? (Number(notif.part ?? 0) / Number(notif.total)) * 100 : null;

  // 2) Views by day
  const viewsByDayRaw: Record<string, number> = vs?.views_by_day ?? {};
  const currentYear = new Date().getFullYear();
  const sortedDates = Object.keys(viewsByDayRaw).sort((a, b) => {
    const [dA, mA] = a.split('.').map(Number);
    const [dB, mB] = b.split('.').map(Number);
    return new Date(currentYear, (mA ?? 1) - 1, dA).getTime() - new Date(currentYear, (mB ?? 1) - 1, dB).getTime();
  });
  const last14Dates = sortedDates.slice(-14);
  const vbdValues = last14Dates.map((d) => Number(viewsByDayRaw[d] ?? 0));
  const vbdTitles = last14Dates.map((d) => `${d}: ${fmt.num(viewsByDayRaw[d] ?? 0)} просмотров`);

  // 3) Reactions by emoji
  const emojiMap: Record<string, number> = {};
  posts.forEach((p) => {
    p.reactionsDetail.forEach((rd) => {
      if (rd.emoji) emojiMap[rd.emoji] = (emojiMap[rd.emoji] ?? 0) + rd.count;
    });
  });
  const topEmojis = Object.entries(emojiMap)
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);

  // 4) Engagement composition
  const engagementComposition = [
    { label: 'Реакции', value: Number(vs?.total_reactions ?? 0), color: 'hsl(var(--chart-1))' },
    { label: 'Репосты', value: Number(vs?.total_forwards ?? 0), color: 'hsl(var(--chart-2))' },
    { label: 'Комментарии', value: Number(vs?.total_replies ?? 0), color: 'hsl(var(--chart-3))' },
  ].filter((item) => item.value > 0);

  // 5) Avg views by type
  const typeNames: Record<string, string> = {
    photo: 'Фото', video: 'Видео', poll: 'Опросы', document: 'Файлы',
    text: 'Текст', audio: 'Аудио', voice: 'Голос', link: 'Ссылки',
  };
  const rawViewsByType = vs?.avg_views_by_type;
  const viewsByType = rawViewsByType
    ? Object.entries(rawViewsByType)
        .map(([key, value]) => ({ label: typeNames[key] || key, value: Number(value) }))
        .filter((item) => item.value > 0)
        .sort((a, b) => b.value - a.value)
    : [];

  const formatMsDate = (ts: number) => {
    const d = new Date(ts);
    return `${d.getDate()} ${MON[d.getMonth()] ?? ''}`;
  };

  // 6) Subscriber growth
  const growthGroup = graphs?.growth;
  const growthSeries = growthGroup?.series?.[0];
  const hasGrowth = growthSeries && growthSeries.values.length >= 2;

  // 7) Views & reposts
  const interGroup = graphs?.interactions;
  const interSeries = interGroup?.series ?? [];
  const viewSeries = interSeries.find((s) => /view|просмотр/i.test(s.name ?? '')) || interSeries[0];
  const shareSeries = interSeries.find((s) => /share|репост/i.test(s.name ?? '')) || interSeries[1];

  // 8) Sources / languages / sentiment
  const mapSourceItems = (
    arr: Array<{ label?: string | null; value?: number | null }> | null | undefined,
    mapper?: Record<string, string>,
    colorMapper?: Record<string, string>,
  ) => {
    if (!arr) return [];
    return arr
      .map((item) => {
        const rawLabel = item.label ?? '';
        return {
          label: mapper ? mapper[rawLabel] || rawLabel : rawLabel,
          value: Number(item.value ?? 0),
          color: colorMapper ? colorMapper[rawLabel] : undefined,
          display: fmt.num(Number(item.value ?? 0)),
        };
      })
      .filter((item) => item.value > 0);
  };
  const vbsItems = mapSourceItems(graphs?.views_by_source, SRC_NAMES);
  const nfsItems = mapSourceItems(graphs?.new_followers_by_source, SRC_NAMES);
  const langItems = mapSourceItems(graphs?.languages);
  const sentItems = mapSourceItems(graphs?.reactions_sentiment, SENT_NAME, SENT_COLOR);

  // 9) Hours
  const thData = graphs?.top_hours;
  const hasHours = thData && thData.values.length > 0;
  let peakHourStr = '';
  if (hasHours && thData) {
    const argmax = thData.values.indexOf(Math.max(...thData.values));
    peakHourStr = `пик активности ~ ${thData.hours[argmax] ?? argmax}:00`;
  }

  // 10) Net subscribers
  const fGroup = graphs?.followers;
  const fSeries = fGroup?.series ?? [];
  const joinedSeries = fSeries.find((s) => /join|подпис/i.test(s.name ?? '')) || fSeries[0];
  const leftSeries = fSeries.find((s) => /left|отпис/i.test(s.name ?? '')) || fSeries[1];

  let net30Values: number[] = [];
  let net30Titles: string[] = [];
  let netSummaryStr = '';
  let joinedTotal = 0;
  let leftTotal = 0;

  if (joinedSeries && leftSeries) {
    const mLen = Math.min(joinedSeries.values.length, leftSeries.values.length);
    const netArr: number[] = [];
    const fx = fGroup?.x ?? [];
    for (let i = 0; i < mLen; i++) {
      const jV = Number(joinedSeries.values[i] ?? 0);
      const lV = Number(leftSeries.values[i] ?? 0);
      joinedTotal += jV;
      leftTotal += lV;
      netArr.push(jV - lV);
    }
    net30Values = netArr.slice(-30);
    const fx30 = fx.slice(-30);
    net30Titles = net30Values.map((v, idx) => {
      const ts = fx30[idx];
      return `${ts ? formatMsDate(ts) : ''}: ${v >= 0 ? '+' : ''}${fmt.num(v)} за день`;
    });
    const netPeriod = joinedTotal - leftTotal;
    netSummaryStr = `${netPeriod >= 0 ? '+' : ''}${fmt.num(netPeriod)} за период`;
  }

  // 12) Weekday
  const wdViews: number[] = Array(7).fill(0);
  const wdCount: number[] = Array(7).fill(0);
  full?.posts?.forEach((p) => {
    if (!p.date) return;
    const day = new Date(p.date).getDay();
    wdViews[day] += Number(p.views ?? p.view_count ?? 0);
    wdCount[day] += 1;
  });
  const wdOrder = [1, 2, 3, 4, 5, 6, 0];
  const wdLabels = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
  const wdAvgValues = wdOrder.map((idx) => {
    const count = wdCount[idx] ?? 0;
    return count ? Math.round((wdViews[idx] ?? 0) / count) : 0;
  });
  const wdCountValues = wdOrder.map((idx) => wdCount[idx] ?? 0);
  const maxWdAvg = Math.max(...wdAvgValues);
  const bestWdLabel = maxWdAvg > 0 ? wdLabels[wdAvgValues.indexOf(maxWdAvg)] ?? '' : '';

  const interLabels = (g: { x: number[] }) =>
    [g.x[0], g.x[Math.floor(g.x.length / 2)], g.x[g.x.length - 1]].map((ts) => (ts ? formatMsDate(ts) : ''));

  return (
    <div className="space-y-6">
      {/* 1) KPI — hairline ledger (gap-px over bg-border draws the 1px dividers) */}
      <div className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
        <div className="bg-background p-4">
          <div className="text-2xs font-medium tracking-wider text-muted-foreground">Просмотров / пост</div>
          <div className="mt-1 text-xl font-medium tabular-nums">{fmt.short(cur(cs?.views_per_post) ?? vs?.avg_views ?? 0)}</div>
          {vs?.posts_analyzed ? <div className="mt-1 truncate text-2xs text-muted-foreground">по {vs.posts_analyzed} постам</div> : null}
        </div>
        <div className="bg-background p-4">
          <div className="text-2xs font-medium tracking-wider text-muted-foreground">Ср. ERV</div>
          <div className="mt-1 text-xl font-medium tabular-nums">{avgErv != null ? `${avgErv.toFixed(1)}%` : '—'}</div>
          <div className="mt-1 truncate text-2xs text-muted-foreground">вовлечённость на просмотр</div>
        </div>
        <div className="bg-background p-4">
          <div className="text-2xs font-medium tracking-wider text-muted-foreground">Виральность</div>
          <div className="mt-1 text-xl font-medium tabular-nums">{avgVir != null ? `${avgVir.toFixed(1)}%` : '—'}</div>
          <div className="mt-1 truncate text-2xs text-muted-foreground">репосты / просмотры</div>
        </div>
        <div className="bg-background p-4">
          <div className="text-2xs font-medium tracking-wider text-muted-foreground">Репостов / пост</div>
          <div className="mt-1 text-xl font-medium tabular-nums">{cur(cs?.shares_per_post) != null ? fmt.short(cur(cs?.shares_per_post)!) : '—'}</div>
          {vs?.total_forwards ? <div className="mt-1 truncate text-2xs text-muted-foreground">{fmt.short(vs.total_forwards)} всего</div> : null}
        </div>
        <div className="bg-background p-4">
          <div className="text-2xs font-medium tracking-wider text-muted-foreground">Реакций / пост</div>
          <div className="mt-1 text-xl font-medium tabular-nums">{cur(cs?.reactions_per_post) != null ? fmt.short(cur(cs?.reactions_per_post)!) : '—'}</div>
          {vs?.total_reactions ? <div className="mt-1 truncate text-2xs text-muted-foreground">{fmt.short(vs.total_reactions)} всего</div> : null}
        </div>
        <div className="bg-background p-4">
          <div className="text-2xs font-medium tracking-wider text-muted-foreground">Уведомления вкл.</div>
          <div className="mt-1 text-xl font-medium tabular-nums">{notifPct != null ? `${notifPct.toFixed(1)}%` : '—'}</div>
          {notif ? <div className="mt-1 truncate text-2xs text-muted-foreground">{fmt.short(notif.part ?? 0)} из {fmt.short(notif.total ?? 0)}</div> : null}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {inGroup('dynamics') && last14Dates.length >= 2 && (
          <ChartSection title="Просмотры по дням">
            <ExpandableChart title="Просмотры по дням">
              <LineChart values={vbdValues} labels={[last14Dates[0] ?? '', last14Dates[Math.floor(last14Dates.length / 2)] ?? '', last14Dates[last14Dates.length - 1] ?? '']} titles={vbdTitles} />
            </ExpandableChart>
          </ChartSection>
        )}

        {inGroup('content') && topEmojis.length > 0 && (
          <ChartSection title="Реакции по эмодзи">
            <Breakdown items={topEmojis.map((e) => ({ label: e.label, value: e.value, display: fmt.num(e.value) }))} />
          </ChartSection>
        )}

        {inGroup('content') && engagementComposition.length > 0 && (
          <ChartSection title="Состав вовлечённости">
            <Breakdown items={engagementComposition.map((c) => ({ label: c.label, value: c.value, display: fmt.num(c.value), color: c.color }))} />
          </ChartSection>
        )}

        {inGroup('content') && viewsByType.length > 0 && (
          <ChartSection title="Ср. охват по типу">
            <Breakdown items={viewsByType.map((t) => ({ label: t.label, value: t.value, display: fmt.num(t.value) }))} />
          </ChartSection>
        )}

        {inGroup('dynamics') && hasGrowth && growthGroup && growthSeries && (
          <ChartSection title="Рост подписчиков">
            <ExpandableChart title="Рост подписчиков">
              <LineChart
                values={growthSeries.values}
                titles={growthSeries.values.map((v, i) => `${growthGroup.x[i] ? formatMsDate(growthGroup.x[i]!) : ''}: ${fmt.num(v)} подписчиков`)}
                labels={interLabels(growthGroup)}
              />
            </ExpandableChart>
          </ChartSection>
        )}

        {inGroup('dynamics') && interGroup && viewSeries && shareSeries && (
          <ChartSection title="Просмотры и репосты">
            <div className="space-y-4">
              <div>
                <div className="mb-2 text-2xs font-medium tracking-wider text-muted-foreground">{viewSeries.name || 'Просмотры'}</div>
                <ExpandableChart title={viewSeries.name || 'Просмотры'}>
                  <LineChart values={viewSeries.values} labels={interLabels(interGroup)} />
                </ExpandableChart>
              </div>
              <div>
                <div className="mb-2 text-2xs font-medium tracking-wider text-muted-foreground">{shareSeries.name || 'Репосты'}</div>
                <ExpandableChart title={shareSeries.name || 'Репосты'}>
                  <LineChart values={shareSeries.values} labels={interLabels(interGroup)} />
                </ExpandableChart>
              </div>
            </div>
          </ChartSection>
        )}

        {inGroup('audience') && vbsItems.length > 0 && (
          <ChartSection title="Просмотры по источникам">
            <Breakdown items={vbsItems} />
          </ChartSection>
        )}
        {inGroup('audience') && nfsItems.length > 0 && (
          <ChartSection title="Новые подписчики по источникам">
            <Breakdown items={nfsItems} />
          </ChartSection>
        )}
        {inGroup('audience') && langItems.length > 0 && (
          <ChartSection title="Языки аудитории">
            <Breakdown items={langItems} />
          </ChartSection>
        )}
        {inGroup('audience') && sentItems.length > 0 && (
          <ChartSection title="Тональность реакций">
            <Breakdown items={sentItems} />
          </ChartSection>
        )}

        {inGroup('audience') && hasHours && thData && (
          <ChartSection title="Активность по часам">
            <ExpandableChart title="Активность по часам">
              <BarChart values={thData.values} labels={thData.hours.map(String)} titles={thData.values.map((v, i) => `${thData.hours[i] ?? i}:00 — ${fmt.num(v)}`)} />
            </ExpandableChart>
            {peakHourStr && <div className="mt-3 text-xs font-medium text-muted-foreground">{peakHourStr}</div>}
          </ChartSection>
        )}

        {inGroup('dynamics') && net30Values.length > 0 && (
          <ChartSection title="Чистый прирост подписчиков (30д)">
            <ExpandableChart title="Чистый прирост подписчиков (30д)">
              <DivergingBars values={net30Values} titles={net30Titles} />
            </ExpandableChart>
            {netSummaryStr && <div className="mt-3 text-xs font-medium text-muted-foreground">прирост: {netSummaryStr}</div>}
          </ChartSection>
        )}

        {inGroup('dynamics') && (joinedTotal > 0 || leftTotal > 0) && (
          <ChartSection title="Динамика оттока">
            <Breakdown items={[
              { label: 'Подписалось', value: joinedTotal, display: fmt.num(joinedTotal), color: 'hsl(var(--brand-verdant))' },
              { label: 'Отписалось', value: leftTotal, display: fmt.num(leftTotal), color: 'hsl(var(--brand-ember))' },
            ].filter((i) => i.value > 0)} />
          </ChartSection>
        )}

        {inGroup('audience') && maxWdAvg > 0 && (
          <ChartSection title="По дням недели">
            <div className="space-y-4">
              <div>
                <div className="mb-2 text-2xs font-medium tracking-wider text-muted-foreground">Ср. просмотры</div>
                <ExpandableChart title="Средние просмотры по дням недели">
                  <BarChart values={wdAvgValues} labels={wdLabels} titles={wdAvgValues.map((v, i) => `${wdLabels[i]}: ${fmt.num(v)} ср. просмотров`)} />
                </ExpandableChart>
              </div>
              <div>
                <div className="mb-2 text-2xs font-medium tracking-wider text-muted-foreground">Количество постов</div>
                <ExpandableChart title="Количество постов по дням недели">
                  <BarChart values={wdCountValues} labels={wdLabels} titles={wdCountValues.map((v, i) => `${wdLabels[i]}: ${fmt.num(v)} постов`)} />
                </ExpandableChart>
              </div>
              {bestWdLabel && <div className="mt-1 text-xs font-medium text-muted-foreground">лучший день: <strong className="text-foreground">{bestWdLabel}</strong></div>}
            </div>
          </ChartSection>
        )}
      </div>
    </div>
  );
}

function TgAnalyticsSkeletons() {
  // Mirror the real render — open KPI ledger + hairline chart sections — so nothing swaps on load.
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="bg-background p-4">
            <Skeleton className="h-2.5 w-2/3" />
            <Skeleton className="mt-2 h-5 w-1/2" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-3">
            <Skeleton className="h-3 w-1/4" />
            <Skeleton className="h-40 w-full" />
          </div>
        ))}
      </div>
    </div>
  );
}
