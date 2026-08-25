import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { LineChart } from '@/components/LineChart';
import { BarChart } from '@/components/BarChart';
import { ShareRows } from '@/components/ShareRows';
import { SegmentedControl } from '@/components/SegmentedControl';
import { useSelectedChannel } from '@/lib/channel-context';
import { setSavedFilter, useSavedFilter } from '@/lib/widgetPrefsStore';
import {
  CDEK_CANON_STATUSES,
  CdekProductFilter,
  CdekStatusFilter,
  cdekProductFilterKey,
  cdekStatusFilterKey,
  cdekStatusInclude,
  normalizeCdekStatuses,
  normalizeCdekProducts,
  productFilterCaption,
  statusFilterCaption,
  toastStatusFilterSaved,
  type CdekProductOption,
} from '@/panels/cdek/cdekStatusFilter';
import { PeriodChips } from '@/components/PeriodChips';
import { SourceIdentity } from '@/components/SourceIdentity';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ComparisonDeltaRow,
  MetricBackLink,
  MetricColumns,
  MetricDescriptor,
  RailSection,
  WindowBarShell,
} from '@/components/metric/shared';
import { useCdekBreakdown, useCdekSeries, useCdekSummary, type CdekPoint } from '@/api/cdek';
import { lttbDownsample } from '@/lib/downsample';
import { useExplorerChartHeight } from '@/lib/useExplorerChartHeight';
import { fmt, timeAxisFromDayKeys } from '@/lib/format';
import { formatMoney } from '@/lib/metricNumber';
import { usePeriod } from '@/lib/period';
import { useMsResolvedPeriod } from '@/lib/msPeriod';
import { isCdekMetricKey } from '@/panels/cdek/cdekMetricKeys';

/**
 * Полностраничные метрики СДЭКа — `/metrics/cdek-*`.
 *
 * Разворот карточки обязан открывать ТО ЖЕ, что у остальных источников: назад-ссылку, тихую шапку
 * (имя метрики + источник + дескриптор), две колонки (график + rail «Сравнение») и тайм-бар окна
 * под графиком — как `/metrics/ms-*` и `/metrics/ym-*`. Пока у карточек СДЭКа не было `drillTo`,
 * «Развернуть» падал в инлайновый оверлей, и источник вёл себя не как соседние (жалоба владельца).
 *
 * Честность важнее паритета: полный Line/Bar + сравнение получают только НАСТОЯЩИЕ дневные ряды.
 * Разрезы (каналы/статусы/товары) — полный список без выдуманного графика: у них нет одной
 * канонической величины периода, и рисовать её значило бы придумать.
 */
export function CdekMetricPage({ metricKey }: { metricKey: string }) {
  if (!isCdekMetricKey(metricKey)) return null;
  const series = SERIES_DEFS[metricKey as SeriesKey];
  if (series) return <CdekSeriesPage def={series} />;
  const breakdown = BREAKDOWN_DEFS[metricKey as BreakdownKey];
  return breakdown ? <CdekBreakdownPage def={breakdown} /> : null;
}

export { isCdekMetricKey };

/** Страница метрики: rub идёт в тултипы и леджеры — роль `exact`. */
const rub = (n: number) => formatMoney(n, 'exact');

const CHANNEL_LABEL: Record<string, string> = {
  own: 'Своя доставка',
  wildberries: 'Wildberries',
  yandex_market: 'Яндекс.Маркет',
  ozon: 'Ozon',
  other: 'Другая служба',
};

const STATUS_LABEL: Record<string, string> = {
  complete: 'Завершён',
  delivery: 'В доставке',
  cancel: 'Отменён',
  return: 'Возврат',
};

/** Тихая шапка + две колонки, как у `/metrics/ms-*`. `back` меняется: товарные метрики
    возвращают на «Товары», продажи — на «Обзор». */
