import { useMentions } from '@/api/queries';
import { fmt } from '@/lib/format';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { BarChart } from '@/components/BarChart';
import { Breakdown } from '@/components/Breakdown';
import { Skeleton } from '@/components/ui/skeleton';

export function Mentions() {
  const { data, isFetching, isError, error, refetch, isFetched } = useMentions();

  if (isFetching) {
    return <MentionsSkeletons />;
  }

  if (isError) {
    return (
      <Card className="border-destructive/40">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          Не удалось загрузить данные: {error instanceof Error ? error.message : 'ошибка сервера'}
          <div className="mt-4">
            <button
              onClick={() => refetch()}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90"
            >
              Попробовать снова
            </button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Заглушка до первого ручного запроса для экономии квоты
  if (!isFetched) {
    return (
      <Card className="border-dashed">
        <CardContent className="flex flex-col items-center justify-center py-12 text-center">
          <h3 className="mb-1 text-base font-semibold text-foreground">Аналитика упоминаний бренда</h3>
          <p className="mb-5 max-w-md text-sm text-muted-foreground">
            Запрос задействует поиск MTProto API и расходует ежедневную лимит-квоту аккаунта.
          </p>
          <button
            onClick={() => refetch()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90"
          >
            Загрузить упоминания
          </button>
        </CardContent>
      </Card>
    );
  }

  // Обработка состояния недоступности функции поиска
  if (data && data.available === false) {
    const isPremiumError = data.error ? /premium/i.test(data.error) : false;
    const hint = isPremiumError
      ? 'Нужен аккаунт с Telegram Premium.'
      : data.error || 'Поиск недоступен.';

    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-lg text-destructive">Не удалось загрузить</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">{hint}</p>
          <button
            onClick={() => refetch()}
            className="rounded-md bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground transition-colors hover:bg-secondary/80"
          >
            Повторить запрос
          </button>
        </CardContent>
      </Card>
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
      {/* Заголовок панели с кнопкой обновления */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-xl font-bold tracking-tight">Упоминания бренда</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Прямой поиск по контенту публичных Telegram-каналов
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="shrink-0 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          Обновить данные
        </button>
      </div>

      {/* KPI Метрики */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="p-5">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Упоминаний</div>
            <div className="mt-2 text-3xl font-semibold tabular-nums">{fmt.num(total)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Каналов</div>
            <div className="mt-2 text-3xl font-semibold tabular-nums">{fmt.num(uniqueChannels)}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-5">
            <div className="text-xs uppercase tracking-wide text-muted-foreground">Суммарный охват</div>
            <div className="mt-2 text-3xl font-semibold tabular-nums">{fmt.short(totalViews)}</div>
          </CardContent>
        </Card>
      </div>

      {/* Аналитические блоки */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Упоминаний по дням
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="pt-2">
              <BarChart values={chartValues} labels={last14Dates} titles={chartTitles} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
              Кто упоминает · топ каналов
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Breakdown items={breakdownItems} />
          </CardContent>
        </Card>
      </div>

      {/* Лента последних упоминаний */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Последние упоминания
          </CardTitle>
        </CardHeader>
        <CardContent>
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
                          className="text-sm font-semibold text-primary hover:underline"
                        >
                          {item.title || 'Канал'}
                        </a>
                      ) : (
                        <span className="text-sm font-semibold text-foreground">
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
        </CardContent>
      </Card>

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
      {/* DESIGN: Claude review */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="w-full space-y-2 sm:w-1/3">
          <Skeleton className="h-6 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
        <Skeleton className="h-9 w-32 shrink-0" />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="space-y-3 p-5">
              <Skeleton className="h-3 w-1/2" />
              <Skeleton className="h-8 w-2/3" />
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardContent className="space-y-4 p-5">
            <Skeleton className="h-4 w-1/4" />
            <Skeleton className="h-40 w-full" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="space-y-4 p-5">
            <Skeleton className="h-4 w-1/3" />
            <div className="space-y-2.5">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-11/12" />
              <Skeleton className="h-8 w-4/5" />
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="space-y-4 p-5">
          <Skeleton className="h-4 w-1/4" />
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
        </CardContent>
      </Card>
    </div>
  );
}
