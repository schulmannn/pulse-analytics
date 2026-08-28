import { useMemo, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { MultiLineChart } from '@/components/MultiLineChart';
import {
  CdekFilterAdd,
  CdekFilterList,
  CDEK_MAX_SERIES,
  CompareGlyph,
  FilterGlyph,
  CdekChartKind,
  CdekSplitAdd,
  CdekSplitRow,
  CdekTargetAdd,
  CdekTargetRow,
  SplitGlyph,
  TargetGlyph,
  useCdekFilterDims,
} from '@/panels/cdek/CdekFilterRail';
import { LineChart } from '@/components/LineChart';
import { ChartExpandedContext, WidgetTargetContext } from '@/components/ExpandableChart';
import { BarChart } from '@/components/BarChart';
import { ShareRows } from '@/components/ShareRows';
import { SegmentedControl } from '@/components/SegmentedControl';
import { useSelectedChannel } from '@/lib/channel-context';
import { setPrefs, setSavedFilter, useSavedFilter, useWidgetPrefs } from '@/lib/widgetPrefsStore';
import { setMetricRailHidden, useMetricRailHidden } from '@/lib/metricRail';
import {
  CDEK_CANON_STATUSES,
  cdekChannelFilterKey,
  cdekProductFilterKey,
  cdekStatusFilterKey,
  cdekStatusInclude,
  normalizeCdekStatuses,
  normalizeCdekProducts,
  normalizeCdekChannels as normChannels,
  sameCdekChannels,
  sameCdekProducts,
  sameCdekStatuses,
  toastStatusFilterSaved,
  type CdekProductOption,
} from '@/panels/cdek/cdekStatusFilter';
import { PeriodChips } from '@/components/PeriodChips';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import {
  ComparisonDeltaRow,
  MetricBackLink,
  MetricColumns,
  RailSection,
  WindowBarShell,
} from '@/components/metric/shared';
import { useCdekBreakdown, useCdekSeries, useCdekSummary, type CdekPoint } from '@/api/cdek';
import { lttbDownsample } from '@/lib/downsample';
import { densifyCdekDays } from '@/lib/cdekSeries';
import { useExplorerChartHeight } from '@/lib/useExplorerChartHeight';
import { fmt, pluralRu, timeAxisFromDayKeys } from '@/lib/format';
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
  if (series) return <CdekSeriesPage def={series} metricKey={metricKey as SeriesKey} />;
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
  back,
  comparison,
  filters,
  view,
  split,
  splitAction,
  target,
  targetAction,
  filterIcon,
  filterAction,
  onSaveFilters,
  children,
}: {
  term: string;
  back: { to: string; label: string };
  /** Блок управления выборкой. Живёт в rail'е — см. комментарий выше. */
  filters?: ReactNode;
  /** Раздел «Вид» — чем рисуем полотно. */
  view?: ReactNode;
  /** Раздел «Разбивка» — по какому разрезу раскладываем ряд, и «+» выбора у правого края строки. */
  split?: ReactNode;
  splitAction?: ReactNode;
  /** Раздел «Цели» — уровень, до которого сверяемся, и «+» у правого края строки. */
  target?: ReactNode;
  targetAction?: ReactNode;
  /** Значок раздела фильтров и действие «+» у правого края его строки. */
  filterIcon?: ReactNode;
  filterAction?: ReactNode;
  /** Задан — выбор отличается от сохранённого, и в шапке появляется «Сохранить». */
  onSaveFilters?: () => void;
  comparison?: ReactNode;
  children: ReactNode;
}) {
  const railHidden = useMetricRailHidden();
  return (
    <div className="space-y-4">
      {/* Возврат и кнопки страницы — ОДНОЙ строкой, и колонка начинается сразу под ней. Раньше
          крошка и заголовок занимали две полосы во всю ширину, и правая колонка стартовала только
          под ними: справа сверху зияла пустая полоса высотой в заголовок (владелец: «подтянем
          чуть выше, а то сейчас там пустое пространство»). Заголовок метрики уехал в ЛЕВУЮ
          колонку — он относится к полотну, а не к фильтрам. */}
      <div className="flex items-center justify-between gap-4">
        <MetricBackLink to={back.to}>{back.label}</MetricBackLink>

      {/* Ни строки источника, ни дескриптора: «СДЭК · Склад» уже стоит в сайдбаре над навигацией,
          а «Сумма проданного за окно» повторяет заголовок (владелец: «не несут инфы»). */}
      {/* «Сохранить» — В ШАПКЕ СПРАВА и КОНТРАСТНАЯ. Место внизу колонки владелец не увидел
          («сейчас её не видно»): при его высоте окна она уходила под сгиб. Здесь она на одной
          линии с названием метрики — то есть в первом же экране, — а инверсный цвет отличает её
          от синих ссылок канона. Появляется только когда есть что сохранять. */}
        <span className="flex shrink-0 items-center gap-2">
          {onSaveFilters && (
            <Button type="button" variant="contrast" size="sm" onClick={onSaveFilters}>
              Сохранить
            </Button>
          )}
          {/* Свернуть колонку — значок «панель справа», как у Steep (замер: 32×32 у правого края
              шапки). Когда смотришь на график, фильтры и цели уже выбраны: колонка держит 300px,
              которых полотну не хватает. Выбор ЗАПОМИНАЕТСЯ (см. metricRail): развернув полотно
              на выручке, человек хочет широкое полотно и на заказах. */}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-pressed={railHidden}
            aria-label={railHidden ? 'Показать фильтры' : 'Скрыть фильтры'}
            title={railHidden ? 'Показать фильтры' : 'Скрыть фильтры'}
            onClick={() => setMetricRailHidden(!railHidden)}
          >
            <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
              <rect x="1.15" y="2.15" width="13.7" height="11.7" rx="2.2" />
              <path d="M9.9 2.6v10.8" />
              {!railHidden && <rect x="9.9" y="2.6" width="4.5" height="10.8" fill="currentColor" stroke="none" opacity="0.35" />}
            </svg>
          </Button>
        </span>
      </div>

      <MetricColumns
        railHidden={railHidden}
        rail={
          <>
            {/* Разделы идут ВПЛОТНУЮ, одной сплошной колонкой: их разделяет волосяная черта, а
                не воздух. `MetricColumns` расставляет детям rail'а 24px, и с ними колонка
                распадалась на четыре плавающих островка — у Steep это единый список, где линия и
                есть граница раздела. Обёртка забирает промежуток себе. */}
            <div>
              {/* Тип графика — первым, ДО разделов и без заголовка: у Steep это ряд иконок в самом
                  верху колонки. Раньше он стоял предпоследней секцией «Вид» (владелец: «должен
                  быть в самом начале»). */}
              <div className="border-b border-border px-2.5 pb-3">{view}</div>
            {/* Порядок — как у Steep: сначала «из чего сложилось» и «что считаем», и только потом
                «с чем сравниваем» и «чем рисуем». У нас он был буквально перевёрнут: сравнение
                стояло первым, фильтры последними (замечено владельцем по кадру). */}
              {(split || splitAction) && (
                // Только там, где разрез ЕСТЬ или его можно выбрать. На страницах-разрезов
                // («Каналы продаж», «Статусы») раскладывать нечего — раздел был бы строкой без
                // содержимого и без действия, тем же мёртвым контролом, что и пустые «Цели».
                <RailSection title="Разбивка" variant="row" icon={SplitGlyph} action={splitAction}>
                  {split}
                </RailSection>
              )}
              {filters && (
                <RailSection
                  title="Фильтры"
                  variant="row"
                  icon={filterIcon}
                  action={filterAction}
                >
                  {filters}
                </RailSection>
              )}
              {/* Порядок разделов — как у Steep: Breakdown · Filter · Targets · Compare. Цель
                  стоит ПОСЛЕ фильтров осознанно: сначала «что считаем», потом «с чем сверяемся». */}
              {(target || targetAction) && (
                // Только там, где цель ЕСТЬ или её можно поставить. На страницах-разрезах
                // («Статусы», «Каналы») уровня нет — раздел был бы строкой без содержимого и без
                // действия, то есть ровно тем мёртвым контролом, который мы отовсюду убираем.
                <RailSection title="Цели" variant="row" icon={TargetGlyph} action={targetAction}>
                  {target}
                </RailSection>
              )}
              <RailSection title="Сравнение" variant="row" icon={CompareGlyph}>
                {comparison ?? (
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    У этого разреза нет одной канонической величины периода — сравнение не
                    рассчитывается.
                  </p>
                )}
              </RailSection>
            </div>
          </>
        }
      >
        {/* Заголовок — в ЛЕВОЙ колонке, над полотном: он называет то, что нарисовано, а не всю
            страницу целиком. Так правая колонка встаёт вровень с ним, а не под ним. */}
        <h1 className="text-2xl font-medium tracking-tight text-foreground">{term}</h1>
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

function CdekSeriesPage({ def, metricKey }: { def: SeriesDef; metricKey: SeriesKey }) {
  const chartH = useExplorerChartHeight();
  const { days, setDays, range, setRange } = usePeriod();
  const period = useMsResolvedPeriod({ days, range });
  const [kind, setKind] = useState<'line' | 'bar'>('line');
  const [cmp, setCmp] = useState<'off' | 'prev'>('prev');

  // ЦЕЛЬ — та же `prefs.target`, что задаёт «Целевой уровень» в редакторе виджета, и тот же ключ,
  // что у карточки «Обзора» (id виджета = ключу метрики). Второго механизма не заводим: цель,
  // поставленная здесь, видна и в редакторе виджета, и на карточке — но ТОЛЬКО там, где карточка
  // рисует LineChart/BarChart (проверено: «Заказы» показывают «цель 3»).
  //
  // На карточке-ИСКРЕ линии нет, и это не недосмотр: у Sparkline своё усечённое окно просмотра
  // (sparkDomain режет выбросы по квантилям и метит их карéткой). Цель выше этого окна либо
  // осталась бы невидимой, либо расплющила бы сам ряд в черту — то есть испортила главное ради
  // второстепенного. Полный домен с целью живёт на этой странице, у графика с осью.
  const prefs = useWidgetPrefs(metricKey);
  const savedTarget = prefs.target ?? null;
  // ЧЕРНОВИК, как у фильтров: undefined — «не трогали», дальше живёт выбор человека. Раньше цель
  // писалась в prefs прямо из onChange, и два соседних раздела вели себя по-разному — фильтры
  // ждали «Сохранить», а цель молча уезжала на карточку «Обзора». Владелец на этом и споткнулся
  // («почему нет кнопки сохранить? я добавил фильтры и добавил target»): кнопка была, но к цели
  // отношения не имела. Теперь у колонки ОДНО правило — на графике видно сразу, на карточке
  // после сохранения.
  const [draftTarget, setDraftTarget] = useState<number | null | undefined>(undefined);
  const target = draftTarget !== undefined ? draftTarget : savedTarget;
  const [targetOpen, setTargetOpen] = useState(false);
  const showTarget = target != null || targetOpen;


  // Фильтр статусов живёт ТОЛЬКО здесь, внутри разворота (решение владельца). Карточка «Обзора»
  // остаётся на каноне и потому не имеет скрытого состояния: число на ней всегда значит одно и то
  // же. Сохранённый набор по той же причине не протекает на карточку — иначе она меняла бы
  // значение без единого видимого контрола.
  const { channelId } = useSelectedChannel();
  const filterKey = cdekStatusFilterKey(channelId);
  const savedRaw = useSavedFilter(filterKey);
  const saved = useMemo(() => normalizeCdekStatuses(savedRaw), [savedRaw]);
  // ДЕЙСТВУЮЩИЙ сохранённый набор, а не сырой: пустые настройки означают канон, и сравнивать с
  // пустотой нельзя — иначе на свежем аккаунте «Сохранить» горит с первого кадра, предлагая
  // сохранить то, что человек не выбирал.
  const savedEffective = saved.length > 0 ? saved : CDEK_CANON_STATUSES;
  const [selected, setSelected] = useState<string[] | null>(null);
  const statuses = selected ?? savedEffective;
  const include = cdekStatusInclude(statuses);

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

  // Третья ось того же вопроса: статус — КАК закончился заказ, товар — ЧТО продано, канал — ГДЕ.
  const channelKey = cdekChannelFilterKey(channelId);
  const savedChannelsRaw = useSavedFilter(channelKey);
  const savedChannels = useMemo(() => normChannels(savedChannelsRaw), [savedChannelsRaw]);
  const [pickedChannels, setPickedChannels] = useState<string[] | null>(null);
  const salesChannels = pickedChannels ?? savedChannels;

  // Разбивка: ряд приходит группами вместо одной серии. Пока разрез не выбран, запрос прежний —
  // лишнего похода за данными «на всякий случай» нет.
  const [splitDim, setSplitDim] = useState<string>('');
  const series = useCdekSeries(period, include, undefined, products, salesChannels, splitDim || undefined);
  const summary = useCdekSummary(period, include, products, salesChannels);

  // Хук ДО ранних возвратов: ниже страница уходит в скелетон и в ошибку, и вызов после них дал бы
  // «Rendered more hooks than during the previous render» — известные грабли этого репо.
  const filterState = { statuses, products, channels: salesChannels };
  const dims = useCdekFilterDims(filterState);

  if (series.isPending || summary.isPending) {
    return (
      <CdekMetricShell term={def.term} back={def.back}>
        <Skeleton className="h-[420px] w-full" />
      </CdekMetricShell>
    );
  }
  if (series.isError || summary.isError) {
    return (
      <CdekMetricShell term={def.term} back={def.back}>
        <ErrorState title="Не удалось получить данные СДЭКа" onRetry={() => series.refetch()} />
      </CdekMetricShell>
    );
  }

  // Сетка окна достраивается ЗДЕСЬ: сервер отдаёт только дни с продажами (см. densifyCdekDays).
  // Без неё ось врала о расстояниях между датами, а призрак прошлого окна расходился с рядом по
  // длине — и на столбцах сравнение молча пропадало.
  const curPoints = densifyCdekDays(series.data?.current ?? [], series.data?.window.from, series.data?.window.to);
  const prevPoints = densifyCdekDays(
    series.data?.previous ?? [],
    summary.data?.previous_window?.from,
    summary.data?.previous_window?.to,
  );
  const raw = curPoints.map((p) => ({ day: p.day, value: def.pick(p) }));
  const shown = lttbDownsample(raw, 400, (r) => r.value ?? 0);
  const values = shown.map((r) => r.value);
  const labels = shown.map((r) => fmt.day(r.day));
  const axisLabels = timeAxisFromDayKeys(shown.map((r) => r.day));
  // Призрак прошлого окна выравнивается ПО ИНДЕКСУ: у равных окон одинаковая длина, а даты у них
  // разные — рисовать их по своим датам значило бы сдвинуть кривую. Даунсэмплится он тем же
  // порогом, что и ряд: иначе на длинном окне длины снова разъедутся.
  const prevShown = lttbDownsample(
    prevPoints.map((p) => ({ day: p.day, value: def.pick(p) })),
    400,
    (r) => r.value ?? 0,
  );
  const prevRaw = prevShown.map((r) => r.value ?? 0);
  // Призрак передаётся ВСЕГДА, когда данные есть; переключатель отвечает только за видимость.
  // Так строка легенды не пропадает (иначе таймбар под графиком прыгал на 21px), а линия гаснет
  // плавно вместо снятия из DOM (владелец: «дёргано появляется»).
  const compare = prevRaw.length > 1 ? prevRaw : undefined;
  const compareShown = cmp === 'prev';

  // ── Разбивка: ряд группами ────────────────────────────────────────────────────────────────
  // Дни берутся ОБЪЕДИНЕНИЕМ по всем группам, а не из первой: у каналов дни продаж разные, и взяв
  // сетку одной серии, остальные пришлось бы натягивать на чужие даты.
  const groups = splitDim ? (series.data?.groups ?? []) : [];
  const splitModel = (() => {
    if (groups.length === 0) return null;
    const days = [...new Set(groups.flatMap((g) => g.points.map((p) => p.day)))].sort();
    const head = groups.slice(0, CDEK_MAX_SERIES);
    const hidden = groups.length - head.length;
    const label = (key: string | null) =>
      key == null || key === ''
        ? 'Без значения'
        : splitDim === 'channel'
          ? (CHANNEL_LABEL[key] ?? key)
          : splitDim === 'status'
            ? (STATUS_LABEL[key] ?? key)
            : (productOptions.find((o) => o.id === key)?.name ?? key);
    return {
      days,
      hidden,
      labels: days.map((d) => fmt.day(d)),
      series: head.map((g, i) => {
        const byDay = new Map(g.points.map((p) => [p.day, def.pick(p)]));
        return {
          name: label(g.key),
          color: `hsl(var(--chart-${i + 1}))`,
          // День, которого у группы нет, — это НОЛЬ продаж, а не пропуск измерения: выгрузка
          // сплошная, и разрыв линии читался бы как «данных не собрали».
          values: days.map((d) => byDay.get(d) ?? 0),
        };
      }),
    };
  })();

  const cur = summary.data?.current ? def.total(summary.data.current) : null;
  const prev = summary.data?.previous ? def.total(summary.data.previous) : null;
  const hasPrevWindow = summary.data?.previous_window != null;

  // Контролы графика переехали из-над графика в rail (владелец: «возьми всю правую область из
  // Steep»). Там они и живут у Steep: над полотном остаётся только само полотно, а «чем смотрим» и
  // «с чем сравниваем» — вопросы того же рода, что «что считаем», и стоят рядом с фильтрами.
  // Под разбивкой оба соседних контрола БЕЗДЕЙСТВОВАЛИ бы молча, и это хуже, чем их отсутствие:
  //   • столбцы — шесть рядов за тридцать дней столбцами нечитаемы, разбивка рисуется линиями;
  //   • пред. период — сервер при разбивке его не считает намеренно (вторая полупрозрачная копия
  //     каждой из шести серий превратила бы полотно в частокол).
  // Поэтому вариант гаснет и рядом печатается причина, а не остаётся кнопкой, на которую нажали и
  // ничего не произошло.
  const split = Boolean(splitDim);
  const viewSection = (
    <div className="space-y-1.5">
      <CdekChartKind value={split ? 'line' : kind} onChange={setKind} disabled={split ? ['bar'] : undefined} />
      {split && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Разбивка рисуется линиями: несколько рядов столбцами за окно нечитаемы.
        </p>
      )}
    </div>
  );

  const comparison = (
    <div className="space-y-2 pl-[2.125rem]">
      <SegmentedControl
        ariaLabel="База сравнения"
        size="sm"
        value={split ? 'off' : cmp}
        onChange={setCmp}
        options={[
          { value: 'off', content: 'Выкл' },
          // На окне «Всё» сравнивать не с чем — вариант гаснет, а не молча ничего не делает.
          // Под разбивкой — по той же причине: сервер предыдущее окно для неё не считает.
          { value: 'prev', content: 'Пред. период', disabled: !hasPrevWindow || split },
        ]}
      />
      {split && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          При разбивке прошлое окно не показывается — оно удвоило бы число линий.
        </p>
      )}
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

  // Раздел фильтров: оси не нарисованы, пока их не добавили (см. CdekFilterRail). Подпись выбора
  // печатается ПОД ним и только когда выбор ушёл от умолчания — иначе на экране висела бы строка,
  // ничего не сообщающая.

  // Одна кнопка на весь выбор: три оси отвечают на ОДИН вопрос «что считать», и раздельное
  // сохранение заставляло нажимать трижды, а пропустив нажатие — увезти на «Обзор» половину выбора.
  // «Есть что сохранять» считается по ВСЕЙ колонке, а не по одним фильтрам: цель — такая же
  // настройка метрики, и разделять их значило бы держать на странице два разных договора.
  const filtersDirty =
    !sameCdekStatuses(statuses, savedEffective) ||
    !sameCdekProducts(products, savedProducts) ||
    !sameCdekChannels(salesChannels, savedChannels);
  const dirty = filtersDirty || target !== savedTarget;
  const saveFilters = () => {
    setSavedFilter(filterKey, normalizeCdekStatuses(statuses));
    setSavedFilter(productKey, normalizeCdekProducts(products));
    setSavedFilter(channelKey, normChannels(salesChannels));
    setPrefs(metricKey, { ...prefs, target: target ?? undefined });
    setDraftTarget(undefined);
    toastStatusFilterSaved(statuses);
  };
  const applyFilters = (next: typeof filterState) => {
    setSelected(next.statuses);
    setPickedProducts(next.products);
    setPickedChannels(next.channels);
  };
  const removeDim = (dim: 'status' | 'product' | 'channel') => {
    dims.close(dim);
    if (dim === 'status') return setSelected([...CDEK_CANON_STATUSES]);
    if (dim === 'product') return setPickedProducts([]);
    return setPickedChannels([]);
  };
  // Разрез выбирается тем же приёмом, что и фильтры, и по той же причине: пять вариантов
  // сегментированным контролом в 300px колонку не влезают — подписи налезали друг на друга.
  const splitSection = (
    <CdekSplitRow dim={splitDim} onPick={setSplitDim} onClear={() => setSplitDim('')} />
  );

  // Достижение считается по ТОЧКАМ ряда, а не по итогу окна: цель — дневной уровень (сервер отдаёт
  // grain=day), и «12 из 30 дней» — утверждение, которое можно проверить глазами по линии. Доля от
  // суммы окна потребовала бы выбрать базу («цель × дней»?) и молча домыслить за человека.
  const targetHint = (() => {
    if (target == null) return undefined;
    if (splitDim) {
      // Цель задана для всей метрики, а не для отдельного ряда: линия поверх шести серий читалась
      // бы как цель каждой из них.
      return 'При разбивке линия цели не рисуется: цель у метрики одна, а рядов несколько.';
    }
    const known = values.filter((v): v is number => v != null);
    if (known.length === 0) return undefined;
    const hit = known.filter((v) => v >= target).length;
    return `Достигнута в ${hit} из ${known.length} ${pluralRu(known.length, ['дня', 'дней', 'дней'])}`;
  })();
  const targetSection = showTarget ? (
    <CdekTargetRow
      value={target}
      onChange={setDraftTarget}
      onRemove={() => {
        setDraftTarget(null);
        setTargetOpen(false);
      }}
      hint={targetHint}
    />
  ) : null;

  // Подписи выбора («Только каналы: Ozon») здесь БОЛЬШЕ НЕ ПЕЧАТАЮТСЯ: значения видны пилюлями
  // прямо в карточке, и строка под ними повторяла бы то, что читатель уже видит. На карточках
  // «Обзора» она остаётся — там выбора не видно вовсе, и молчащее число было бы нечестным.
  const filters = (
    <CdekFilterList
      state={filterState}
      shown={dims.shown}
      productOptions={productOptions}
      onChange={applyFilters}
      onRemove={removeDim}
    />
  );

  return (
    <CdekMetricShell
      term={def.term}
     
      back={def.back}
      comparison={comparison}
      filters={filters}
      view={viewSection}
      split={splitSection}
      splitAction={splitDim ? undefined : <CdekSplitAdd onPick={setSplitDim} />}
      target={targetSection}
      targetAction={showTarget ? undefined : <CdekTargetAdd onAdd={() => setTargetOpen(true)} />}
      filterIcon={FilterGlyph}
      filterAction={<CdekFilterAdd dims={dims.addable} onAdd={dims.open} />}
      onSaveFilters={dirty ? saveFilters : undefined}
    >
      {/* Линия цели: LineChart и BarChart читают её из ОДНОГО контекста, поэтому цель переживает
          переключение линия↔столбцы. При разбивке контекст пуст — см. targetHint. */}
      <WidgetTargetContext.Provider value={splitDim ? null : target}>
      {/* Полотно живёт НА СВОЕЙ ПОВЕРХНОСТИ и с полной осью — как метрики Instagram и кампаний
          (владелец: «выдели сам график чуть цветом и добавь оси, по типу как на /metrics/ig-reach»;
          замер той страницы: карточка bg-card, рамка 0.8px, радиус 20px, 21 линия сетки и подписи
          6k/4k/2k/0 слева). Оси включает ChartExpandedContext — тем же приёмом, что CampaignMetricPage:
          у BarChart своего `fullAxes` нет, ось Y, шаг подписей и место под неё он берёт отсюда. */}
      <ChartExpandedContext.Provider value={true}>
      <div className="space-y-3">
        <div className="rounded-2xl border border-border bg-card p-4 shadow-xs dark:border-white/6 sm:p-5">
        {splitDim && splitModel ? (
          <MultiLineChart
            series={splitModel.series}
            labels={splitModel.labels}
            height={420}
            format={(v) => (v == null ? '—' : def.format(v))}
            ariaLabel={`${def.term} по разрезу`}
            legend={
              splitModel.hidden > 0
                ? `${def.term} · и ещё ${splitModel.hidden} ${pluralRu(splitModel.hidden, ['разрез', 'разреза', 'разрезов'])} не показаны`
                : def.term
            }
          />
        ) : splitDim ? (
          <EmptyState compact size="chart" title="За окно нечего разложить по этому разрезу." />
        ) : values.length < 2 ? (
          <EmptyState compact size="chart" title="Недостаточно дней для графика за окно." />
        ) : kind === 'bar' ? (
          <BarChart
            values={values.map((v) => v ?? 0)}
            labels={labels}
            axisLabels={axisLabels}
            ghost={compare}
            ghostVisible={compareShown}
            // Своим переключателем легенда НЕ распоряжается: сравнение уже включает раздел
            // «Сравнение» в колонке, и два контрола на одно состояние расходятся (в чипе он был
            // включён по умолчанию и молча спорил с «Выкл»).
            legendToggle={false}
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
            ghostVisible={compareShown}
            legendToggle={false}
            ghostLabel="Пред. период"
            height={chartH}
            formatValue={def.format}
          />
        )}
        </div>
        <WindowBarShell>
          <PeriodChips ariaLabel="Окно" value={days} onChange={setDays} range={range} onRangeChange={setRange} />
        </WindowBarShell>
      </div>
      </ChartExpandedContext.Provider>
      </WidgetTargetContext.Provider>
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
    <CdekMetricShell term={def.term} back={def.back}>
      <div className="space-y-3">
        {/* Разрез живёт НА ТОЙ ЖЕ поверхности, что и ряд: страницы одного источника не должны
            отличаться подачей полотна только потому, что одна рисует линию, а другая — доли. */}
        <div className="rounded-2xl border border-border bg-card p-4 shadow-xs dark:border-white/6 sm:p-5">
          <div className="mb-3 flex justify-end">
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
        </div>
        <WindowBarShell>
          <PeriodChips ariaLabel="Окно" value={days} onChange={setDays} range={range} onRangeChange={setRange} />
        </WindowBarShell>
      </div>
    </CdekMetricShell>
  );
}
