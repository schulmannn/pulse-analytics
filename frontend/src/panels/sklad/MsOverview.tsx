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
  // «Всё» (0) обслуживается из нашего дневного архива ms_daily (слайс 2а), живые окна — 7/30/90.
  const days = pp ? pp.days : 30;
  const windowLabel = days === 0 ? 'за всё время' : `за ${days} дн.`;
  const summary = useMsSummary(days);
  // По-товарного АРХИВА пока нет (фаза 2б): на «Всё» топ честно считается живым отчётом за 30 дн.
  const topDays = days === 0 ? 30 : days;
  const top = useMsTopProducts(topDays);

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
    if (status === 401) {
      // Токен отозван на стороне МойСклада — честный reconnect-CTA вместо «недоступен».
      return (
        <EmptyState
          title="Токен МойСклада отозван"
          reason="Источник перестал принимать наш токен — создайте новый в МойСкладе и переподключите."
          action={{ to: '/connect', label: 'Переподключить МойСклад' }}
        />
      );
    }
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
  // Средний чек по дням = сумма/число заказов дня; день без заказов — ЧЕСТНЫЙ null-разрыв
  // (деление на ноль дало бы «ноль-которого-не-было» — канон разрывов).
  const avgValues = orders.series.map((p) => (p.count > 0 ? p.sum / p.count : null));
  const avgTotal = orders.totalCount > 0 ? orders.totalSum / orders.totalCount : null;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
      <ChartWidget id="ms-revenue" title="Выручка" fixedSize="half" noExpand>
        <ChartCardBody value={`${fmt.short(revenue.total)} ₽`} caption={windowLabel}>
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
          caption={`на ${fmt.short(orders.totalSum)} ₽ ${windowLabel}`}
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

      <ChartWidget id="ms-avg-check" title="Средний чек" fixedSize="half" noExpand>
        <ChartCardBody value={avgTotal != null ? `${fmt.short(avgTotal)} ₽` : '—'} caption={windowLabel}>
          {avgValues.filter((v) => v != null).length > 1 ? (
            <LineChart
              values={avgValues}
              labels={ordLabels}
              titles={orders.series.map((p) => (p.count > 0 ? `${fmt.day(p.day)}: ${fmt.num(Math.round(p.sum / p.count))} ₽` : `${fmt.day(p.day)}: заказов не было`))}
              yMin={0}
            />
          ) : (
            <p className="text-xs text-muted-foreground">Недостаточно дней с заказами для графика.</p>
          )}
        </ChartCardBody>
      </ChartWidget>

      <ChartWidget id="ms-top-products" title={days === 0 ? 'Топ товаров по выручке · 30 дн.' : 'Топ товаров по выручке'} fixedSize="half" noExpand>
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
            {/* Half-тайл фиксированной высоты вмещает 5 строк без внутреннего скролла (канон плотности). */}
            {top.data.rows.slice(0, 5).map((row, i) => (
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
