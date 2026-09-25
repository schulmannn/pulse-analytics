import { useMemo, useState } from 'react';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartCardBody } from '@/components/chartWidget/ChartCardBody';
import { ChartBand } from '@/components/ChartBand';
import { ChartFill } from '@/components/ChartFill';
import { BarChart } from '@/components/BarChart';
import { Sparkline } from '@/components/Sparkline';
import { PieChart } from '@/components/PieChart';
import { RankChart } from '@/components/RankChart';
import { DivergingBars } from '@/components/DivergingBars';
import { ShareRows } from '@/components/ShareRows';
import { SegmentedControl } from '@/components/SegmentedControl';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { ChartSkeleton, TableSkeleton } from '@/components/ui/dataSkeleton';
import {
  useCdekBreakdown,
  useCdekSeries,
  useCdekSummary,
  type CdekBreakdown,
  type CdekBreakdownRow,
  type CdekPoint,
} from '@/api/cdek';
import { pctDelta, type MetricDelta } from '@/lib/delta';
import { CHART_MAX_POINTS, lttbDownsample } from '@/lib/downsample';
import { densifyCdekDays } from '@/lib/cdekSeries';
import { fmt, timeAxisFromDayKeys } from '@/lib/format';
import { useSelectedChannel } from '@/lib/channel-context';
import { useSavedFilter } from '@/lib/widgetPrefsStore';
import {
  CDEK_CANON_STATUSES,
  cdekChannelFilterKey,
  cdekProductFilterKey,
  cdekStatusFilterKey,
  cdekStatusInclude,
  normalizeCdekChannels,
  normalizeCdekProducts,
  normalizeCdekStatuses,
  cdekStatusLabel,
} from '@/panels/cdek/cdekStatusFilter';
import { formatByRole, formatMoney, moneyFormatterFor } from '@/lib/metricNumber';
import { useCardShowsPeriod, usePagePeriod } from '@/lib/period';
import { useMsPagePeriod } from '@/lib/msPeriod';
import { WidgetGrid } from '@/components/widgets/WidgetGrid';

/**
 * «Обзор» СДЭКа. Величины здесь СВОИ — рубли и заказы; с просмотрами TG и охватом IG они не
 * смешиваются и под одним названием не показываются (тот же канон, что у «МойСклада»).
 *
 * Состав карточек и типы графиков утверждены владельцем и выбраны не по вкусу, а по данным
 * настоящей годовой выгрузки:
 *   • Выручка — непрерывный денежный поток → line/area (переключатель на столбцы);
 *   • Заказы — дискретный счёт → bar (канон bar-дефолта счётных метрик);
 *   • Средний чек — уровень, а не поток → line; столбцы намекали бы, что чеки складываются;
 *   • Статусы — СТРОКАМИ, не кольцом: распределение 87.5 / 7.1 / 5.3 / 0.09%, и сектор в 0.09%
 *     нечитаем, а строки переносят перекос спокойно и показывают точные числа;
 *   • Каналы продаж — ЕДИНСТВЕННОЕ кольцо на весь источник: 48 / 32 / 18 / 1.5% — четыре доли
 *     одного целого, и вопрос «на кого мы завязаны» читается мгновенно;
 *   • Вклад в изменение — diverging: зелёный/красный здесь законны, это оценённое изменение;
 *   • Топ товаров — rank: 54 товара в кольцо не помещаются в принципе.
 */

/** Человеческие подписи каналов. Ключи нормализованы на сервере — витрина живёт здесь. */
const CHANNEL_LABEL: Record<string, string> = {
  own: 'Своя доставка',
  wildberries: 'Wildberries',
  yandex_market: 'Яндекс.Маркет',
  ozon: 'Ozon',
  other: 'Другая служба',
};

/** Тултипы/таблицы/подписи графиков — за цифрой идут именно сюда, поэтому роль `exact`.
 *  Крупное число карточки печатает formatMoney без аргумента (роль headline). */
const rub = (n: number) => formatMoney(n, 'exact');
const rubShort = (n: number) => fmt.kpi(Math.round(n));

/** Ключ разреза → подпись. Пустой ключ — отсутствие значения, а не категория с именем. */
const labelOf = (row: CdekBreakdownRow, label: (id: string) => string, fallback: string) => {
  if (row.title) return row.title;
  if (row.key == null) return fallback;
  return label(row.key);
};

