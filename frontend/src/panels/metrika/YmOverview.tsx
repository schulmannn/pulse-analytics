import { useContext } from 'react';
import { ChartExpandedContext } from '@/components/ExpandableChart';
import { useYmSources, useYmSummary } from '@/api/queries';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartCardBody } from '@/components/chartWidget/ChartCardBody';
import { LineChart } from '@/components/LineChart';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { ChartSkeleton, TableSkeleton } from '@/components/ui/dataSkeleton';
import { lttbDownsample } from '@/lib/downsample';
import { fmt } from '@/lib/format';
import { usePagePeriod } from '@/lib/period';
import { useMsPagePeriod } from '@/lib/msPeriod';

/**
 * Обзор «Яндекс.Метрики» — веб-аналитика сайта рядом с аналитикой каналов. Все числа приходят
 * СЕРВЕР-АГРЕГИРОВАННЫМИ (дневные отчёты Reporting API с accuracy=full, «Всё» — из нашего архива
 * ym_daily). Величины (визиты, посетители, просмотры страниц) — свои и никогда не смешиваются с
 * TG-просмотрами или IG-охватом (канон TG-views ≠ IG-reach). «Посетители» за окно — СУММА дневных
 * уникальных (уникальность внутри дня, не периода) — подпись карточки это честно оговаривает.
 */
export function YmOverview() {
  const pp = usePagePeriod();
  const days = pp ? pp.days : 30;
  // Окна Метрики сериализует тот же feed-топбар, что у МойСклада (msPeriod — сете-агностичный
  // хелпер): «Всё» (0) обслуживается из архива ym_daily, живые окна — 7/30/90/точный диапазон.
  const period = useMsPagePeriod();
  const windowLabel = pp?.range ? 'за выбранный период' : days === 0 ? 'за всё время' : `за ${days} дн.`;
  const summary = useYmSummary(period);
  const sources = useYmSources(period);

  if (summary.isPending) {
    return (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-[264px] rounded-2xl border border-border bg-card p-5 lg:col-span-3">
            <ChartSkeleton />
          </div>
        ))}
      </div>
    );
  }

  if (summary.isError) {
    const status = (summary.error as { status?: number } | null)?.status;
    if (status === 401) {
      // Токен отозван на стороне Яндекса — честный reconnect-CTA вместо «недоступна».
      return (
        <EmptyState
          title="Токен Яндекса отозван"
          reason="Счётчик перестал принимать наш токен — выпустите новый OAuth-токен и переподключите."
          action={{ to: '/connect?source=metrika', label: 'Переподключить Метрику' }}
        />
      );
    }
    if (status === 404) {
      // Канал есть, а счётчика Метрики на нём нет — честный onboarding вместо пустых карточек.
      return (
        <EmptyState
          title="Яндекс.Метрика не подключена"
          reason="Укажите OAuth-токен — и здесь появятся визиты, посетители и источники трафика."
          action={{ to: '/connect?source=metrika', label: 'Подключить Метрику' }}
        />
      );
    }
    return (
      <ErrorState
        title="Не удалось получить данные Яндекс.Метрики"
        reason={summary.error instanceof Error ? summary.error.message : 'ошибка'}
        onRetry={() => summary.refetch()}
        retrying={summary.isFetching}
      />
    );
  }

  const { visits, users, pageviews } = summary.data;
  // Канон графиков: длинные серии (окно «Всё» после лет архива ym_daily) даунсэмплятся до ~140
  // точек ПЕРЕД рендером; labels/titles строятся из той же выборки, чтобы тултипы совпадали с
  // точками. Оконные 7/30/90 короче порога и проходят как есть.
  const metricCard = (
    id: string,
    title: string,
    block: { total: number; series: Array<{ day: string; value: number }> },
    caption: string,
  ) => {
    const sampled = lttbDownsample(block.series, 140, (p) => p.value);
    return (
      <ChartWidget id={id} title={title} fixedSize="half">
        <ChartCardBody value={fmt.short(block.total)} caption={caption}>
          {sampled.length > 1 ? (
            <LineChart
              values={sampled.map((p) => p.value)}
              labels={sampled.map((p) => fmt.day(p.day))}
              titles={sampled.map((p) => `${fmt.day(p.day)}: ${fmt.num(p.value)}`)}
              yMin={0}
            />
          ) : (
            <EmptyState compact size="chart" title="Недостаточно дней для графика." />
          )}
        </ChartCardBody>
      </ChartWidget>
    );
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
      {metricCard('ym-visits', 'Визиты', visits, windowLabel)}
      {metricCard('ym-users', 'Посетители', users, `${windowLabel} · сумма по дням`)}
      {metricCard('ym-pageviews', 'Просмотры страниц', pageviews, windowLabel)}

      <ChartWidget id="ym-sources" title="Источники трафика" fixedSize="half">
        {sources.isPending ? (
          <TableSkeleton rows={4} columns={2} className="py-2" />
        ) : sources.isError ? (
          <ErrorState
            compact
            size="table"
            className="py-4"
            title="Не удалось получить источники трафика"
            reason={sources.error instanceof Error ? sources.error.message : 'ошибка'}
            onRetry={() => sources.refetch()}
            retrying={sources.isFetching}
          />
        ) : sources.data.rows.length === 0 ? (
          <EmptyState compact size="table" title="Нет визитов за период." />
        ) : (
          <YmSourcesRows rows={sources.data.rows} visitsTotal={sources.data.visits_total} />
        )}
      </ChartWidget>
    </div>
  );
}

/** Строки источников: компактный топ-4 по визитам + сводный хвост; разворот карточки показывает
    ВСЕ строки отчёта. Бары — тихий одноцветный канон (цвет серии, не оценка), как статусы у МС. */
export function YmSourcesRows({
  rows,
  visitsTotal,
}: {
  rows: Array<{ id: string | null; name: string | null; visits: number; users: number }>;
  visitsTotal: number;
}) {
  const expanded = useContext(ChartExpandedContext);
  // Сервер уже сортирует -visits; пересортировка здесь — страховка стабильности вида.
  const ranked = [...rows].sort((a, b) => b.visits - a.visits || (a.id ?? '').localeCompare(b.id ?? ''));
  const top = expanded ? ranked : ranked.slice(0, 4);
  const tail = expanded ? [] : ranked.slice(4);
  const restVisits = tail.reduce((acc, row) => acc + row.visits, 0);
  const max = Math.max(1, ...top.map((row) => Math.max(0, row.visits)));
  return (
    <div className={expanded ? 'space-y-2 pt-1' : 'space-y-1.5'}>
      {top.map((r) => (
        <div key={r.id ?? r.name ?? 'unknown'}>
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="min-w-0 truncate text-foreground">{r.name ?? 'Другие источники'}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              <span className="font-medium text-foreground">{fmt.num(r.visits)}</span>
              {' · '}
              {fmt.num(r.users)} чел.
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(4, Math.round((Math.max(0, r.visits) / max) * 100))}%`,
                backgroundColor: 'hsl(var(--chart-role-primary) / 0.75)',
              }}
            />
          </div>
        </div>
      ))}
      {restVisits > 0 && (
        <p className="text-2xs text-muted-foreground">
          Ещё {fmt.num(restVisits)} визитов из {fmt.num(visitsTotal)}.
        </p>
      )}
    </div>
  );
}
