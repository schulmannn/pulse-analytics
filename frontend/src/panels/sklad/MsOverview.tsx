import { useContext } from 'react';
import { Link } from 'react-router-dom';
import { ChartExpandedContext } from '@/components/ExpandableChart';
import { useMsFunnel, useMsReturns, useMsSummary, useMsTopProducts } from '@/api/queries';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartCardBody } from '@/components/chartWidget/ChartCardBody';
import { LineChart } from '@/components/LineChart';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { lttbDownsample } from '@/lib/downsample';
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
  // «Всё» (0) бэк со слайса 4 считает честно: полный диапазон от старейшего заказа архива
  // (страничная добивка отчёта + кэш 1 час) — подмена 0→30 больше не нужна.
  const top = useMsTopProducts(days);
  const funnel = useMsFunnel(days);
  const returns = useMsReturns(days);

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
  // Канон графиков: длинные серии (окно «Всё» после лет архива ms_daily) даунсэмплятся до ~140
  // точек ПЕРЕД рендером — как в Charts/MsClients; labels/titles строятся из той же выборки,
  // чтобы тултипы совпадали с точками. Оконные 7/30/90 короче порога и проходят как есть.
  const revSeries = lttbDownsample(revenue.series, 140, (p) => p.value);
  const ordSeries = lttbDownsample(orders.series, 140, (p) => p.count);
  const revLabels = revSeries.map((p) => fmt.day(p.day));
  const revValues = revSeries.map((p) => p.value);
  const ordLabels = ordSeries.map((p) => fmt.day(p.day));
  const ordValues = ordSeries.map((p) => p.count);
  // Средний чек по дням = сумма/число заказов дня; день без заказов — ЧЕСТНЫЙ null-разрыв
  // (деление на ноль дало бы «ноль-которого-не-было» — канон разрывов).
  const avgValues = ordSeries.map((p) => (p.count > 0 ? p.sum / p.count : null));
  const avgTotal = orders.totalCount > 0 ? orders.totalSum / orders.totalCount : null;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
      <ChartWidget id="ms-revenue" title="Выручка" fixedSize="half">
        <ChartCardBody value={`${fmt.short(revenue.total)} ₽`} caption={windowLabel}>
          {revValues.length > 1 ? (
            <LineChart
              values={revValues}
              labels={revLabels}
              titles={revSeries.map((p) => `${fmt.day(p.day)}: ${fmt.num(p.value)} ₽`)}
              yMin={0}
            />
          ) : (
            <p className="text-xs text-muted-foreground">Недостаточно дней для графика.</p>
          )}
        </ChartCardBody>
      </ChartWidget>

      <ChartWidget id="ms-orders" title="Заказы" fixedSize="half">
        <ChartCardBody
          value={fmt.num(orders.totalCount)}
          caption={`на ${fmt.short(orders.totalSum)} ₽ ${windowLabel}`}
        >
          {ordValues.length > 1 ? (
            <LineChart
              values={ordValues}
              labels={ordLabels}
              titles={ordSeries.map((p) => `${fmt.day(p.day)}: ${fmt.num(p.count)} · ${fmt.num(p.sum)} ₽`)}
              yMin={0}
            />
          ) : (
            <p className="text-xs text-muted-foreground">Недостаточно дней для графика.</p>
          )}
        </ChartCardBody>
      </ChartWidget>

      <ChartWidget id="ms-avg-check" title="Средний чек" fixedSize="half">
        <ChartCardBody value={avgTotal != null ? `${fmt.short(avgTotal)} ₽` : '—'} caption={windowLabel}>
          {avgValues.filter((v) => v != null).length > 1 ? (
            <LineChart
              values={avgValues}
              labels={ordLabels}
              titles={ordSeries.map((p) => (p.count > 0 ? `${fmt.day(p.day)}: ${fmt.num(Math.round(p.sum / p.count))} ₽` : `${fmt.day(p.day)}: заказов не было`))}
              yMin={0}
            />
          ) : (
            <p className="text-xs text-muted-foreground">Недостаточно дней с заказами для графика.</p>
          )}
        </ChartCardBody>
      </ChartWidget>

      <ChartWidget id="ms-funnel" title="Воронка статусов" fixedSize="half">
        {funnel.isPending ? (
          <div className="space-y-2 py-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={`f${i}`} className="h-6 w-full" />
            ))}
          </div>
        ) : funnel.isError || !funnel.data ? (
          <p className="py-4 text-sm text-muted-foreground">Не удалось получить статусы заказов.</p>
        ) : funnel.data.rows.length === 0 ? (
          funnel.data.no_state_orders > 0 ? (
            // Заказы есть, а статусов нет: state_id появился в слайсе 3 — старые строки заполнит
            // повторная загрузка истории (идемпотентная), честно ведём туда.
            <p className="py-4 text-xs text-muted-foreground">
              У загруженных заказов ещё нет статусов — запустите{' '}
              <Link className="text-primary underline-offset-2 hover:underline" to="/connect">
                загрузку истории
              </Link>{' '}
              повторно, и воронка заполнится.
            </p>
          ) : (
            <p className="py-4 text-sm text-muted-foreground">Нет заказов за период.</p>
          )
        ) : (
          <MsFunnelRows
            rows={funnel.data.rows}
            totalOrders={funnel.data.total_orders}
            noState={funnel.data.no_state_orders}
          />
        )}
      </ChartWidget>

      <ChartWidget id="ms-top-products" title="Топ товаров по выручке" fixedSize="half">
        {top.isPending ? (
          <div className="space-y-2 py-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={`t${i}`} className="h-6 w-full" />
            ))}
          </div>
        ) : top.isError || !top.data || top.data.rows.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">Нет продаж за период.</p>
        ) : (
          <MsTopProductsList rows={top.data.rows} />
        )}
      </ChartWidget>

      <ChartWidget id="ms-returns" title="Возвраты" fixedSize="half">
        {returns.isPending ? (
          <div className="space-y-2 py-2">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-4 w-1/2" />
          </div>
        ) : returns.isError || !returns.data ? (
          <p className="py-4 text-sm text-muted-foreground">Не удалось получить возвраты.</p>
        ) : (
          <ChartCardBody
            value={fmt.num(returns.data.count)}
            caption={`на ${fmt.short(returns.data.sum)} ₽ ${windowLabel}`}
          >
            <div className="space-y-1.5 text-2xs text-muted-foreground">
              {/* Живое чтение salesreturn с cap по страницам: упёрлись — честное «не менее». */}
              {returns.data.truncated && <p>Показано не менее — возвратов за период больше лимита выборки.</p>}
              <p>Возвраты считаются отдельно и из выручки не вычитаются.</p>
            </div>
          </ChartCardBody>
        )}
      </ChartWidget>
    </div>
  );
}