/** Тело story-карточки: hero-число слева, ряд по дням справа. Один раз объявляет «Линия/Столбцы». */
function CdekStory({
  value,
  delta,
  caption,
  points,
  pick,
  formatValue,
  viz,
}: {
  value: string;
  delta: MetricDelta | null;
  caption?: string;
  points: CdekPoint[];
  pick: (p: CdekPoint) => number;
  formatValue: (n: number) => string;
  viz: 'line' | 'bar';
}) {
  const model = useMemo(() => {
    const raw = points.map((p) => ({ day: p.day, value: pick(p) }));
    // Длинный ряд даунсэмплится ПАРАМИ (день + значение): дели мы их порознь, подписи оси
    // разъехались бы со столбцами. Порог — общий CHART_MAX_POINTS, как у остальных графиков.
    const shown = lttbDownsample(raw, CHART_MAX_POINTS, (r) => r.value);
    return { values: shown.map((r) => r.value), days: shown.map((r) => r.day) };
  }, [points, pick]);

  if (model.values.length <= 1) {
    return (
      <ChartCardBody value={value} delta={delta} caption={caption}>
        <EmptyState compact size="chart" title="Недостаточно дней для графика." />
      </ChartCardBody>
    );
  }
  const labels = model.days.map((d) => fmt.day(d));
  const axisLabels = timeAxisFromDayKeys(model.days);
  const titles = model.values.map((v, i) => `${labels[i] ?? ''}: ${formatValue(v)}`);

  return (
    <ChartCardBody value={value} delta={delta} caption={caption}>
      {viz === 'bar' ? (
        // ChartBand — `flex-1`, и без флекс-КОЛОНКИ-родителя он не ограничен ничем: полоса растёт
        // под контент, столбцы берут высоту ВСЕГО тела карточки из контекста, и тайл переполняется
        // (гейт ловил «Заказы» на +19px). Колонка во всю высоту слота даёт полосе честный остаток.
        <div className="flex h-full min-h-0 flex-col">
          <ChartBand>
            <BarChart values={model.values} labels={labels} axisLabels={axisLabels} titles={titles} formatValue={formatValue} />
          </ChartBand>
        </div>
      ) : (
        <Sparkline
          values={model.values}
          labels={labels}
          axisLabels={axisLabels}
          area
          strokeWidth={2}
          interactive
          caption=""
          formatValue={formatValue}
          className="h-full min-h-14 w-full"
        />
      )}
    </ChartCardBody>
  );
}

