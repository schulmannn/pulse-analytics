import { useMentions, useMentionsArchive } from '@/api/queries';
import { compareDdMm } from '@/lib/dates';
import { fmt, ddmmDay } from '@/lib/format';
import { BarChart } from '@/components/BarChart';
import { Skeleton } from '@/components/ui/skeleton';
import type { Mentions as MentionsData } from '@/api/schemas';

import { ChartSection } from '@/components/ChartWidget';
import { WidgetGroup } from '@/components/widgets/WidgetGroup';
import { breakdownVariants } from '@/components/widgets/variants';
import { LineChart } from '@/components/LineChart';
import { useWidgetPeriod } from '@/lib/period';
import { useWidgetInView } from '@/lib/widgetViewport';
import type { WidgetViz } from '@/lib/widgetMetrics';
import { ErrorState } from '@/components/ErrorState';

/**
 * MOBILE «Упоминания» — preserved verbatim from the pre-redesign panel (the desktop redesign is a
 * separate JS branch). Layout, controls and semantics are intentionally unchanged; do not restyle.
 */
export function MentionsMobile() {
  // Archive (Postgres) loads on mount — free. The live MTProto search only runs on the
  // explicit "Обновить" press (it spends the ~10/day searchPosts quota). The archive remains the
  // authority: after a successful live search the server has persisted it, then we re-read it.
  const archive = useMentionsArchive();
  const live = useMentions();

  const liveOk = live.isFetched && !!live.data && live.data.available !== false;
  const data: MentionsData | undefined = archive.data;

  const refresh = async () => {
    const result = await live.refetch();
    if (result.data && result.data.available !== false) await archive.refetch();
  };
  const refreshing = live.isFetching;

  // A failed live search (quota/premium/error) — surfaced inline without wiping the archive.
  const liveError = (() => {
    if (live.isFetched && live.data && live.data.available === false) {
      return /premium/i.test(live.data.error || '')
        ? 'Нужен аккаунт с Telegram Premium.'
        : live.data.error || 'Поиск недоступен.';
    }
    if (live.isError) return live.error instanceof Error ? live.error.message : 'Ошибка запроса';
    return null;
  })();

  // First archive load with nothing to show yet (isPending also covers the pre-channel gate).
  if (archive.isPending && !data) return <MentionsSkeletons />;

  const hasData =
    !!data && data.available !== false && ((data.total ?? 0) > 0 || (data.recent?.length ?? 0) > 0);

  // Nothing archived yet (and no live result) → invite the quota-costing search.
  if (!hasData) {
    return (
      <div className="flex flex-col items-center justify-center rounded border border-border bg-background px-4 py-12 text-center">
        <h3 className="mb-1 text-base font-medium text-foreground">Аналитика упоминаний бренда</h3>
        <p className="mb-5 max-w-md text-sm text-muted-foreground">
          В архиве пока нет упоминаний. Поиск задействует MTProto API и расходует ежедневную
          лимит-квоту аккаунта.
        </p>
        {liveError && <p className="mb-4 text-sm text-destructive">{liveError}</p>}
        <button
          onClick={refresh}
          disabled={refreshing}
          className="btn-pill bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {refreshing ? 'Поиск…' : 'Загрузить упоминания'}
        </button>
      </div>
    );
  }

  // Безопасный маппинг данных с сохранением всех легаси фоллбэков
  const total = data?.total ?? 0;
  const uniqueChannels = data?.unique_channels ?? 0;
  const totalViews = data?.total_views ?? 0;
  const quota = data?.quota ?? null;
  const skipped = data?.skipped ?? [];
  const byDay: Record<string, number> = data?.by_day ?? {};
  const topChannels = data?.top_channels ?? [];
  const recent = data?.recent ?? [];

  // Подготовка данных топ каналов
  const breakdownItems = topChannels.map((ch) => ({
    label: ch.username ? `@${ch.username}` : ch.title || 'Без названия',
    value: ch.count,
    display: `${ch.count} · ${fmt.short(ch.views ?? 0)} охв`,
  }));

  return (
    <div className="space-y-6">
      {/* Route header already says «Упоминания»; this row explains freshness and owns the action. */}
      <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Сохранённый архив Telegram. Ручное обновление запускает живой поиск и расходует дневную квоту.
        </p>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="btn-pill shrink-0 border border-border bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-hover-row disabled:opacity-50"
        >
          {refreshing ? 'Обновление…' : 'Обновить'}
        </button>
        <span role="status" className="sr-only">{refreshing ? 'Обновление…' : liveOk ? 'Данные обновлены' : ''}</span>
      </div>

      {/* Живой поиск не удался — архив остаётся виден */}
      {liveError && (
        <div role="alert" className="rounded border border-destructive/40 bg-destructive/5 px-4 py-2.5 text-sm text-muted-foreground">
          Не удалось обновить: {liveError} Показаны сохранённые данные.
        </div>
      )}

      {/* KPI Метрики */}
      <div className="grid grid-cols-1 gap-px border-t border-border bg-border sm:grid-cols-3">
        <div className="bg-background p-5">
          <div className="text-xs tracking-wide text-muted-foreground">Упоминаний</div>
          <div className="mt-2 text-3xl font-medium tabular-nums tracking-tight">{fmt.num(total)}</div>
        </div>
        <div className="bg-background p-5">
          <div className="text-xs tracking-wide text-muted-foreground">Каналов</div>
          <div className="mt-2 text-3xl font-medium tabular-nums tracking-tight text-ink2">{fmt.num(uniqueChannels)}</div>
        </div>
        <div className="bg-background p-5">
          <div className="text-xs tracking-wide text-muted-foreground">Суммарный охват</div>
          <div className="mt-2 text-3xl font-medium tabular-nums tracking-tight text-ink3">{fmt.kpi(totalViews)}</div>
        </div>
      </div>

      {/* Аналитические блоки */}
      <WidgetGroup id="mentions" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
        <MentionsByDayWidget byDay={byDay} />

        <ChartSection title="Кто упоминает · топ каналов" variants={breakdownVariants(breakdownItems)} />
      </WidgetGroup>

      {/* Лента последних упоминаний — full = content-height so the feed grows instead of
          scrolling inside a fixed tile. */}
      <ChartSection title="Последние упоминания" defaultSize="full">
        {recent.length === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Упоминаний не найдено.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {recent.map((item, idx) => (
              <div key={idx} className="py-3.5 first:pt-0 last:pb-0">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {item.link ? (
                      <a
                        href={item.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-sm font-medium text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
                      >
                        {item.title || 'Канал'}
                      </a>
                    ) : (
                      <span className="text-sm font-medium text-foreground">
                        {item.title || 'Канал'}
                      </span>
                    )}
                    {item.username && (
                      <span className="font-mono text-xs text-muted-foreground">
                        @{item.username}
                      </span>
                    )}
                  </div>
                  <div className="shrink-0 text-xs tabular-nums text-muted-foreground sm:text-right">
                    {fmt.short(item.views ?? 0)} просм · {fmt.date(item.date)}
                  </div>
                </div>
                {item.snippet && (
                  <p className="mt-1 line-clamp-2 text-sm leading-relaxed text-muted-foreground">
                    {item.snippet}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </ChartSection>

      {/* Лимиты и квоты */}
      {quota || skipped.length > 0 ? (
        <div className="flex flex-wrap gap-x-2 px-1 text-xs tabular-nums text-muted-foreground">
          {quota && (
            <span>
              квота: {quota.remains ?? '—'}/{quota.total ?? '—'} бесплатных
            </span>
          )}
          {quota && skipped.length > 0 && <span>·</span>}
          {skipped.length > 0 && (
            <span className="text-destructive/90">пропущено по квоте: {skipped.join(', ')}</span>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Slice the dd.mm-keyed archive by day count and build both chart presentations. Tolerant of both
    «DD.MM» (live/archive) and «YYYY-MM-DD» (demo fixture) keys so the demo chart renders too. */
function mentionsWindow(byDay: Record<string, number>, days: number) {
  const norm = (key: string): string => {
    // YYYY-MM-DD → DD.MM (demo fixture emits ISO days in the legacy by_day map).
    const iso = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return iso ? `${iso[3]}.${iso[2]}` : key;
  };
  const entries = Object.entries(byDay).map(([k, v]) => [norm(k), v] as const);
  entries.sort((a, b) => compareDdMm(a[0], b[0]));
  const sliced = days === 0 ? entries : entries.slice(-days);
  const dates = sliced.map((e) => e[0]);
  const values = sliced.map((e) => e[1] ?? 0);
  const titles = sliced.map((e) => `${ddmmDay(e[0])}: ${fmt.num(e[1] ?? 0)}`);
  const axisLabels = [
    ddmmDay(dates[0] ?? ''),
    ddmmDay(dates[Math.floor(dates.length / 2)] ?? ''),
    ddmmDay(dates[dates.length - 1] ?? ''),
  ];
  return { dates, values, titles, axisLabels };
}

/** «Упоминаний по дням» on the Mentions surface. It keeps its source-screen ChartSection. */
export function MentionsByDayWidget({ byDay, id, homeKey }: { byDay: Record<string, number>; id?: string; homeKey?: string }) {
  return (
    <ChartSection
      id={id}
      homeKey={homeKey}
      title="Упоминаний по дням"
      periodControl
      variants={(period) => {
        const w = mentionsWindow(byDay, period.days);
        return [
          {
            key: 'bar',
            label: 'Столбцы',
            // No wrapper padding: the chart fills the measured tile body exactly, so an extra pt-*
            // here would push it past the fixed tile and grow an inner scrollbar.
            render: <BarChart values={w.values} labels={w.dates} titles={w.titles} />,
          },
          {
            key: 'line',
            label: 'Линия',
            render: <LineChart values={w.values} labels={w.axisLabels} titles={w.titles} yMin={0} />,
          },
        ];
      }}
      expand={{
        renderExpanded: (days) => {
          const w = mentionsWindow(byDay, days);
          return <LineChart values={w.values} labels={w.axisLabels} titles={w.titles} yMin={0} markAnomalies markExtremes />;
        },
        renderExpandedBar: (days) => {
          const w = mentionsWindow(byDay, days);
          return <BarChart values={w.values} labels={w.dates} titles={w.titles} />;
        },
        statsFor: (days) => mentionsWindow(byDay, days).values,
      }}
    />
  );
}

/** Bare, config-driven body for Home. ConfigWidget owns the card, period and presentation switch. */
export function MentionsWidgetBody({ viz }: { viz: WidgetViz }) {
  // Прогрессивная загрузка Главной: офскрин-пин не фетчит (вне Главной контекст = true).
  // Позиционные аргументы = дефолты хука, queryKey прежний.
  const inView = useWidgetInView();
  const archive = useMentionsArchive(0, null, undefined, null, { enabled: inView });
  const { days } = useWidgetPeriod();

  if (archive.isPending) return <Skeleton className="h-40 w-full" />;
  if (archive.isError) {
    return <ErrorState title="Не удалось загрузить упоминания" onRetry={() => archive.refetch()} />;
  }

  const w = mentionsWindow(archive.data?.by_day ?? {}, days);
  return viz === 'line'
    ? <LineChart values={w.values} labels={w.axisLabels} titles={w.titles} yMin={0} />
    : <BarChart values={w.values} labels={w.dates} titles={w.titles} />;
}

function MentionsSkeletons() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="w-full space-y-2 sm:w-1/3">
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
        <Skeleton className="h-9 w-32 shrink-0" />
      </div>

      {/* KPI — open ledger scaffold (matches the live render, no card→ledger swap on load) */}
      <div className="grid grid-cols-1 gap-px border-t border-border bg-border sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="bg-background p-5">
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="mt-2 h-8 w-2/3" />
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="space-y-3">
            <Skeleton className="h-3 w-1/4" />
            <Skeleton className="h-40 w-full" />
          </div>
        ))}
      </div>

      <div className="space-y-3">
        <Skeleton className="h-3 w-1/4" />
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="space-y-2 border-b border-border/50 py-3 last:border-0">
              <div className="flex items-center justify-between">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-1/5" />
              </div>
              <Skeleton className="h-3 w-3/4" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
