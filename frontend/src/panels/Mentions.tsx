import { useMentions, useMentionsArchive } from '@/api/queries';
import { fmt } from '@/lib/format';
import { BarChart } from '@/components/BarChart';
import { Breakdown } from '@/components/Breakdown';
import { Skeleton } from '@/components/ui/skeleton';
import type { Mentions as MentionsData } from '@/api/schemas';
import type { ReactNode } from 'react';

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

  // First archive load with nothing to show yet.
  if (archive.isLoading && !data) return <MentionsSkeletons />;

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
          className="rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
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

  // Подготовка данных графика (последние 14 дней, сортировка по дате "DD.MM")
  const currentYear = new Date().getFullYear();
  const sortedDates = Object.keys(byDay).sort((a, b) => {
    const [dayA, monthA] = a.split('.').map(Number);
    const [dayB, monthB] = b.split('.').map(Number);
    const timeA = new Date(currentYear, monthA - 1, dayA).getTime();
    const timeB = new Date(currentYear, monthB - 1, dayB).getTime();
    return timeA - timeB;
  });

  const last14Dates = sortedDates.slice(-14);
  const chartValues = last14Dates.map((date) => byDay[date] ?? 0);
  const chartTitles = last14Dates.map((date) => `${date}: ${fmt.num(byDay[date])}`);

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
          className="shrink-0 rounded bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {refreshing ? 'Обновление…' : 'Обновить'}
        </button>
      </div>

      {/* Живой поиск не удался — архив остаётся виден */}
      {liveError && (
        <div className="rounded border border-destructive/40 bg-destructive/5 px-4 py-2.5 text-sm text-muted-foreground">
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
          <div className="mt-2 text-3xl font-medium tabular-nums tracking-tight text-ink3">{fmt.short(totalViews)}</div>
        </div>
      </div>

      {/* Аналитические блоки */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartSection title="Упоминаний по дням">
          <div className="pt-2">
            <BarChart values={chartValues} labels={last14Dates} titles={chartTitles} />
          </div>
        </ChartSection>

        <ChartSection title="Кто упоминает · топ каналов">
          <Breakdown items={breakdownItems} />
        </ChartSection>
      </div>

      {/* Лента последних упоминаний */}
      <ChartSection title="Последние упоминания">
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
