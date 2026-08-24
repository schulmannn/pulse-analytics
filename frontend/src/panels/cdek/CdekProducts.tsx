import { useMemo } from 'react';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartCardBody } from '@/components/chartWidget/ChartCardBody';
import { ChartBand } from '@/components/ChartBand';
import { BarChart } from '@/components/BarChart';
import { Sparkline } from '@/components/Sparkline';
import { ShareRows } from '@/components/ShareRows';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { ChartSkeleton, TableSkeleton } from '@/components/ui/dataSkeleton';
import { useCdekBreakdown, useCdekSeries, type CdekBreakdownRow } from '@/api/cdek';
import { lttbDownsample } from '@/lib/downsample';
import { CHART_MAX_POINTS } from '@/lib/msSeries';
import { fmt, timeAxisFromDayKeys } from '@/lib/format';
import { useCardShowsPeriod, usePagePeriod } from '@/lib/period';
import { useMsPagePeriod } from '@/lib/msPeriod';
import { cn } from '@/lib/utils';

/**
 * «Товары» СДЭКа — ассортимент за окно.
 *
 * Главная находка данных склада: у 48 из 54 товаров цена продажи ПЛАВАЕТ (маркетплейсы режут
 * скидку), и средняя по окну это скрывает — «2 400 ₽» одинаково выглядит и у товара с
 * фиксированной ценой, и у товара, который продавался от 1 818 до 3 750. Поэтому таблица несёт
 * размах цены отдельными колонками, а не одну усреднённую цифру.
 */

// Ассортимент склада владельца — 54 позиции; сотня строк покрывает его с запасом и держит
// таблицу в пределах экрана без виртуализации.
const PRODUCT_LIMIT = 100;
// Порог концентрации АБВ-разбора: классические 80% выручки.
const ABC_SHARE = 0.8;

const rub = (n: number) => `${fmt.num(Math.round(n))} ₽`;

const titleOf = (row: CdekBreakdownRow) => row.title || row.sku || row.article || row.key || 'Без названия';

