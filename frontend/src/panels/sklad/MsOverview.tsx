import { useMsSummary, useMsTopProducts } from '@/api/queries';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartCardBody } from '@/components/chartWidget/ChartCardBody';
import { LineChart } from '@/components/LineChart';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { fmt } from '@/lib/format';
import { usePagePeriod } from '@/lib/period';

/**
 * Обзор «МойСклада» — первый не-социальный источник. Все числа приходят СЕРВЕР-АГРЕГИРОВАННЫМИ
 * (plotseries/profit МойСклада, уже в рублях после /100 на нашем бэке) — миллионы заказов в БД
 * для этой страницы не нужны. Величины (выручка ₽, заказы) — свои и никогда не смешиваются с
 * просмотрами/охватом соцсетей (канон TG-views ≠ IG-reach).
 */
export function MsOverview() {
  const pp = usePagePeriod();
  // «Всё» (0) для живых отчётов МС не предлагаем окном — площадка считает по moment-диапазону.
  const days = pp && pp.days > 0 ? pp.days : 30;
  const summary = useMsSummary(days);
  const top = useMsTopProducts(days);

  if (summary.isPending) {
    return (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="h-[264px] rounded-2xl border border-border bg-card p-5 lg:col-span-3">
            <Skeleton className="h-4 w-1/4" />
            <Skeleton className="mt-3 h-40 w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (summary.isError) {
    const status = (summary.error as { status?: number } | null)?.status;
    if (status === 404) {
      // Канал есть, а токена МойСклада на нём нет — честный onboarding вместо пустых карточек.
      return (
        <EmptyState
          title="МойСклад не подключён"
          reason="Укажите токен API — и здесь появятся выручка, заказы и топ товаров."
          action={{ to: '/connect', label: 'Подключить МойСклад' }}
        />
      );
    }
    return <ErrorState title="Не удалось получить данные МойСклада" reason={summary.error instanceof Error ? summary.error.message : 'ошибка'} />;
  }

  const { revenue, orders } = summary.data;
  const revLabels = revenue.series.map((p) => fmt.day(p.day));
  const revValues = revenue.series.map((p) => p.value);
  const ordLabels = orders.series.map((p) => fmt.day(p.day));
  const ordValues = orders.series.map((p) => p.count);

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
      <ChartWidget id="ms-revenue" title="Выручка" fixedSize="half" noExpand>
        <ChartCardBody value={`${fmt.short(revenue.total)} ₽`} caption={`за ${days} дн.`}>
          {revValues.length > 1 ? (
            <LineChart
              values={revValues}
              labels={revLabels}
              titles={revenue.series.map((p) => `${fmt.day(p.day)}: ${fmt.num(p.value)} ₽`)}
              yMin={0}
            />
          ) : (
            <p className="text-xs text-muted-foreground">Недостаточно дней для графика.</p>
          )}
        </ChartCardBody>
      </ChartWidget>

      <ChartWidget id="ms-orders" title="Заказы" fixedSize="half" noExpand>
        <ChartCardBody
          value={fmt.num(orders.totalCount)}
          caption={`на ${fmt.short(orders.totalSum)} ₽ за ${days} дн.`}
        >
          {ordValues.length > 1 ? (
            <LineChart
              values={ordValues}
              labels={ordLabels}
              titles={orders.series.map((p) => `${fmt.day(p.day)}: ${fmt.num(p.count)} · ${fmt.num(p.sum)} ₽`)}
              yMin={0}
            />
          ) : (
            <p className="text-xs text-muted-foreground">Недостаточно дней для графика.</p>
          )}
        </ChartCardBody>
      </ChartWidget>

      <ChartWidget id="ms-top-products" title="Топ товаров по выручке" defaultSize="full" noExpand>
        {top.isPending ? (
          <div className="space-y-2 py-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={`t${i}`} className="h-6 w-full" />
            ))}
          </div>
        ) : top.isError || !top.data || top.data.rows.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Нет продаж за период.</p>
        ) : (
          <ul>
            {top.data.rows.map((row, i) => (
              <li key={`${row.name}-${i}`} className="flex items-center gap-3 border-t border-border py-2.5 first:border-t-0">
                <span className="w-5 shrink-0 text-center text-xs font-medium tabular-nums text-muted-foreground">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">{row.name}</span>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{fmt.num(row.quantity)} шт.</span>
                <span className="w-24 shrink-0 text-right text-sm font-medium tabular-nums">{fmt.short(row.revenue)} ₽</span>
                {/* Прибыль бывает отрицательной — показываем честно, но без красного крика (канон тихих дельт). */}
                <span className="w-24 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {row.profit >= 0 ? '' : '−'}
                  {fmt.short(Math.abs(row.profit))} ₽
                </span>
              </li>
            ))}
          </ul>
        )}
      </ChartWidget>
    </div>
  );
}