/**
 * Каркас страницы метрики СДЭКа.
 *
 * Фильтры живут в ПРАВОЙ колонке, а не над графиком. Раньше они стояли в основной колонке и
 * забирали её верх: провалившись в метрику, человек видел блок управления, а сам график уезжал
 * под сгиб (жалоба владельца со скриншотом). Rail для них — естественное место: он и так несёт
 * «чем это меряется» (сравнение), всегда на виду и не отнимает у графика ни пикселя высоты.
 */
function CdekMetricShell({
  term,
  descriptor,
  back,
  comparison,
  filters,
  children,
}: {
  term: string;
  descriptor?: string;
  back: { to: string; label: string };
  /** Блок управления выборкой. Живёт в rail'е — см. комментарий выше. */
  filters?: ReactNode;
  comparison?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-5">
      <MetricBackLink to={back.to}>{back.label}</MetricBackLink>

      <div>
        <h1 className="text-2xl font-medium tracking-tight text-foreground">{term}</h1>
        <SourceIdentity network="cdek" className="mt-1 max-w-full" />
        {descriptor && <MetricDescriptor>{descriptor}</MetricDescriptor>}
      </div>

      <MetricColumns
        rail={
          <>
            <RailSection title="Сравнение">
              {comparison ?? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  У этого разреза нет одной канонической величины периода — сравнение не рассчитывается.
                </p>
              )}
            </RailSection>
            {filters && <RailSection title="Фильтры">{filters}</RailSection>}
            <Link
              to={back.to}
              className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
            >
              Открыть раздел <span aria-hidden="true">→</span>
            </Link>
          </>
        }
      >
        {children}
      </MetricColumns>
    </div>
  );
}

const OVERVIEW_BACK = { to: '/cdek', label: 'СДЭК · Обзор' };
const PRODUCTS_BACK = { to: '/cdek/products', label: 'СДЭК · Товары' };

// ── Дневные ряды ─────────────────────────────────────────────────────────────────────────────

type SeriesKey = 'cdek-revenue' | 'cdek-orders' | 'cdek-aov' | 'cdek-units' | 'cdek-price';

interface SeriesDef {
  term: string;
  descriptor: string;
  back: { to: string; label: string };
  /** Величина точки ряда. Производные (средний чек, цена) считаются здесь, а не на сервере. */
  pick: (p: CdekPoint) => number | null;
  /** Итог окна из сводки — hero сравнения. */
  total: (t: { revenue: number | null; orders: number; items: number; avg_check: number | null }) => number | null;
  format: (n: number) => string;
  unit?: string;
}

const SERIES_DEFS: Record<SeriesKey, SeriesDef> = {
  'cdek-revenue': {
    term: 'Выручка',
    // Складские движения не входят НИКОГДА (это не продажи), а вот статусы заказов теперь
    // выбираются фильтром ниже — поэтому описание про них молчит: иначе оно противоречило бы
    // выбору прямо на том же экране.
    descriptor: 'Сумма проданного за окно. Складские движения в неё не входят.',
    back: OVERVIEW_BACK,
    pick: (p) => p.revenue ?? 0,
    total: (t) => t.revenue,
    format: rub,
  },
  'cdek-orders': {
    term: 'Заказы',
    descriptor: 'Число заказов за окно. Считается по номеру заказа, а не по строкам выгрузки.',
    back: OVERVIEW_BACK,
    pick: (p) => p.orders,
    total: (t) => t.orders,
    format: fmt.num,
  },
  'cdek-aov': {
    term: 'Средний чек',
    descriptor: 'Выручка, делённая на число заказов окна.',
    back: OVERVIEW_BACK,
    pick: (p) => (p.orders > 0 ? (p.revenue ?? 0) / p.orders : null),
    total: (t) => t.avg_check,
    format: rub,
  },
  'cdek-units': {
    term: 'Штук продано',
    descriptor: 'Число проданных единиц товара за окно.',
    back: PRODUCTS_BACK,
    pick: (p) => p.items,
    total: (t) => t.items,
    format: fmt.num,
  },
  'cdek-price': {
    term: 'Средняя цена продажи',
    // Деление на заказы дало бы средний чек — другую величину под тем же заголовком.
    descriptor: 'Выручка, делённая на число ШТУК (не на заказы — это был бы средний чек).',
    back: PRODUCTS_BACK,
    pick: (p) => (p.items > 0 ? (p.revenue ?? 0) / p.items : null),
    total: (t) => (t.items > 0 && t.revenue != null ? t.revenue / t.items : null),
    format: rub,
  },
};

