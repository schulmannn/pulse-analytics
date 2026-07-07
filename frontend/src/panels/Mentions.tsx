import { useMentions, useMentionsArchive } from '@/api/queries';
import { compareDdMm } from '@/lib/dates';
import { fmt } from '@/lib/format';
import { BarChart } from '@/components/BarChart';
import { Skeleton } from '@/components/ui/skeleton';
import type { Mentions as MentionsData } from '@/api/schemas';

import { ChartSection, WidgetGroup, breakdownVariants } from '@/components/ChartWidget';
import { LineChart } from '@/components/LineChart';

export function Mentions() {
  // Archive (Postgres) loads on mount — free. The live MTProto search only runs on the
  // explicit "Обновить" press (it spends the ~10/day searchPosts quota) and, when it
  // succeeds, supersedes the archive for this view.
  const archive = useMentionsArchive();
  const live = useMentions();

  const liveOk = live.isFetched && !!live.data && live.data.available !== false;
  const data: MentionsData | undefined = liveOk ? live.data : archive.data;

  const refresh = () => live.refetch();
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
      {/* Заголовок панели с кнопкой живого обновления */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-medium tracking-tight">Упоминания бренда</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Сохранённый архив · «Обновить» запускает поиск по Telegram (расход квоты)
          </p>
        </div>
        <button
          onClick={refresh}
          disabled={refreshing}
          className="btn-pill shrink-0 bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
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

/**
 * «Упоминаний по дням» — reusable so both the Mentions panel and the personal Home render it.
 * `byDay` is the full archive (dd.mm → count); the widget windows it by its OWN period (the header
 * pills) and the «Развернуть» overlay windows it further. Slices by day count, since the archive is
 * keyed by dd.mm (one entry per day), not an ISO date. Pass id/homeKey on Home for a distinct prefs
 * identity + the «Убрать с главной» menu item.
 */
export function MentionsByDayWidget({ byDay, id, homeKey }: { byDay: Record<string, number>; id?: string; homeKey?: string }) {
  const sortedDates = Object.keys(byDay).sort((a, b) => compareDdMm(a, b));
  const mentionWindow = (days: number) => {
    const dates = days === 0 ? sortedDates : sortedDates.slice(-days);
    const values = dates.map((date) => byDay[date] ?? 0);
    const titles = dates.map((date) => `${date}: ${fmt.num(byDay[date] ?? 0)}`);
    const axisLabels = [dates[0] ?? '', dates[Math.floor(dates.length / 2)] ?? '', dates[dates.length - 1] ?? ''];
    return { dates, values, titles, axisLabels };
  };
  return (
    <ChartSection
      id={id}
      homeKey={homeKey}
      title="Упоминаний по дням"
      periodControl
      variants={(period) => {
        const w = mentionWindow(period.days);
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
          const w = mentionWindow(days);
          return <LineChart values={w.values} labels={w.axisLabels} titles={w.titles} yMin={0} markAnomalies markExtremes />;
        },
        renderExpandedBar: (days) => {
          const w = mentionWindow(days);
          return <BarChart values={w.values} labels={w.dates} titles={w.titles} />;
        },
        statsFor: (days) => mentionWindow(days).values,
      }}
    />
  );
}

/** Self-fetching «Упоминаний по дням» for the personal Home — pulls the FREE mentions archive
    (no live search, no quota) and renders the widget standalone. */
export function HomeMentionsByDay({ id, homeKey }: { id?: string; homeKey?: string }) {
  const archive = useMentionsArchive();
  if (archive.isPending) {
    return (
      <ChartSection id={id} homeKey={homeKey} title="Упоминаний по дням">
        <Skeleton className="h-40 w-full" />
      </ChartSection>
    );
  }
  return <MentionsByDayWidget byDay={archive.data?.by_day ?? {}} id={id} homeKey={homeKey} />;
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
