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
import { useSelectedChannel } from '@/lib/channel-context';
import { useSavedFilter } from '@/lib/widgetPrefsStore';
import {
  CDEK_CANON_STATUSES,
  cdekChannelFilterKey,
  cdekStatusFilterKey,
  cdekStatusInclude,
  normalizeCdekChannels,
  normalizeCdekStatuses,
} from '@/panels/cdek/cdekStatusFilter';
import { CHART_MAX_POINTS, lttbDownsample } from '@/lib/downsample';
import { densifyCdekDays } from '@/lib/cdekSeries';
import { fmt, timeAxisFromDayKeys } from '@/lib/format';
import { formatByRole, formatMoney } from '@/lib/metricNumber';
import { useCardShowsPeriod, usePagePeriod } from '@/lib/period';
import { useMsPagePeriod } from '@/lib/msPeriod';
import { cn } from '@/lib/utils';
import { WidgetGrid } from '@/components/widgets/WidgetGrid';

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

/** Роль `exact` — этот rub идёт в таблицы и подписи графиков. Крупное число карточки ниже
 *  печатает formatMoney без аргумента (роль headline, сжатие от 10 000). */
const rub = (n: number) => formatMoney(n, 'exact');

const titleOf = (row: CdekBreakdownRow) => row.title || row.sku || row.article || row.key || 'Без названия';

export function CdekProducts() {
  const pp = usePagePeriod();
  const days = pp ? pp.days : 30;
  const period = useMsPagePeriod();
  const windowLabel = pp?.range ? 'за выбранный период' : days === 0 ? 'за всё время' : `за ${days} дн.`;
  const periodInLabel = useCardShowsPeriod() ? windowLabel : undefined;

  // СОХРАНЁННЫЙ ВЫБОР ДЕЙСТВУЕТ и здесь. Страница ходила мимо него совсем: соседние экраны одного
  // источника отвечали на разные вопросы — «Обзор» считал отгруженное по выбранным каналам, а
  // «Товары» весь оборот целиком, и числа не сходились без единой подсказки почему.
  const { channelId } = useSelectedChannel();
  const savedStatusRaw = useSavedFilter(cdekStatusFilterKey(channelId));
  const savedStatuses = useMemo(() => normalizeCdekStatuses(savedStatusRaw), [savedStatusRaw]);
  const include = cdekStatusInclude(savedStatuses.length > 0 ? savedStatuses : CDEK_CANON_STATUSES);
  const savedChannelsRaw = useSavedFilter(cdekChannelFilterKey(channelId));
  const salesChannels = useMemo(() => normalizeCdekChannels(savedChannelsRaw), [savedChannelsRaw]);

  // Фильтр ПО ТОВАРАМ не применяется НИГДЕ на этой странице — ни к списку, ни к её графикам.
  // Страница отвечает на вопрос «что у нас в ассортименте»: сузь её выбранными товарами, и она
  // покажет ровно их (тот же довод, по которому кольцо каналов не сужается каналами), а ABC —
  // «сколько первых товаров дают 80% выручки» — при трёх выбранных превратился бы в «три из трёх».
  // Графики считают тот же набор, что и список: страница целиком отвечает на один вопрос.
  const products = useCdekBreakdown(period, 'product', include, PRODUCT_LIMIT, undefined, salesChannels);
  const series = useCdekSeries(period, include, undefined, undefined, salesChannels);

  const rows = products.data?.rows ?? [];
  const totalRevenue = products.data?.total.revenue ?? 0;
  // Календарная сетка окна — та же, что на странице метрики (densifyCdekDays): сервер отдаёт
  // ТОЛЬКО дни с продажами, и без уплотнения ось врёт о расстояниях между датами, а карточка
  // показывает не ту форму, что разворот того же числа.
  const points = densifyCdekDays(series.data?.current ?? [], series.data?.window.from, series.data?.window.to, series.data?.grain);

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
    <WidgetGrid className="grid grid-cols-1 gap-6 lg:grid-cols-6">
      <ChartWidget id="cdek-abc" drillTo="/metrics/cdek-products" title={`Концентрация ассортимента ${periodInLabel ?? ''}`.trim()} fixedSize="full">
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
              columns={{ label: 'Товар', value: 'Выручка' }}
              ranked
              // Накопленный процент — то самое «первые пять дают 78%», ради чего разбор и нужен.
              cumulative
              compactRows={8}
            />
          </>
        )}
      </ChartWidget>

      <ChartWidget id="cdek-units" drillTo="/metrics/cdek-units" title="Штук продано" fixedSize="half">
        {series.isPending ? (
          <ChartSkeleton />
        ) : (
          <UnitsBody points={points} periodInLabel={periodInLabel} />
        )}
      </ChartWidget>

      <ChartWidget id="cdek-price" drillTo="/metrics/cdek-price" title="Средняя цена продажи" fixedSize="half">
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
    </WidgetGrid>
  );
}

function UnitsBody({
  points,
  periodInLabel,
}: {
  points: Array<{ day: string; items: number }>;
  periodInLabel?: string;
}) {
  const model = useMemo(
    () => lttbDownsample(points.map((p) => ({ day: p.day, value: p.items })), CHART_MAX_POINTS, (r) => r.value),
    [points],
  );
  const total = points.reduce((s, p) => s + p.items, 0);
  if (model.length <= 1) {
    return (
      <ChartCardBody value={formatByRole(total, 'headline')} caption={periodInLabel}>
        <EmptyState compact size="chart" title="Недостаточно дней для графика." />
      </ChartCardBody>
    );
  }
  const labels = model.map((r) => fmt.day(r.day));
  return (
    <ChartCardBody value={formatByRole(total, 'headline')} caption={periodInLabel}>
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
      <ChartCardBody value={formatMoney(avg)} caption={caption}>
        <EmptyState compact size="chart" title="Недостаточно дней для графика." />
      </ChartCardBody>
    );
  }
  const labels = model.map((r) => fmt.day(r.day));
  return (
    <ChartCardBody value={formatMoney(avg)} caption={caption}>
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