function CdekSeriesPage({ def }: { def: SeriesDef }) {
  const chartH = useExplorerChartHeight();
  const { days, setDays, range, setRange } = usePeriod();
  const period = useMsResolvedPeriod({ days, range });
  const [kind, setKind] = useState<'line' | 'bar'>('line');
  const [cmp, setCmp] = useState<'off' | 'prev'>('prev');

  // Фильтр статусов живёт ТОЛЬКО здесь, внутри разворота (решение владельца). Карточка «Обзора»
  // остаётся на каноне и потому не имеет скрытого состояния: число на ней всегда значит одно и то
  // же. Сохранённый набор по той же причине не протекает на карточку — иначе она меняла бы
  // значение без единого видимого контрола.
  const { channelId } = useSelectedChannel();
  const filterKey = cdekStatusFilterKey(channelId);
  const savedRaw = useSavedFilter(filterKey);
  const saved = useMemo(() => normalizeCdekStatuses(savedRaw), [savedRaw]);
  const [selected, setSelected] = useState<string[] | null>(null);
  const statuses = selected ?? (saved.length > 0 ? saved : CDEK_CANON_STATUSES);
  const include = cdekStatusInclude(statuses);
  const caption = statusFilterCaption(statuses);

  // Товары — вторая ось того же вопроса «что считать». Список берётся из разбивки по товарам,
  // которая ФИЛЬТР ИГНОРИРУЕТ (иначе выбранное было бы единственным, что можно выбрать).
  const productKey = cdekProductFilterKey(channelId);
  const savedProductsRaw = useSavedFilter(productKey);
  const savedProducts = useMemo(() => normalizeCdekProducts(savedProductsRaw), [savedProductsRaw]);
  const [pickedProducts, setPickedProducts] = useState<string[] | null>(null);
  const products = pickedProducts ?? savedProducts;
  const catalogue = useCdekBreakdown(period, 'product', 'all', 200);
  const productOptions: CdekProductOption[] = useMemo(
    () => (catalogue.data?.rows ?? [])
      .filter((row): row is typeof row & { key: string } => typeof row.key === 'string' && row.key !== '')
      .map((row) => ({ id: row.key, name: row.title ?? row.article ?? row.key })),
    [catalogue.data?.rows],
  );
  const productCaption = productFilterCaption(products, productOptions);

  const series = useCdekSeries(period, include, undefined, products);
  const summary = useCdekSummary(period, include, products);

  if (series.isPending || summary.isPending) {
    return (
      <CdekMetricShell term={def.term} descriptor={def.descriptor} back={def.back}>
        <Skeleton className="h-[420px] w-full" />
      </CdekMetricShell>
    );
  }
  if (series.isError || summary.isError) {
    return (
      <CdekMetricShell term={def.term} descriptor={def.descriptor} back={def.back}>
        <ErrorState title="Не удалось получить данные СДЭКа" onRetry={() => series.refetch()} />
      </CdekMetricShell>
    );
  }

  const raw = (series.data?.current ?? []).map((p) => ({ day: p.day, value: def.pick(p) }));
  const shown = lttbDownsample(raw, 400, (r) => r.value ?? 0);
  const values = shown.map((r) => r.value);
  const labels = shown.map((r) => fmt.day(r.day));
  const axisLabels = timeAxisFromDayKeys(shown.map((r) => r.day));
  // Призрак прошлого окна выравнивается ПО ИНДЕКСУ: у равных окон одинаковая длина, а даты у них
  // разные — рисовать их по своим датам значило бы сдвинуть кривую.
  const prevRaw = (series.data?.previous ?? []).map((p) => def.pick(p) ?? 0);
  const compare = cmp === 'prev' && prevRaw.length > 1 ? prevRaw : undefined;

  const cur = summary.data?.current ? def.total(summary.data.current) : null;
  const prev = summary.data?.previous ? def.total(summary.data.previous) : null;
  const hasPrevWindow = summary.data?.previous_window != null;

  const comparison = (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-muted-foreground">Текущее окно</span>
        <span className="text-sm font-medium tabular-nums text-foreground">
          {cur != null ? def.format(cur) : '—'}
        </span>
      </div>
      {cur != null && prev != null && prev !== 0 && (
        <ComparisonDeltaRow delta={((cur - prev) / prev) * 100} evaluative />
      )}
      {hasPrevWindow ? (
        <p className="text-xs text-muted-foreground">
          Пред. окно: <span className="tabular-nums text-foreground">{prev != null ? def.format(prev) : '—'}</span>
        </p>
      ) : (
        // «Всё» сравнивать не с чем — выдуманная дельта была бы враньём.
        <p className="text-xs leading-relaxed text-muted-foreground">
          Для окна «Всё» предыдущего периода нет — сравнение не рассчитывается.
        </p>
      )}
    </div>
  );

  // Тот же блок, что раньше стоял над графиком, — теперь узел для rail'а. Подпись выбора едет
  // ВМЕСТЕ с фильтрами: она объясняет именно их состояние, а не график сам по себе.
  const filters = (
    <div className="space-y-3">
      <CdekStatusFilter
        selected={statuses}
        saved={saved}
        onChange={setSelected}
        onSave={(ids) => {
          setSavedFilter(filterKey, normalizeCdekStatuses(ids));
          toastStatusFilterSaved(ids);
        }}
      />
      <CdekProductFilter
        options={productOptions}
        selected={products}
        saved={savedProducts}
        onChange={setPickedProducts}
        onSave={(ids) => {
          setSavedFilter(productKey, normalizeCdekProducts(ids));
          toast(ids.length > 0 ? 'Фильтр товаров сохранён' : 'Фильтр товаров сброшен');
        }}
      />
      {(caption || productCaption) && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          {[caption, productCaption].filter(Boolean).join(' · ')}
        </p>
      )}
    </div>
  );

  return (
    <CdekMetricShell
      term={def.term}
      descriptor={def.descriptor}
      back={def.back}
      comparison={comparison}
      filters={filters}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-end gap-2">
          <SegmentedControl
            ariaLabel="Тип графика"
            size="sm"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'line', content: 'Линия' },
              { value: 'bar', content: 'Столбцы' },
            ]}
          />
          <SegmentedControl
            ariaLabel="База сравнения"
            size="sm"
            value={cmp}
            onChange={setCmp}
            options={[
              { value: 'off', content: 'Выкл' },
              // На окне «Всё» сравнивать не с чем — вариант гаснет, а не молча ничего не делает.
              { value: 'prev', content: 'Пред. период', disabled: !hasPrevWindow },
            ]}
          />
        </div>
        {values.length < 2 ? (
          <EmptyState compact size="chart" title="Недостаточно дней для графика за окно." />
        ) : kind === 'bar' ? (
          <BarChart
            values={values.map((v) => v ?? 0)}
            labels={labels}
            axisLabels={axisLabels}
            ghost={compare}
            ghostLabel="Пред. период"
            height={chartH}
            formatValue={def.format}
            titles={values.map((v, i) => `${labels[i]}: ${v != null ? def.format(v) : '—'}`)}
          />
        ) : (
          <LineChart
            values={values}
            labels={labels}
            axisLabels={axisLabels}
            ghost={compare}
            ghostLabel="Пред. период"
            height={chartH}
            formatValue={def.format}
          />
        )}
        <WindowBarShell>
          <PeriodChips ariaLabel="Окно" value={days} onChange={setDays} range={range} onRangeChange={setRange} />
        </WindowBarShell>
      </div>
    </CdekMetricShell>
  );
}