export function CdekProducts() {
  const pp = usePagePeriod();
  const days = pp ? pp.days : 30;
  const period = useMsPagePeriod();
  const windowLabel = pp?.range ? 'за выбранный период' : days === 0 ? 'за всё время' : `за ${days} дн.`;
  const periodInLabel = useCardShowsPeriod() ? windowLabel : undefined;

  const products = useCdekBreakdown(period, 'product', 'revenue', PRODUCT_LIMIT);
  const series = useCdekSeries(period);

  const rows = products.data?.rows ?? [];
  const totalRevenue = products.data?.total.revenue ?? 0;
  const points = series.data?.current ?? [];

  /** Сколько первых товаров дают 80% выручки — и правда ли ассортимент концентрирован. */
  const abc = useMemo(() => {
    let acc = 0;
    let count = 0;
    for (const row of rows) {
      if (acc >= totalRevenue * ABC_SHARE) break;
      acc += row.revenue ?? 0;
      count++;
    }
    return { count, total: products.data?.total.groups ?? rows.length };
  }, [rows, totalRevenue, products.data]);

  /** Сколько товаров продавались не по одной цене. Это и есть история скидок маркетплейсов. */
  const floating = useMemo(
    () => rows.filter((r) => r.price_min != null && r.price_max != null && r.price_max > r.price_min).length,
    [rows],
  );

  if (products.isError) {
    return (
      <ErrorState
        size="chart"
        title="Не удалось получить товары"
        onRetry={() => products.refetch()}
        retrying={products.isFetching}
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-6">
      <ChartWidget id="cdek-abc" title={`Концентрация ассортимента ${periodInLabel ?? ''}`.trim()} fixedSize="full">
        {products.isPending ? (
          <TableSkeleton rows={6} columns={3} />
        ) : rows.length === 0 ? (
          <EmptyState compact size="table" title="Нет продаж за период." />
        ) : (
          <>
            <p className="mb-3 text-sm text-muted-foreground">
              <b className="font-medium text-foreground">
                {fmt.num(abc.count)} из {fmt.num(abc.total)}
              </b>{' '}
              товаров дают 80% выручки.
            </p>
            <ShareRows
              rows={rows.map((r) => ({ key: r.key ?? 'none', label: titleOf(r), value: r.revenue ?? 0 }))}
              total={totalRevenue}
              format={rub}
              tailWord="рублей"
              // Накопленный процент — то самое «первые пять дают 78%», ради чего разбор и нужен.
              cumulative
              compactRows={8}
            />
          </>
        )}
      </ChartWidget>

      <ChartWidget id="cdek-units" title="Штук продано" fixedSize="half">
        {series.isPending ? (
          <ChartSkeleton />
        ) : (
          <UnitsBody points={points} periodInLabel={periodInLabel} grain={series.data?.grain} />
        )}
      </ChartWidget>

      <ChartWidget id="cdek-price" title="Средняя цена продажи" fixedSize="half">
        {series.isPending ? (
          <ChartSkeleton />
        ) : (
          <PriceBody points={points} periodInLabel={periodInLabel} floating={floating} total={rows.length} />
        )}
      </ChartWidget>

      <ChartWidget id="cdek-assortment" title={`Ассортимент ${periodInLabel ?? ''}`.trim()} fixedSize="full">
        {products.isPending ? (
          <TableSkeleton rows={8} columns={7} />
        ) : rows.length === 0 ? (
          <EmptyState compact size="table" title="Нет продаж за период." />
        ) : (
          <AssortmentTable rows={rows} total={totalRevenue} truncated={products.data?.truncated ?? false} />
        )}
      </ChartWidget>
    </div>
  );
}

function UnitsBody({
  points,
  periodInLabel,
  grain,
}: {
  points: Array<{ day: string; items: number }>;
  periodInLabel?: string;
  grain?: string;
}) {
  const model = useMemo(
    () => lttbDownsample(points.map((p) => ({ day: p.day, value: p.items })), CHART_MAX_POINTS, (r) => r.value),
    [points],
  );
  const total = points.reduce((s, p) => s + p.items, 0);
  const grainWord = grain === 'month' ? 'по месяцам' : grain === 'week' ? 'по неделям' : 'по дням';
  if (model.length <= 1) {
    return (
      <ChartCardBody hero value={fmt.num(total)} caption={periodInLabel}>
        <EmptyState compact size="chart" title="Недостаточно дней для графика." />
      </ChartCardBody>
    );
  }
  const labels = model.map((r) => fmt.day(r.day));
  return (
    <ChartCardBody hero value={fmt.num(total)} caption={[periodInLabel, grainWord].filter(Boolean).join(' · ')}>
      {/* Флекс-колонка обязательна: ChartBand объявлен `flex-1`, и без неё ограничивать его нечем —
          полоса растёт под контент, столбцы берут высоту всего тела, тайл переполняется (та же
          болезнь, что чинил #487 у «Заказов»). */}
      <div className="flex h-full min-h-0 flex-col">
        <ChartBand>
          <BarChart
            values={model.map((r) => r.value)}
            labels={labels}
            axisLabels={timeAxisFromDayKeys(model.map((r) => r.day))}
            titles={model.map((r, i) => `${labels[i]}: ${fmt.num(r.value)} шт`)}
            formatValue={(v) => `${fmt.num(Math.round(v))} шт`}
          />
        </ChartBand>
      </div>
    </ChartCardBody>
  );
}

function PriceBody({
  points,
  periodInLabel,
  floating,
  total,
}: {
  points: Array<{ day: string; revenue: number | null; items: number }>;
  periodInLabel?: string;
  floating: number;
  total: number;
}) {
  // Средняя цена дня — выручка, делённая на ШТУКИ, а не на заказы: в заказе бывает несколько
  // позиций, и деление на заказы дало бы средний чек, а не цену товара.
  const model = useMemo(
    () =>
      lttbDownsample(
        points.filter((p) => p.items > 0).map((p) => ({ day: p.day, value: (p.revenue ?? 0) / p.items })),
        CHART_MAX_POINTS,
        (r) => r.value,
      ),
    [points],
  );
  const revenue = points.reduce((s, p) => s + (p.revenue ?? 0), 0);
  const items = points.reduce((s, p) => s + p.items, 0);
  const avg = items > 0 ? revenue / items : null;
  const caption = [
    periodInLabel,
    floating > 0 ? `цена плавала у ${fmt.num(floating)} из ${fmt.num(total)} товаров` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');

  if (model.length <= 1) {
    return (
      <ChartCardBody hero value={avg != null ? rub(avg) : '—'} caption={caption}>
        <EmptyState compact size="chart" title="Недостаточно дней для графика." />
      </ChartCardBody>
    );
  }
  const labels = model.map((r) => fmt.day(r.day));
  return (
    <ChartCardBody hero value={avg != null ? rub(avg) : '—'} caption={caption}>
      <Sparkline
        values={model.map((r) => r.value)}
        labels={labels}
        axisLabels={timeAxisFromDayKeys(model.map((r) => r.day))}
        area
        strokeWidth={2}
        interactive
        caption=""
        formatValue={rub}
        className="h-full min-h-14 w-full"
      />
    </ChartCardBody>
  );
}

/** Таблица ассортимента. Размах цены — тремя колонками: усреднение прячет скидки маркетплейсов. */
function AssortmentTable({
  rows,
  total,
  truncated,
}: {
  rows: CdekBreakdownRow[];
  total: number;
  truncated: boolean;
}) {
  return (
    <div className="data-table-scroll">
      <table className="data-table data-table--compact">
        <thead>
          <tr>
            <th scope="col" className="text-left">Товар</th>
            <th scope="col" className="text-left">Артикул</th>
            <th scope="col" className="text-right">Штук</th>
            <th scope="col" className="text-right">Выручка</th>
            <th scope="col" className="text-right">Доля</th>
            <th scope="col" className="text-right">Цена: мин</th>
            <th scope="col" className="text-right">медиана</th>
            <th scope="col" className="text-right">макс</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const spread = row.price_min != null && row.price_max != null && row.price_max > row.price_min;
            return (
              <tr key={row.key ?? titleOf(row)}>
                <td className="max-w-[22rem] truncate" title={titleOf(row)}>{titleOf(row)}</td>
                <td className="whitespace-nowrap text-muted-foreground">{row.article || row.sku || '—'}</td>
                <td className="text-right tabular-nums">{fmt.num(row.items)}</td>
                <td className="text-right tabular-nums">{rub(row.revenue ?? 0)}</td>
                <td className="text-right tabular-nums text-muted-foreground">
                  {total > 0 ? `${(((row.revenue ?? 0) / total) * 100).toFixed(1)}%` : '—'}
                </td>
                {/* Границы размаха подсвечены только когда он ЕСТЬ: у товара с одной ценой три
                    одинаковых числа не должны выглядеть как находка. */}
                <td className={cn('text-right tabular-nums', spread ? 'text-foreground' : 'text-muted-foreground')}>
                  {row.price_min != null ? rub(row.price_min) : '—'}
                </td>
                <td className="text-right tabular-nums">{row.price_median != null ? rub(row.price_median) : '—'}</td>
                <td className={cn('text-right tabular-nums', spread ? 'text-foreground' : 'text-muted-foreground')}>
                  {row.price_max != null ? rub(row.price_max) : '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {truncated && (
        <p className="mt-2 text-2xs text-muted-foreground">
          Показаны первые {fmt.num(PRODUCT_LIMIT)} товаров по выручке — остальные свёрнуты.
        </p>
      )}
    </div>
  );
}