export function CdekOverview() {
  const pp = usePagePeriod();
  const days = pp ? pp.days : 30;
  const period = useMsPagePeriod();
  const windowLabel = pp?.range ? 'за выбранный период' : days === 0 ? 'за всё время' : `за ${days} дн.`;
  // На ленте окно уже названо в шапке страницы — карточка его не повторяет (владелец).
  const periodInLabel = useCardShowsPeriod() ? windowLabel : undefined;

  // Сохранённый в развороте выбор ДЕЙСТВУЕТ и здесь (владелец: «чтобы эта настройка
  // распространилась на виджет в уменьшенном виде»). Раньше он намеренно не протекал — карточка
  // меняла бы значение без единого видимого контрола. Опасение снято не отменой правила, а
  // подписью: как только выбор уходит от канона, карточки ГОВОРЯТ, что именно посчитано
  // (filterCaption ниже). Число, которое молчит о своём наборе, — вот что было бы нечестно.
  const { channelId } = useSelectedChannel();
  const savedStatusRaw = useSavedFilter(cdekStatusFilterKey(channelId));
  const savedStatuses = useMemo(() => normalizeCdekStatuses(savedStatusRaw), [savedStatusRaw]);
  const include = cdekStatusInclude(savedStatuses.length > 0 ? savedStatuses : CDEK_CANON_STATUSES);
  const savedProductsRaw = useSavedFilter(cdekProductFilterKey(channelId));
  const pickedProducts = useMemo(() => normalizeCdekProducts(savedProductsRaw), [savedProductsRaw]);
  const savedChannelsRaw = useSavedFilter(cdekChannelFilterKey(channelId));
  const salesChannels = useMemo(() => normalizeCdekChannels(savedChannelsRaw), [savedChannelsRaw]);

  const summary = useCdekSummary(period, include, pickedProducts, salesChannels);
  const series = useCdekSeries(period, include, undefined, pickedProducts, salesChannels);
  // Кольцо каналов фильтр по каналам ИГНОРИРУЕТ: отфильтруй его выбранными — и оно покажет ровно
  // их, а вопрос «на кого мы завязаны» останется без ответа (сервер снимает фильтр сам, но ключ
  // кэша обязан это отражать, иначе один и тот же ответ лёг бы под разные ключи).
  const channels = useCdekBreakdown(period, 'channel', include, 12, pickedProducts);
  // Разбивка ПО СТАТУСАМ остаётся на 'all': отфильтруй её выбранными статусами — и она покажет
  // ровно то, что сама же отобрала. Фильтр товаров ей при этом осмыслен и применяется.
  const statuses = useCdekBreakdown(period, 'status', 'all', 12, pickedProducts, salesChannels);
  const products = useCdekBreakdown(period, 'product', include, 10, pickedProducts, salesChannels);

  const [channelMetric, setChannelMetric] = useState<'revenue' | 'orders'>('revenue');
  const [statusMetric, setStatusMetric] = useState<'orders' | 'revenue'>('orders');
  const [contribution, setContribution] = useState<'channel' | 'product'>('channel');

  const cur = summary.data?.current ?? null;
  const prev = summary.data?.previous ?? null;
  // Календарная сетка окна — та же, что на странице метрики (densifyCdekDays): сервер отдаёт
  // ТОЛЬКО дни с продажами, и без уплотнения ось врёт о расстояниях между датами, а карточка
  // показывает не ту форму, что разворот того же числа.
  const points = densifyCdekDays(series.data?.current ?? [], series.data?.window.from, series.data?.window.to, series.data?.grain);
  // Подпись ряда честно называет ЕДИНИЦУ корзины: на длинном окне это уже не дни.

  if (summary.isError) {
    return (
      <ErrorState
        size="chart"
        title="Не удалось получить данные СДЭКа"
        onRetry={() => summary.refetch()}
        retrying={summary.isFetching}
      />
    );
  }

  // Подпись выбора печатается ТОЛЬКО когда он ушёл от канона — иначе на каждой карточке висела бы
  // строка, ничего не сообщающая (владелец уже снимал такую однажды: «убирай эту подпись»).
  // Но если набор нестандартный, карточка обязана это сказать: иначе число значит не то, что
  // читатель думает, и узнать об этом неоткуда.
  // Приписка о сохранённом фильтре с карточек СНЯТА (владелец: «это лишнее»). Раньше карточка
  // обязана была назвать нестандартный набор, потому что узнать о нём было неоткуда; теперь выбор
  // виден в развороте — там он стоит карточками фильтров прямо над графиком.
  const storyCaption = (extra?: string) =>
    [periodInLabel, extra].filter(Boolean).join(' · ') || undefined;

  const revStory = {
    value: formatMoney(cur?.revenue),
    delta: pctDelta(cur?.revenue, prev?.revenue),
    // Что именно считается выручкой, объясняет «О метрике» и разворот, где этим можно управлять;
    // на лице карточки постоянная приписка про отмены была шумом в каждом кадре (владелец).
    caption: storyCaption(),
    points,
    pick: (p: CdekPoint) => p.revenue ?? 0,
    formatValue: rub,
  };

  return (
    <WidgetGrid className="grid grid-cols-1 gap-6 lg:grid-cols-6">
      {series.isPending || summary.isPending ? (
        <ChartWidget id="cdek-revenue" drillTo="/metrics/cdek-revenue" title="Выручка" fixedSize="half" defaultColor={1} defaultTinted>
          <ChartSkeleton />
        </ChartWidget>
      ) : (
        <ChartWidget
          id="cdek-revenue"
          drillTo="/metrics/cdek-revenue"
          title="Выручка"
          fixedSize="half"
          defaultColor={1}
          defaultTinted
          variants={[
            { key: 'line', label: 'Линия', render: <CdekStory {...revStory} viz="line" /> },
            { key: 'bar', label: 'Столбцы', render: <CdekStory {...revStory} viz="bar" /> },
          ]}
        />
      )}

      <ChartWidget id="cdek-orders" drillTo="/metrics/cdek-orders" title="Заказы" fixedSize="half">
        {series.isPending || summary.isPending ? (
          <ChartSkeleton />
        ) : (
          <CdekStory
            value={formatByRole(cur?.orders ?? 0, 'headline')}
            delta={pctDelta(cur?.orders, prev?.orders)}
            caption={storyCaption()}
            points={points}
            pick={(p) => p.orders}
            formatValue={(v) => fmt.num(Math.round(v))}
            viz="bar"
          />
        )}
      </ChartWidget>

      <ChartWidget id="cdek-aov" drillTo="/metrics/cdek-aov" title="Средний чек" fixedSize="half">
        {series.isPending || summary.isPending ? (
          <ChartSkeleton />
        ) : (
          <CdekStory
            value={formatMoney(cur?.avg_check)}
            delta={pctDelta(cur?.avg_check, prev?.avg_check)}
            caption={storyCaption()}
            points={points}
            pick={(p) => (p.orders > 0 ? (p.revenue ?? 0) / p.orders : 0)}
            formatValue={rub}
            viz="line"
          />
        )}
      </ChartWidget>

      <ChartWidget id="cdek-statuses" drillTo="/metrics/cdek-statuses" title="Статусы заказов" fixedSize="half">
        <div className="flex h-full min-h-0 flex-col">
          <div className="mb-1 flex shrink-0 justify-end">
            <SegmentedControl
              ariaLabel="Показатель распределения заказов по статусам"
              size="sm"
              value={statusMetric}
              onChange={setStatusMetric}
              options={[
                { value: 'orders', content: 'Заказы' },
                { value: 'revenue', content: 'Выручка' },
              ]}
            />
          </div>
          <ChartFill>
        {statuses.isPending ? (
          <TableSkeleton rows={4} columns={3} className="py-2" />
        ) : statuses.isError ? (
          <ErrorState compact size="table" title="Не удалось получить статусы" onRetry={() => statuses.refetch()} />
        ) : !statuses.data || statuses.data.rows.length === 0 ? (
          <EmptyState compact size="table" title="Нет заказов за период." />
        ) : (
          <ShareRows
            rows={statuses.data.rows.map((r) => ({
              key: r.key ?? 'none',
              label: labelOf(r, cdekStatusLabel, 'Без статуса'),
              value: statusMetric === 'orders' ? r.orders : (r.revenue ?? 0),
            }))}
            total={statusMetric === 'orders' ? statuses.data.total.orders : statuses.data.total.revenue}
            format={statusMetric === 'orders' ? fmt.num : rub}
            tailWord={statusMetric === 'orders' ? 'заказов' : 'рублей'}
            columns={{ label: 'Статус', value: statusMetric === 'orders' ? 'Заказы' : 'Выручка' }}
          />
        )}
          </ChartFill>
        </div>
      </ChartWidget>

      <ChartWidget id="cdek-channels" drillTo="/metrics/cdek-channels" title="Каналы продаж" fixedSize="half">
        {/* Флекс-колонка во всю высоту тела: переключатель занимает СВОЁ, а кольцо меряет остаток
            через ChartFill. Без этого PieChart берёт высоту ВСЕГО тела из контекста, рисует себя
            во всю её величину — и тайл переполняется ровно на высоту переключателя (кольцо на
            проде обрезалось снизу). */}
        <div className="flex h-full min-h-0 flex-col">
          <div className="mb-1 flex shrink-0 justify-end">
            <SegmentedControl
              ariaLabel="Показатель каналов продаж"
              size="sm"
              value={channelMetric}
              onChange={setChannelMetric}
              options={[
                { value: 'revenue', content: 'Выручка' },
                { value: 'orders', content: 'Заказы' },
              ]}
            />
          </div>
          <ChartFill>
            {channels.isPending ? (
              <ChartSkeleton />
            ) : channels.isError ? (
              <ErrorState compact size="chart" title="Не удалось получить каналы" onRetry={() => channels.refetch()} />
            ) : !channels.data || channels.data.rows.length === 0 ? (
              <EmptyState compact size="chart" title="Нет продаж за период." />
            ) : (
              <ChannelDonut data={channels.data} metric={channelMetric} />
            )}
          </ChartFill>
        </div>
      </ChartWidget>

      <ChartWidget id="cdek-products" drillTo="/metrics/cdek-products" title={`Топ товаров ${periodInLabel ?? ''}`.trim()} fixedSize="half">
        {products.isPending ? (
          <ChartSkeleton />
        ) : products.isError ? (
          <ErrorState compact size="chart" title="Не удалось получить товары" onRetry={() => products.refetch()} />
        ) : !products.data || products.data.rows.length === 0 ? (
          <EmptyState compact size="chart" title="Нет продаж за период." />
        ) : (
          <RankChart
            items={products.data.rows.map((r) => ({
              label: labelOf(r, (id: string) => id, 'Без названия'),
              value: r.revenue ?? 0,
              compare: summary.data?.previous_window ? r.prev_revenue : null,
            }))}
            valueFmt={rubShort}
            compareLabel={summary.data?.previous_window ? 'Прошлое окно' : null}
          />
        )}
      </ChartWidget>

      <ChartWidget id="cdek-contribution" title="Что изменило выручку" fixedSize="full">
        <div className="mb-1 flex justify-end">
          <SegmentedControl
            ariaLabel="Разрез вклада в изменение выручки"
            size="sm"
            value={contribution}
            onChange={setContribution}
            options={[
              { value: 'channel', content: 'Каналы' },
              { value: 'product', content: 'Товары' },
            ]}
          />
        </div>
        <Contribution
          data={contribution === 'channel' ? channels.data : products.data}
          pending={contribution === 'channel' ? channels.isPending : products.isPending}
          hasPrevious={!!summary.data?.previous_window}
          dict={contribution === 'channel' ? (id: string) => CHANNEL_LABEL[id] ?? id : (id: string) => id}
          fallback={contribution === 'channel' ? 'Без канала' : 'Без названия'}
        />
      </ChartWidget>
    </WidgetGrid>
  );
}