// ── Разрезы ──────────────────────────────────────────────────────────────────────────────────

type BreakdownKey = 'cdek-channels' | 'cdek-statuses' | 'cdek-products';

interface BreakdownDef {
  term: string;
  descriptor: string;
  back: { to: string; label: string };
  dim: string;
  dict: Record<string, string>;
  fallback: string;
  tailWord: string;
}

const BREAKDOWN_DEFS: Record<BreakdownKey, BreakdownDef> = {
  'cdek-channels': {
    term: 'Каналы продаж',
    descriptor: 'Служба доставки в выгрузке — это канал: у своей доставки есть трек-номер, у маркетплейсов только внешний номер заказа.',
    back: OVERVIEW_BACK,
    dim: 'channel',
    dict: CHANNEL_LABEL,
    fallback: 'Без канала',
    tailWord: 'рублей',
  },
  'cdek-statuses': {
    term: 'Статусы заказов',
    descriptor: 'Все заказы окна, включая отменённые и возвращённые — иначе разбивка показала бы лишь те статусы, которые сама и отобрала.',
    back: OVERVIEW_BACK,
    dim: 'status',
    dict: STATUS_LABEL,
    fallback: 'Без статуса',
    tailWord: 'рублей',
  },
  'cdek-products': {
    term: 'Товары',
    descriptor: 'Выручка по товарам за окно.',
    back: PRODUCTS_BACK,
    dim: 'product',
    dict: {},
    fallback: 'Без названия',
    tailWord: 'рублей',
  },
};