/** Список топ-товаров. Half-тайл фиксированной высоты вмещает 5 строк без внутреннего скролла
    (канон плотности); РАЗВОРОТ карточки (ChartExpandedContext — тот же паттерн, что Breakdown)
    показывает полный состав ответа. */
function MsTopProductsList({
  rows,
}: {
  rows: Array<{ name: string; quantity: number; revenue: number; profit: number }>;
}) {
  const expanded = useContext(ChartExpandedContext);
  const shown = expanded ? rows : rows.slice(0, 5);
  return (
    <ul>
      {shown.map((row, i) => (
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
  );
}

/** Строки воронки: топ-5 статусов окна барами в акценте графиков + сводный хвост; разворот
    карточки показывает ВСЕ статусы. Цвета статусов из МС сознательно НЕ красим в бары (пёстрый
    набор пользовательских цветов кричал бы против канона тихих карточек) — цвет живёт
    точкой-меткой у имени. */
function MsFunnelRows({
  rows,
  totalOrders,
  noState,
}: {
  rows: Array<{ state_id: string; name: string | null; color: string | null; orders: number; sum: number }>;
  totalOrders: number;
  noState: number;
}) {
  const expanded = useContext(ChartExpandedContext);
  const top = expanded ? rows : rows.slice(0, 5);
  const restOrders = (expanded ? [] : rows.slice(5)).reduce((acc, r) => acc + r.orders, 0) + noState;
  const max = top[0]?.orders ?? 1;
  return (
    <div className="space-y-2 pt-1">
      {top.map((r) => (
        <div key={r.state_id}>
          <div className="flex items-baseline justify-between gap-3 text-xs">
            <span className="flex min-w-0 items-center gap-1.5 text-foreground">
              {r.color && (
                <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: r.color }} />
              )}
              <span className="truncate">{r.name ?? 'Статус без имени'}</span>
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              <span className="font-medium text-foreground">{fmt.num(r.orders)}</span> · {fmt.short(r.sum)} ₽
            </span>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(4, Math.round((r.orders / max) * 100))}%`,
                backgroundColor: 'hsl(var(--chart-role-primary) / 0.75)',
              }}
            />
          </div>
        </div>
      ))}
      {restOrders > 0 && (
        <p className="text-2xs text-muted-foreground">
          Ещё {fmt.num(restOrders)} {noState > 0 ? `заказов (из них без статуса ${fmt.num(noState)})` : 'заказов'} из{' '}
          {fmt.num(totalOrders)}.
        </p>
      )}
    </div>
  );
}