/** Кольцо каналов продаж — единственная круговая на весь источник. */
function ChannelDonut({
  data,
  metric,
}: {
  data: CdekBreakdown;
  metric: 'revenue' | 'orders';
}) {
  const value = (r: CdekBreakdownRow) => (metric === 'revenue' ? (r.revenue ?? 0) : r.orders);
  const total = metric === 'revenue' ? data.total.revenue : data.total.orders;
  const format = metric === 'revenue' ? rub : fmt.num;
  const rows = data.rows.filter((r) => value(r) > 0);
  const labels = rows.map((r) => labelOf(r, (id: string) => CHANNEL_LABEL[id] ?? id, 'Без канала'));
  const values = rows.map(value);
  return (
    <PieChart
      values={values}
      labels={labels}
      titles={values.map((v, i) => `${labels[i]}: ${format(v)}`)}
      // Доли считаются от ПОЛНОГО итога разреза, а не от видимых секторов: иначе список и кольцо
      // показали бы разные проценты одного и того же.
      shares={total > 0 ? values.map((v) => v / total) : undefined}
    />
  );
}

/** Вклад в изменение выручки: кто добавил рублей, а кто отнял, против прошлого окна. */
function Contribution({
  data,
  pending,
  hasPrevious,
  dict,
  fallback,
}: {
  data: CdekBreakdown | undefined;
  pending: boolean;
  hasPrevious: boolean;
  /** Подпись ключа — функция, а не копия словаря (канон живёт в cdekStatusFilter). */
  dict: (id: string) => string;
  fallback: string;
}) {
  if (pending) return <ChartSkeleton />;
  if (!hasPrevious) {
    // «Всё» сравнивать не с чем — честная заглушка вместо выдуманной дельты.
    return <EmptyState compact size="chart" title="За «всё время» сравнивать не с чем — выберите окно." />;
  }
  if (!data || data.rows.length === 0) return <EmptyState compact size="chart" title="Нет продаж за период." />;

  const deltas = data.rows
    .map((r) => ({ label: labelOf(r, dict, fallback), delta: (r.revenue ?? 0) - (r.prev_revenue ?? 0) }))
    .filter((d) => Math.abs(d.delta) >= 1)
    .sort((a, b) => b.delta - a.delta);

  if (!deltas.length) return <EmptyState compact size="chart" title="Против прошлого окна ничего не изменилось." />;

  // Регистр числа выбирается ОДИН на весь график — по наибольшему вкладу, а не по каждому столбцу
  // отдельно (см. moneyFormatterFor).
  const contribValue = moneyFormatterFor(deltas.map((d) => d.delta));

  return (
    <ChartBand>
      <DivergingBars
        axis="category"
        values={deltas.map((d) => d.delta)}
        labels={deltas.map((d) => d.label)}
        valueLabels={deltas.map((d) => `${d.delta > 0 ? '+' : '−'}${contribValue(Math.abs(d.delta))}`)}
        titles={deltas.map((d) => `${d.label}: ${d.delta > 0 ? '+' : '−'}${rub(Math.abs(d.delta))}`)}
      />
    </ChartBand>
  );
}