function CdekBreakdownPage({ def }: { def: BreakdownDef }) {
  const { days, setDays, range, setRange } = usePeriod();
  const period = useMsResolvedPeriod({ days, range });
  const [metric, setMetric] = useState<'revenue' | 'orders'>('revenue');
  // Полный список, а не топ карточки: на своей странице метрики обрезать нечего.
  const breakdown = useCdekBreakdown(period, def.dim, 'revenue', 100);

  const body = () => {
    if (breakdown.isPending) return <Skeleton className="h-[420px] w-full" />;
    if (breakdown.isError) {
      return <ErrorState title="Не удалось получить разрез" onRetry={() => breakdown.refetch()} />;
    }
    const rows = breakdown.data?.rows ?? [];
    if (!rows.length) return <EmptyState compact size="table" title="Нет продаж за окно." />;
    const total = metric === 'revenue' ? (breakdown.data?.total.revenue ?? 0) : (breakdown.data?.total.orders ?? 0);
    return (
      <ShareRows
        rows={rows.map((r) => ({
          key: r.key ?? 'none',
          label: r.title || (r.key == null ? def.fallback : (def.dict[r.key] ?? r.key)),
          value: metric === 'revenue' ? (r.revenue ?? 0) : r.orders,
        }))}
        total={total}
        format={metric === 'revenue' ? rub : fmt.num}
        tailWord={metric === 'revenue' ? def.tailWord : 'заказов'}
        expanded
        cumulative
      />
    );
  };

  return (
    <CdekMetricShell term={def.term} descriptor={def.descriptor} back={def.back}>
      <div className="space-y-3">
        <div className="flex justify-end">
          <SegmentedControl
            ariaLabel="Показатель разреза"
            size="sm"
            value={metric}
            onChange={setMetric}
            options={[
              { value: 'revenue', content: 'Выручка' },
              { value: 'orders', content: 'Заказы' },
            ]}
          />
        </div>
        {body()}
        <WindowBarShell>
          <PeriodChips ariaLabel="Окно" value={days} onChange={setDays} range={range} onRangeChange={setRange} />
        </WindowBarShell>
      </div>
    </CdekMetricShell>
  );
}
