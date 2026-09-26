// Лёгкий индекс каталога метрик — первый из двух слоёв единого каталога (U05).
//
// Здесь для КАЖДОЙ метрики, у которой есть полноэкранный маршрут (`/metrics/<key>`,
// `/campaigns/:id/metrics/<key>`) или виджет Главной, записано, ЧТО она такое: маршрут, источник,
// тип ряда (flow | stock | ratio{num,den}), единица, допустимые виды, возможности разбора, база оси
// Y, оценочность дельты и связь с виджетом. Второй слой — ленивые детали источника
// (`loadMetricDetails` в lib/metricDetails.ts): тексты ⓘ, URL-схема контролов разбора и deps
// запросов. Они лежат рядом с источником (panels/**) и сюда НЕ попадают.
//
// Модуль живёт в общем чанке, поэтому держит три правила (их гейтят metricIndex.test.ts и
// scripts/check-bundle-size.mjs):
//   - ни одной строки для людей: только ключи, id и перечисления — подписи и тексты живут в деталях;
//   - ни одного импорта из panels/** и api/** — только `import type`;
//   - ни одного вычисления над данными: индекс говорит, что метрика ЕСТЬ, а не как её считать.
//
// Потребители на индекс пока не переведены: старые экспорты (widgetMetrics.ts и восемь
// panels/**/*MetricKeys.ts) стали тонкими обёртками над ним и отдают ровно то же, что раньше.
//
// Поля записаны в одном из двух смыслов — у каждого поля типа он назван явно:
//   - КАНОН (куда страница сойдётся, когда начнёт читать индекс): kind, supportedViz, zeroBased —
//     там, где канон записан (PROJECT_MEMORY «Подписчики — stock», DESIGN_TOKENS, U05);
//   - СЕГОДНЯ (как ведёт себя код сейчас): capabilities, evaluative и widget-фасет.
// Там, где выбор вида пишется в URL, supportedViz совпадает с сегодняшним (это держит тест деталей).
// Известные расхождения канона и сегодняшних страниц — PR, который переводит страницу на индекс,
// обязан назвать это видимое изменение и его класс для телефона (OD-16):
//   - rusender.contacts, rusender.unsubscribed: supportedViz ['line'] и zeroBased=false, а страница
//     предлагает «Столбцы» и рисует от нуля (CHARTS-13, SHELL-18);
//   - ряды СДЭКа: zeroBased=true, а страница не передаёт графику yMin (база оси Y, U09);
//   - дневные разборы IG и Метрики: capabilities.window = 'local' — записано как сегодня, канон —
//     окно разбора (PERIOD-1, SHELL-4);
//   - rusender.unsubscribed: evaluative=true — как сегодня (рост отписавшихся окрашен как хороший);
//     канона нет, вопрос владельцу.
//
// Вид «Чистого прироста» (tg.netGrowth, ig.netFollowers) зависит от OD-4 и до решения записан
// как есть: столбцы по умолчанию, линия — вариант.

import type { DrillKey } from '@/lib/kpiDerive';

/** Стабильный id метрики, `<пространство>.<имя>`. У метрик виджетов совпадает с widget id. */
export type MetricId = string;

/** Шесть сетей-источников. */
export type MetricNetwork = 'tg' | 'ig' | 'ms' | 'ym' | 'cdek' | 'rusender';
/** Источник записи индекса: сеть или `multi` — срез по нескольким сетям (кампании). */
export type MetricIndexSource = MetricNetwork | 'multi';

/** Тип ряда: как значения складываются во времени и в корзины.
 *   - flow  — поток, корзина = сумма (просмотры, выручка, визиты);
 *   - stock — уровень/снимок, корзина = последнее значение (подписчики, размер базы, остатки);
 *   - ratio — отношение двух потоков, корзина = Σчислителя ÷ Σзнаменателя (средний чек, ER). */
export type MetricValueKind = 'flow' | 'stock' | 'ratio';

/** Числитель и знаменатель ratio-метрики — имена потоков, а не подписи. */
export interface RatioParts {
  num: string;
  den: string;
}

/** Формат чисел метрики (`currency` — рубли; единственные деньги — МС и СДЭК). */
export type MetricUnit = 'number' | 'percent' | 'posts' | 'views' | 'currency';

/** Виды виджета Главной. `donut` = PieChart, `list` = строки Breakdown, `rank`/`pivot` — проекции
 *  разбора по измерениям, `ledger` — широкая строка столбик+значения. */
export type WidgetViz = 'kpi' | 'line' | 'bar' | 'donut' | 'list' | 'rank' | 'pivot' | 'table' | 'ledger';

/** Виды полного разбора: словарь виджета плюс формы, которых у виджетов нет. Первый элемент
 *  `supportedViz` — вид по умолчанию. */
export type MetricViz = WidgetViz | 'heatmap' | 'scatter' | 'funnel';

/** Форма метрики в каталоге виджетов (в widgetMetrics это поле `kind`). */
export type MetricShape = 'value' | 'series' | 'breakdown' | 'table';

/** Группа каталога виджетов. */
export type MetricCategory = 'growth' | 'engagement' | 'content' | 'audience';

/**
 * Как виджет Главной сворачивает дневную серию в корзину (capResultSeries) — текущее поведение:
 *  - flow  — сумма (потоки: просмотры, реакции, выручка);
 *  - level — последнее значение корзины (уровни: подписчики, средний чек);
 *  - mean  — среднее наблюдений корзины (метрики-ОТНОШЕНИЯ, у которых точка ряда уже есть
 *            среднее: складывать средние нельзя, а last-of-bucket выбросил бы остальные дни).
 * Правило по `kind` (ratio = Σ/Σ) придёт вместе с агрегатором корзин; до тех пор это поле — явный
 * параметр виджета, а не следствие kind.
 */
export type SeriesAggregation = 'flow' | 'level' | 'mean';

export type MetricCompareMode = 'off' | 'prev' | 'year';
export type MetricGrain = 'day' | 'week' | 'month';

/** Чьё окно у разбора:
 *   - explorer — глобальный период разбора (usePeriod, в URL p/from/to через PeriodUrlSync);
 *   - local    — собственное состояние страницы (в URL не пишется);
 *   - fixed    — окно задаёт источник (графики статистики Telegram, снимок демографии, даты кампании);
 *   - none     — окна нет (вся история: когорты, скорость набора). */
export type MetricWindowMode = 'explorer' | 'local' | 'fixed' | 'none';

/** Ряд, разложенный по разрезу: несколько рядов столбцами за окно нечитаемы — только линия
 *  (канон U05 «разбивка каналов МС — только линия»; МС и СДЭК сегодня приводят `bar` к линии). */
export interface MetricSplitView {
  /** Виды разложенного ряда; ⊆ supportedViz. */
  viz: readonly MetricViz[];
  /** База сравнения остаётся под разбивкой (у МС — итог окна в рейле; СДЭК её гасит). */
  compare: boolean;
  /** Линия цели остаётся под разбивкой. */
  target: boolean;
}

/** СЕГОДНЯ: что умеет полный разбор метрики сейчас. У метрики без маршрута — всё выключено. */
export interface MetricCapabilities {
  /** Базы сравнения, которые предлагает рейл, в каноническом порядке; [] — сравнения нет.
   *  Без 'off' — база включена всегда и переключателя нет. */
  compare: readonly MetricCompareMode[];
  /** Грануляции ряда в переключателе; [] — переключателя нет (сервер или форма решают сами). */
  grain: readonly MetricGrain[];
  /** Закрепление точки графика (панель дня; у TG/IG — с постами дня). */
  pin: boolean;
  /** Линия цели (плановое значение) на графике. */
  target: boolean;
  /** Выбор цели атрибуции (цели Метрики). */
  goal: boolean;
  /** Разрезы, на которые раскладывается ряд; [] — разбивки нет. */
  split: readonly string[];
  /** Что остаётся от разбора под разбивкой; null — ровно тогда, когда split пуст. */
  splitView: MetricSplitView | null;
  window: MetricWindowMode;
  /** Пресет «Всё». */
  allowAll: boolean;
  /** «Свой период» (календарь). */
  customRange: boolean;
  /** Потолок ширины окна у источника; null — без потолка. */
  maxRangeDays: number | null;
  /** Измерения проекций rank/pivot. */
  dims: readonly string[];
}

/** Маршрут полного разбора: `/metrics/<key>` или `/campaigns/:id/metrics/<key>`. */
export interface MetricRouteRef {
  scope: 'metrics' | 'campaign';
  key: string;
}

/** СЕГОДНЯ: структура метрики в каталоге виджетов Главной — всё, кроме текстов (они в деталях). */
export interface WidgetFacet {
  shape: MetricShape;
  category: MetricCategory;
  /** Вид свежего виджета; всегда ∈ supportedViz. */
  defaultViz: WidgetViz;
  supportedViz: readonly WidgetViz[];
  /** Измерения разбивки (ids каталога измерений). */
  dimensions?: readonly string[];
  /** Агрегация корзин из каталога виджетов (MetricDef.seriesAgg). */
  seriesAgg?: SeriesAggregation;
  /** Агрегация корзин, которую виджет берёт ВНЕ каталога — докласификация
   *  resolveWidgetMetric.SERIES_AGG_OVERRIDES (средний чек: последний день корзины, PERIOD-6). В
   *  MetricDef не выносится. Корзины виджета сегодня: seriesAgg ?? bucketAggOverride ?? 'flow'. */
  bucketAggOverride?: SeriesAggregation;
  /** Одна из шести KPI-метрик TG (kpiDerive.DrillKey). */
  drillKey?: DrillKey;
  /** Текущая цель клика по числу виджета там, где drillKey нет (МС → /sklad, Метрика → /metrika).
   *  Записано как есть: переход на маршрут метрики — отдельный PR (EXPAND-3, SHELL-2, CHARTS-3). */
  drillTo?: string;
  /** Сумма категорий разбивки — честный итог (герой карточки-распределения). */
  additive?: boolean;
}

export interface MetricIndexEntry {
  id: MetricId;
  route: MetricRouteRef | null;
  source: MetricIndexSource;
  /** КАНОН. Агрегатор корзин по kind у виджета ещё не работает — см. widget.bucketAggOverride. */
  kind: MetricValueKind;
  /** Есть только у kind = 'ratio'. */
  ratio?: RatioParts;
  unit: MetricUnit;
  /** КАНОН. Виды полного разбора (первый — по умолчанию); у метрики без маршрута — виды её виджета. */
  supportedViz: readonly MetricViz[];
  /** СЕГОДНЯ. */
  capabilities: MetricCapabilities;
  /** КАНОН. База оси Y линий и столбцов — ноль: у уровня (stock) ось подогнана под диапазон, у
   *  потоков и отношений — от нуля. Для списков и сеток без оси значение не влияет. */
  zeroBased: boolean;
  /** СЕГОДНЯ. Δ окрашивается оценочно (рост — хорошо) в рейле полного разбора; false — нейтральная. */
  evaluative: boolean;
  /** Есть у метрик каталога виджетов; совпадает с id. */
  widgetId?: MetricId;
  widget?: WidgetFacet;
}

// ── Ключи маршрутов (источник истины для panels/**/*MetricKeys.ts) ────────────────────────────

/** Шесть KPI-метрик TG за `/metrics/:key` (зеркало kpiDerive.DRILL_KEYS; равенство держит тест). */
export const TG_CORE_METRIC_KEYS = ['views', 'subscribers', 'avgReach', 'reactions', 'forwards', 'er'] as const;

/** Карточки-графики Аналитики TG вне шести KPI: `tg-*` за `/metrics/:key` (TgMetricPage). */
export const TG_EXTRA_METRIC_KEYS = [
  // Тепловая карта активности — своя сетка 7×24, без Line/Bar и сравнения.
  'tg-heatmap',
  // Скорость набора просмотров — накопительный профиль, настоящие Line/Bar, без сравнения.
  'tg-velocity',
  // Карта форматов — своя двухмерная форма.
  'tg-content-opportunity',
  // Категориальные ряды (ось дней недели / часов — Line честен).
  'tg-weekday-reach', // Сравнение: средний охват поста по дню недели
  'tg-weekday-views', // Аудитория: средние просмотры поста по дню недели
  'tg-post-count', //    Аудитория: число постов по дню недели
  'tg-hours', //         Аудитория: активность по часам (графики статистики)
  // Разрезы — честные списки, без выдуманных Line/Bar и сравнения.
  'tg-format-views', //       Сравнение: просмотры по формату
  'tg-hashtag-erv', //        Форматы: влияние хэштегов на ERV (в рамках кампании)
  'tg-emoji', //              Форматы: реакции по эмодзи (в рамках кампании)
  'tg-engagement-mix', //     Форматы: состав вовлечённости (в рамках кампании)
  'tg-reach-by-type', //      Форматы: средний охват по типу (в рамках кампании)
  'tg-erv-by-format', //      Форматы: средний ERV по типу (в рамках кампании)
  'tg-views-by-source', //    Аудитория: просмотры по источникам (графики)
  'tg-followers-by-source', //Аудитория: новые подписчики по источникам (графики)
  'tg-languages', //          Аудитория: языки аудитории (графики)
  'tg-sentiment', //          Аудитория: тональность реакций (графики)
  'tg-churn', //              Динамика: подписки и отписки за окно
] as const;

/** Карточки-графики Instagram (разрезы, сетки, Reels, истории) за `/metrics/:key`. */
export const IG_CHART_METRIC_KEYS = [
  // Демография (снимок follower_demographics) — честные списки без окна и сравнения.
  'ig-age',
  'ig-gender',
  'ig-countries',
  'ig-cities',
  // Лучшее время — своя сетка 7×24 (online_followers).
  'ig-best-time',
  // Вовлечённость по форматам за окно (список).
  'ig-format-engagement',
  // Среднее время просмотра Reels — категориальные столбцы по постам.
  'ig-reels-watch-time',
  // Навигация по историям — сумма действий за сутки историй (список).
  'ig-story-navigation',
] as const;

/** Числовые и производные разборы Instagram (IgMetricPage). */
export const IG_EXPLORER_METRIC_KEYS = [
  'ig-reach',
  'ig-follows',
  'ig-views',
  'ig-interactions',
  'ig-likes',
  'ig-saves',
  'ig-er',
] as const;

/** МойСклад `ms-*`. */
export const MS_METRIC_KEYS = [
  'ms-revenue',
  'ms-orders',
  'ms-aov',
  'ms-customers',
  'ms-repeat',
  'ms-rfm',
  'ms-channels',
  'ms-funnel',
  'ms-products',
  'ms-returns',
  'ms-sales-channels',
  'ms-geography',
  'ms-top-customers',
  'ms-cohorts',
  'ms-stock',
] as const;

/** Яндекс.Метрика `ym-*` — один-в-один с доской Обзора /metrika. */
export const YM_METRIC_KEYS = [
  // Настоящие дневные ряды (Line/Bar + сравнение из архива ym_daily).
  'ym-visits',
  'ym-users',
  'ym-pageviews',
  // Ритм по часам — своя сетка.
  'ym-hourly',
  // Разрезы — полный список.
  'ym-sources',
  'ym-referrers',
  'ym-social',
  'ym-messengers',
  'ym-devices',
  'ym-countries',
  'ym-cities',
  'ym-age',
  'ym-gender',
  'ym-goals',
  'ym-utm',
  'ym-pages',
  'ym-landings',
  'ym-exits',
] as const;

/** СДЭК `cdek-*` — карточки «Обзора» и «Товаров» один-в-один. */
export const CDEK_METRIC_KEYS = [
  // Дневные ряды: Линия/Столбцы + сравнение с равным предыдущим окном.
  'cdek-revenue',
  'cdek-orders',
  'cdek-aov',
  'cdek-units',
  'cdek-price',
  // Разрезы: полный список.
  'cdek-channels',
  'cdek-statuses',
  'cdek-products',
] as const;

/** Rusender `rusender-*` — только настоящие дневные ряды («Рассылок периода» нет сознательно). */
export const RUSENDER_METRIC_KEYS = [
  'rusender-opens',
  'rusender-clicks',
  'rusender-contacts',
  'rusender-unsubscribed',
] as const;

/** Упоминания `mentions-*` (сеть — Telegram). */
export const MENTIONS_METRIC_KEYS = ['mentions-timeline', 'mentions-sources'] as const;

/** Разборы кампании за `/campaigns/:id/metrics/<key>`. */
export const CAMPAIGN_METRIC_KEYS = ['timeline', 'sources', 'formats'] as const;

type TgCoreKey = (typeof TG_CORE_METRIC_KEYS)[number];
type TgExtraKey = (typeof TG_EXTRA_METRIC_KEYS)[number];
type IgRouteKey = (typeof IG_EXPLORER_METRIC_KEYS)[number] | (typeof IG_CHART_METRIC_KEYS)[number];
type MsKey = (typeof MS_METRIC_KEYS)[number];
type YmKey = (typeof YM_METRIC_KEYS)[number];
type CdekKey = (typeof CDEK_METRIC_KEYS)[number];
type RusenderKey = (typeof RUSENDER_METRIC_KEYS)[number];
type MentionsKey = (typeof MENTIONS_METRIC_KEYS)[number];
type CampaignKey = (typeof CAMPAIGN_METRIC_KEYS)[number];

// ── Возможности: пресеты ─────────────────────────────────────────────────────────────────────

const NO_CAPABILITIES: MetricCapabilities = {
  compare: [],
  grain: [],
  pin: false,
  target: false,
  goal: false,
  split: [],
  splitView: null,
  window: 'none',
  allowAll: false,
  customRange: false,
  maxRangeDays: null,
  dims: [],
};

function caps(over: Partial<MetricCapabilities>): MetricCapabilities {
  return { ...NO_CAPABILITIES, ...over };
}

const DAY_WEEK_MONTH: readonly MetricGrain[] = ['day', 'week', 'month'];
const OFF_PREV: readonly MetricCompareMode[] = ['off', 'prev'];
const OFF_PREV_YEAR: readonly MetricCompareMode[] = ['off', 'prev', 'year'];
const LINE_BAR: readonly MetricViz[] = ['line', 'bar'];
const BAR_LINE: readonly MetricViz[] = ['bar', 'line'];
const LINE: readonly MetricViz[] = ['line'];
const LIST: readonly MetricViz[] = ['list'];
const TABLE: readonly MetricViz[] = ['table'];
const HEATMAP: readonly MetricViz[] = ['heatmap'];
/** Под разбивкой — только линия; сравнения и цели на полотне разбивки нет. */
const SPLIT_LINE_ONLY: MetricSplitView = { viz: LINE, compare: false, target: false };

/** Окно = глобальный период разбора с пресетами, «Всё» и «Своим периодом» (PeriodChips). */
const EXPLORER_WINDOW = { window: 'explorer', allowAll: true, customRange: true } as const;
/** Список/сетка за окно разбора, без сравнения. */
const WINDOW_REPORT = caps(EXPLORER_WINDOW);
/** Разрез за окно, которое задаёт сам источник (графики статистики Telegram, снимок демографии). */
const FIXED_REPORT = caps({ window: 'fixed' });

// ── Записи маршрутов ───────────────────────────────────────────────────────────────────────────

interface RouteSpec {
  id: MetricId;
  kind: MetricValueKind;
  ratio?: RatioParts;
  unit: MetricUnit;
  viz: readonly MetricViz[];
  caps: MetricCapabilities;
  /** По умолчанию true. */
  evaluative?: boolean;
}

interface RouteFamily<K extends string> {
  source: MetricIndexSource;
  scope: MetricRouteRef['scope'];
  keys: readonly K[];
  specs: Record<K, RouteSpec>;
}

// TG core (MetricPage): окно разбора + свой диапазон + пейджер, грануляция и сравнение в URL,
// пин дня с постами; у метрик с атрибуцией по постам — rank/pivot по формату и дню недели.
const TG_CORE_POSTS = caps({
  ...EXPLORER_WINDOW,
  compare: OFF_PREV_YEAR,
  grain: DAY_WEEK_MONTH,
  pin: true,
  dims: ['format', 'weekday'],
});
const TG_CORE_POST_VIZ: readonly MetricViz[] = ['line', 'bar', 'rank', 'pivot'];

const TG_CORE: RouteFamily<TgCoreKey> = {
  source: 'tg',
  scope: 'metrics',
  keys: TG_CORE_METRIC_KEYS,
  specs: {
    views: { id: 'tg.views', kind: 'flow', unit: 'views', viz: TG_CORE_POST_VIZ, caps: TG_CORE_POSTS },
    subscribers: {
      id: 'tg.subscribers',
      kind: 'stock',
      unit: 'number',
      viz: LINE,
      caps: { ...TG_CORE_POSTS, dims: [] },
    },
    avgReach: {
      id: 'tg.avgReach',
      kind: 'ratio',
      ratio: { num: 'views', den: 'posts' },
      unit: 'views',
      viz: TG_CORE_POST_VIZ,
      caps: TG_CORE_POSTS,
    },
    reactions: { id: 'tg.reactions', kind: 'flow', unit: 'number', viz: TG_CORE_POST_VIZ, caps: TG_CORE_POSTS },
    forwards: { id: 'tg.forwards', kind: 'flow', unit: 'number', viz: TG_CORE_POST_VIZ, caps: TG_CORE_POSTS },
    er: {
      id: 'tg.er',
      kind: 'ratio',
      ratio: { num: 'engagement', den: 'subscribers' },
      unit: 'percent',
      viz: TG_CORE_POST_VIZ,
      caps: TG_CORE_POSTS,
    },
  },
};

// TG extra (TgMetricPage): сравнения нет нигде; тип графика — локальный у категориальных рядов;
// разрезы по графикам статистики Telegram живут в окне самого источника, без тайм-бара.
const TG_EXTRA: RouteFamily<TgExtraKey> = {
  source: 'tg',
  scope: 'metrics',
  keys: TG_EXTRA_METRIC_KEYS,
  specs: {
    'tg-heatmap': {
      id: 'tg.heatmap',
      kind: 'ratio',
      ratio: { num: 'engagement', den: 'views' },
      unit: 'percent',
      viz: HEATMAP,
      caps: WINDOW_REPORT,
    },
    'tg-velocity': {
      id: 'tg.velocity',
      kind: 'ratio',
      ratio: { num: 'viewsAccrued', den: 'viewsFinal' },
      unit: 'percent',
      viz: LINE_BAR,
      caps: NO_CAPABILITIES,
    },
    'tg-content-opportunity': {
      id: 'tg.contentOpportunity',
      kind: 'ratio',
      ratio: { num: 'views', den: 'posts' },
      unit: 'percent',
      viz: ['scatter'],
      caps: WINDOW_REPORT,
    },
    'tg-weekday-reach': {
      id: 'tg.weekdayReach',
      kind: 'ratio',
      ratio: { num: 'views', den: 'posts' },
      unit: 'views',
      viz: LINE_BAR,
      caps: WINDOW_REPORT,
    },
    'tg-weekday-views': {
      id: 'tg.weekdayViews',
      kind: 'ratio',
      ratio: { num: 'views', den: 'posts' },
      unit: 'views',
      viz: LINE_BAR,
      caps: WINDOW_REPORT,
    },
    'tg-post-count': { id: 'tg.postCount', kind: 'flow', unit: 'posts', viz: LINE_BAR, caps: WINDOW_REPORT },
    'tg-hours': { id: 'tg.hours', kind: 'flow', unit: 'number', viz: LINE_BAR, caps: caps({ window: 'fixed' }) },
    'tg-format-views': { id: 'tg.formatViews', kind: 'flow', unit: 'views', viz: LIST, caps: WINDOW_REPORT },
    'tg-hashtag-erv': {
      id: 'tg.hashtagErv',
      kind: 'ratio',
      ratio: { num: 'engagement', den: 'views' },
      unit: 'percent',
      viz: LIST,
      caps: WINDOW_REPORT,
    },
    'tg-emoji': { id: 'tg.emoji', kind: 'flow', unit: 'number', viz: LIST, caps: WINDOW_REPORT },
    'tg-engagement-mix': {
      id: 'tg.engagementComposition',
      kind: 'flow',
      unit: 'number',
      viz: LIST,
      caps: WINDOW_REPORT,
    },
    'tg-reach-by-type': {
      id: 'tg.viewsByType',
      kind: 'ratio',
      ratio: { num: 'views', den: 'posts' },
      unit: 'views',
      viz: LIST,
      caps: WINDOW_REPORT,
    },
    'tg-erv-by-format': {
      id: 'tg.formatPerf',
      kind: 'ratio',
      ratio: { num: 'engagement', den: 'views' },
      unit: 'percent',
      viz: LIST,
      caps: WINDOW_REPORT,
    },
    'tg-views-by-source': { id: 'tg.viewsBySource', kind: 'flow', unit: 'views', viz: LIST, caps: FIXED_REPORT },
    'tg-followers-by-source': {
      id: 'tg.newFollowersBySource',
      kind: 'flow',
      unit: 'number',
      viz: LIST,
      caps: FIXED_REPORT,
    },
    'tg-languages': { id: 'tg.languages', kind: 'flow', unit: 'number', viz: LIST, caps: FIXED_REPORT },
    'tg-sentiment': { id: 'tg.sentiment', kind: 'flow', unit: 'number', viz: LIST, caps: FIXED_REPORT },
    'tg-churn': { id: 'tg.churn', kind: 'flow', unit: 'number', viz: LIST, caps: WINDOW_REPORT },
  },
};

// Instagram. Дневные разборы держат СВОЁ окно (useState, пресеты 7/30/90/Всё без календаря) —
// PERIOD-1/SHELL-4, записано как есть. Агрегатные страницы и разрезы за окно читают глобальный
// период. Потолка окна больше нет (OD-13): длинные окна читают архив ig_daily, а не живые 90 дней
// Graph; чип «Всё» на этих страницах пока не предлагается (телефонный этап, SHELL-4/PERIOD-1).
const IG_DAILY = caps({ window: 'local', allowAll: true, compare: OFF_PREV_YEAR, pin: true });
const IG_INSIGHTS_WINDOW = caps({ window: 'explorer', maxRangeDays: null });
const IG: RouteFamily<IgRouteKey> = {
  source: 'ig',
  scope: 'metrics',
  keys: [...IG_EXPLORER_METRIC_KEYS, ...IG_CHART_METRIC_KEYS],
  specs: {
    'ig-reach': { id: 'ig.reach', kind: 'flow', unit: 'views', viz: LINE_BAR, caps: IG_DAILY },
    // Уровень аудитории: только линия; рейл — «В начале периода / Изменение», без выбора базы.
    'ig-follows': { id: 'ig.followers', kind: 'stock', unit: 'number', viz: LINE, caps: { ...IG_DAILY, compare: [] } },
    // Продвинутые потоки: дневной разбор — когда архив ig_daily накопил ряд; до того страница
    // показывает сравнение агрегатов окна (IG_INSIGHTS_WINDOW). Записан дневной разбор.
    'ig-views': { id: 'ig.views', kind: 'flow', unit: 'views', viz: LINE_BAR, caps: IG_DAILY },
    'ig-interactions': { id: 'ig.interactions', kind: 'flow', unit: 'number', viz: LINE_BAR, caps: IG_DAILY },
    'ig-likes': { id: 'ig.likes', kind: 'flow', unit: 'number', viz: LINE_BAR, caps: IG_DAILY },
    'ig-saves': { id: 'ig.saves', kind: 'flow', unit: 'number', viz: LINE_BAR, caps: IG_DAILY },
    // ER страницы — взаимодействия ÷ охват ПЕРИОДА; у виджета ig.erv знаменатель — сумма дневных
    // охватов, поэтому это две разные записи.
    'ig-er': {
      id: 'ig.er',
      kind: 'ratio',
      ratio: { num: 'interactions', den: 'reach' },
      unit: 'percent',
      viz: ['kpi'],
      caps: { ...IG_INSIGHTS_WINDOW, compare: ['prev'] },
    },
    'ig-age': { id: 'ig.age', kind: 'stock', unit: 'number', viz: LIST, caps: FIXED_REPORT },
    'ig-gender': { id: 'ig.gender', kind: 'stock', unit: 'number', viz: LIST, caps: FIXED_REPORT },
    'ig-countries': { id: 'ig.countries', kind: 'stock', unit: 'number', viz: LIST, caps: FIXED_REPORT },
    'ig-cities': { id: 'ig.cities', kind: 'stock', unit: 'number', viz: LIST, caps: FIXED_REPORT },
    'ig-best-time': { id: 'ig.hours', kind: 'stock', unit: 'number', viz: HEATMAP, caps: FIXED_REPORT },
    'ig-format-engagement': { id: 'ig.formats', kind: 'flow', unit: 'number', viz: LIST, caps: IG_INSIGHTS_WINDOW },
    'ig-reels-watch-time': {
      id: 'ig.reelsWatchTime',
      kind: 'ratio',
      ratio: { num: 'watchTime', den: 'plays' },
      unit: 'number',
      viz: ['bar'],
      caps: IG_INSIGHTS_WINDOW,
    },
    'ig-story-navigation': { id: 'ig.storyNavigation', kind: 'flow', unit: 'number', viz: LIST, caps: FIXED_REPORT },
  },
};

// МойСклад: окно разбора, контролы — в URL (msMetricUrlState); сравнение — Выкл/Пред. период.
const MS_SERIES = caps({ ...EXPLORER_WINDOW, compare: OFF_PREV, grain: DAY_WEEK_MONTH });
const MS_REPORT = caps({ ...EXPLORER_WINDOW, compare: OFF_PREV });
const MS: RouteFamily<MsKey> = {
  source: 'ms',
  scope: 'metrics',
  keys: MS_METRIC_KEYS,
  specs: {
    'ms-revenue': { id: 'ms.revenue', kind: 'flow', unit: 'currency', viz: LINE_BAR, caps: MS_SERIES },
    'ms-orders': { id: 'ms.orders', kind: 'flow', unit: 'number', viz: LINE_BAR, caps: MS_SERIES },
    'ms-aov': {
      id: 'ms.avgCheck',
      kind: 'ratio',
      ratio: { num: 'revenue', den: 'orders' },
      unit: 'currency',
      viz: LINE_BAR,
      caps: MS_SERIES,
    },
    'ms-customers': { id: 'ms.customers', kind: 'flow', unit: 'number', viz: LINE_BAR, caps: MS_SERIES },
    'ms-repeat': {
      id: 'ms.repeat',
      kind: 'ratio',
      ratio: { num: 'repeatCustomers', den: 'customers' },
      unit: 'percent',
      viz: LINE_BAR,
      caps: MS_SERIES,
    },
    'ms-rfm': { id: 'ms.rfm', kind: 'stock', unit: 'number', viz: LIST, caps: MS_REPORT },
    // Агрегат — линия или столбцы; разбивка по каналам — только линия (канон U05: MsMetricPage
    // приводит chart=bar к line и прячет переключатель). База сравнения остаётся в рейле: она
    // сравнивает итог окна, а не ряды.
    'ms-channels': {
      id: 'ms.channels',
      kind: 'flow',
      unit: 'currency',
      viz: LINE_BAR,
      caps: { ...MS_SERIES, split: ['channel'], splitView: { ...SPLIT_LINE_ONLY, compare: true } },
    },
    'ms-funnel': { id: 'ms.funnel', kind: 'flow', unit: 'number', viz: ['funnel'], caps: MS_REPORT },
    'ms-products': { id: 'ms.products', kind: 'flow', unit: 'currency', viz: TABLE, caps: WINDOW_REPORT },
    'ms-returns': { id: 'ms.returns', kind: 'flow', unit: 'number', viz: LINE_BAR, caps: MS_SERIES },
    'ms-sales-channels': { id: 'ms.salesChannels', kind: 'flow', unit: 'currency', viz: LIST, caps: MS_REPORT },
    'ms-geography': { id: 'ms.geography', kind: 'flow', unit: 'number', viz: LIST, caps: MS_REPORT },
    'ms-top-customers': { id: 'ms.topCustomers', kind: 'flow', unit: 'currency', viz: TABLE, caps: MS_REPORT },
    'ms-cohorts': {
      id: 'ms.cohorts',
      kind: 'ratio',
      ratio: { num: 'retainedCustomers', den: 'cohortCustomers' },
      unit: 'percent',
      viz: TABLE,
      caps: NO_CAPABILITIES,
    },
    // Скорости продаж нужен конечный знаменатель: «Всё» переводится в 30 дней.
    'ms-stock': { id: 'ms.stock', kind: 'stock', unit: 'number', viz: TABLE, caps: { ...WINDOW_REPORT, allowAll: false } },
  },
};

// Яндекс.Метрика. Дневные ряды держат своё окно поверх полного архива (как IG); отчёты читают
// окно разбора, которое сервер ограничивает 400 днями (YM_RANGE_MAX_DAYS).
const YM_DAILY = caps({ window: 'local', allowAll: true, compare: OFF_PREV_YEAR, pin: true });
const YM_REPORT = caps({ ...EXPLORER_WINDOW, maxRangeDays: 400 });
const YM_GOAL_REPORT = caps({ ...EXPLORER_WINDOW, maxRangeDays: 400, goal: true });
const ymList = (id: MetricId, report: MetricCapabilities = YM_REPORT): RouteSpec => ({
  id,
  kind: 'flow',
  unit: 'number',
  viz: LIST,
  caps: report,
});
const YM: RouteFamily<YmKey> = {
  source: 'ym',
  scope: 'metrics',
  keys: YM_METRIC_KEYS,
  specs: {
    'ym-visits': { id: 'ym.visits', kind: 'flow', unit: 'number', viz: LINE_BAR, caps: YM_DAILY },
    // Дневные уникальные не складываются в уникум периода: итог окна — точный отчёт Метрики, а
    // сумма по дням подписана «сумма дневных уникальных». Корзины виджета сегодня — сумма.
    'ym-users': { id: 'ym.users', kind: 'flow', unit: 'number', viz: LINE_BAR, caps: YM_DAILY },
    'ym-pageviews': { id: 'ym.pageviews', kind: 'flow', unit: 'number', viz: LINE_BAR, caps: YM_DAILY },
    'ym-hourly': { id: 'ym.hourly', kind: 'flow', unit: 'number', viz: HEATMAP, caps: YM_REPORT },
    'ym-sources': ymList('ym.sources', YM_GOAL_REPORT),
    'ym-referrers': ymList('ym.referrers'),
    'ym-social': ymList('ym.social'),
    'ym-messengers': ymList('ym.messengers'),
    'ym-devices': ymList('ym.devices', YM_GOAL_REPORT),
    'ym-countries': ymList('ym.countries'),
    'ym-cities': ymList('ym.cities'),
    'ym-age': ymList('ym.age'),
    'ym-gender': ymList('ym.gender'),
    'ym-goals': ymList('ym.goals'),
    'ym-utm': ymList('ym.utm', YM_GOAL_REPORT),
    'ym-pages': ymList('ym.pages'),
    'ym-landings': ymList('ym.landings', YM_GOAL_REPORT),
    'ym-exits': ymList('ym.exits'),
  },
};

// СДЭК. Грануляцию выбирает сервер (auto), клиентского переключателя нет. Страница сегодня не
// передаёт графику yMin — по канону ряды от нуля (расхождение «база оси Y», U09). Под разбивкой
// страница рисует только линии и гасит «Пред. период» и цель (CdekMetricPage).
const CDEK_ALL_DIMS: readonly string[] = ['channel', 'status', 'product', 'carrier'];
const CDEK_SERIES = caps({
  ...EXPLORER_WINDOW,
  compare: OFF_PREV,
  target: true,
  split: CDEK_ALL_DIMS,
  splitView: SPLIT_LINE_ONLY,
});
const CDEK: RouteFamily<CdekKey> = {
  source: 'cdek',
  scope: 'metrics',
  keys: CDEK_METRIC_KEYS,
  specs: {
    'cdek-revenue': { id: 'cdek.revenue', kind: 'flow', unit: 'currency', viz: LINE_BAR, caps: CDEK_SERIES },
    'cdek-orders': { id: 'cdek.orders', kind: 'flow', unit: 'number', viz: LINE_BAR, caps: CDEK_SERIES },
    // Разбивка среднего чека по товарам меняет саму величину — разреза «товар» у него нет.
    'cdek-aov': {
      id: 'cdek.avgCheck',
      kind: 'ratio',
      ratio: { num: 'revenue', den: 'orders' },
      unit: 'currency',
      viz: LINE_BAR,
      caps: { ...CDEK_SERIES, split: ['channel', 'status', 'carrier'] },
    },
    'cdek-units': { id: 'cdek.units', kind: 'flow', unit: 'number', viz: LINE_BAR, caps: CDEK_SERIES },
    'cdek-price': {
      id: 'cdek.price',
      kind: 'ratio',
      ratio: { num: 'revenue', den: 'units' },
      unit: 'currency',
      viz: LINE_BAR,
      caps: CDEK_SERIES,
    },
    'cdek-channels': { id: 'cdek.channels', kind: 'flow', unit: 'currency', viz: LIST, caps: WINDOW_REPORT },
    'cdek-statuses': { id: 'cdek.statuses', kind: 'flow', unit: 'currency', viz: LIST, caps: WINDOW_REPORT },
    'cdek-products': { id: 'cdek.products', kind: 'flow', unit: 'currency', viz: LIST, caps: WINDOW_REPORT },
  },
};

// Rusender. База «Пред. период» включена всегда (переключателя нет); сервер режет окно 400 днями.
// Уровни (размер базы, отписавшиеся) по канону — только линия и ось не от нуля; страница сегодня
// предлагает «Столбцы» и рисует от нуля (CHARTS-13, SHELL-18).
const RUSENDER_SERIES = caps({ ...EXPLORER_WINDOW, compare: ['prev'], maxRangeDays: 400 });
const RUSENDER: RouteFamily<RusenderKey> = {
  source: 'rusender',
  scope: 'metrics',
  keys: RUSENDER_METRIC_KEYS,
  specs: {
    'rusender-opens': { id: 'rusender.opens', kind: 'flow', unit: 'number', viz: BAR_LINE, caps: RUSENDER_SERIES },
    'rusender-clicks': { id: 'rusender.clicks', kind: 'flow', unit: 'number', viz: BAR_LINE, caps: RUSENDER_SERIES },
    'rusender-contacts': { id: 'rusender.contacts', kind: 'stock', unit: 'number', viz: LINE, caps: RUSENDER_SERIES },
    'rusender-unsubscribed': {
      id: 'rusender.unsubscribed',
      kind: 'stock',
      unit: 'number',
      viz: LINE,
      caps: RUSENDER_SERIES,
    },
  },
};

// Упоминания — нейтральная метрика: Δ без оценочного цвета (канон DESIGN_TOKENS).
const MENTIONS: RouteFamily<MentionsKey> = {
  source: 'tg',
  scope: 'metrics',
  keys: MENTIONS_METRIC_KEYS,
  specs: {
    'mentions-timeline': {
      id: 'mentions.timeline',
      kind: 'flow',
      unit: 'number',
      viz: LINE_BAR,
      caps: caps({ ...EXPLORER_WINDOW, compare: OFF_PREV }),
      evaluative: false,
    },
    'mentions-sources': { id: 'mentions.sources', kind: 'flow', unit: 'number', viz: LIST, caps: WINDOW_REPORT, evaluative: false },
  },
};

// Кампании — срез по нескольким сетям; окно — даты самой кампании. Единица ряда динамики
// следует выбранному режиму (?metric=: просмотры TG / охват IG / публикации).
const CAMPAIGN_WINDOW = caps({ window: 'fixed' });
const CAMPAIGN: RouteFamily<CampaignKey> = {
  source: 'multi',
  scope: 'campaign',
  keys: CAMPAIGN_METRIC_KEYS,
  specs: {
    timeline: { id: 'campaign.timeline', kind: 'flow', unit: 'number', viz: LINE_BAR, caps: CAMPAIGN_WINDOW },
    sources: { id: 'campaign.sources', kind: 'flow', unit: 'number', viz: LIST, caps: CAMPAIGN_WINDOW },
    formats: { id: 'campaign.formats', kind: 'flow', unit: 'posts', viz: ['donut'], caps: CAMPAIGN_WINDOW },
  },
};

const ROUTE_FAMILIES = [TG_CORE, TG_EXTRA, IG, MS, YM, CDEK, RUSENDER, MENTIONS, CAMPAIGN] as const;

// ── Метрики без маршрута (только виджет Главной) ──────────────────────────────────────────────

interface UnroutedSpec {
  id: MetricId;
  source: MetricIndexSource;
  kind: MetricValueKind;
  ratio?: RatioParts;
  unit: MetricUnit;
}

const UNROUTED: readonly UnroutedSpec[] = [
  { id: 'tg.erv', source: 'tg', kind: 'ratio', ratio: { num: 'engagement', den: 'views' }, unit: 'percent' },
  { id: 'tg.virality', source: 'tg', kind: 'ratio', ratio: { num: 'forwards', den: 'views' }, unit: 'percent' },
  // Карточка «Чистый прирост» Аналитики ведёт на /metrics/subscribers — своего разбора нет. OD-4.
  { id: 'tg.netGrowth', source: 'tg', kind: 'flow', unit: 'number' },
  { id: 'tg.weeklyTable', source: 'tg', kind: 'flow', unit: 'number' },
  { id: 'tg.topPosts', source: 'tg', kind: 'flow', unit: 'views' },
  // Зеркало tg.netGrowth. OD-4.
  { id: 'ig.netFollowers', source: 'ig', kind: 'flow', unit: 'number' },
  // Знаменатель — сумма дневных охватов (не охват периода, как у /metrics/ig-er).
  { id: 'ig.erv', source: 'ig', kind: 'ratio', ratio: { num: 'interactions', den: 'reachDailySum' }, unit: 'percent' },
];

// ── Каталог виджетов Главной: структура (тексты — в деталях источника) ────────────────────────

/** Виды по форме — дефолт каталога; запись может переопределить. rank/pivot у виджетов нет:
 *  резолвер не строит этих форм, мёртвых вариантов в редакторе не предлагаем. */
function vizForShape(shape: MetricShape): { defaultViz: WidgetViz; supportedViz: readonly WidgetViz[] } {
  switch (shape) {
    case 'value':
      return { defaultViz: 'kpi', supportedViz: ['kpi'] };
    case 'series':
      return { defaultViz: 'line', supportedViz: ['line', 'bar'] };
    case 'breakdown':
      return { defaultViz: 'list', supportedViz: ['list', 'bar', 'donut'] };
    case 'table':
      return { defaultViz: 'table', supportedViz: ['table'] };
  }
}

type WidgetSpec = { id: MetricId } & Omit<WidgetFacet, 'defaultViz' | 'supportedViz'> &
  Partial<Pick<WidgetFacet, 'defaultViz' | 'supportedViz'>>;

// Измерения постов TG (формат / день недели) — разбор уже раскладывает по ним (RankChart / PivotTable).
const POST_DIMS: readonly string[] = ['tg.format', 'tg.weekday'];

/** Порядок — порядок каталога (TG, IG, МС, Метрика), как его видит модалка добавления виджета. */
const WIDGET_SPECS: readonly WidgetSpec[] = [
  // ── Telegram
  { id: 'tg.views', shape: 'series', category: 'engagement', dimensions: POST_DIMS, drillKey: 'views' },
  {
    id: 'tg.subscribers',
    shape: 'series',
    category: 'growth',
    seriesAgg: 'level',
    drillKey: 'subscribers',
    defaultViz: 'line',
    supportedViz: ['line'],
  },
  // Среднее существует только в дни с постами — столбцы честнее линии (владелец 2026-08-13).
  {
    id: 'tg.avgReach',
    shape: 'series',
    category: 'engagement',
    dimensions: POST_DIMS,
    drillKey: 'avgReach',
    seriesAgg: 'mean',
    defaultViz: 'bar',
    supportedViz: ['bar', 'line'],
  },
  // Дискретные постозависимые суточные суммы → столбцы (владелец 2026-08-13).
  {
    id: 'tg.reactions',
    shape: 'series',
    category: 'engagement',
    dimensions: POST_DIMS,
    drillKey: 'reactions',
    defaultViz: 'bar',
    supportedViz: ['bar', 'line'],
  },
  {
    id: 'tg.forwards',
    shape: 'series',
    category: 'engagement',
    dimensions: POST_DIMS,
    drillKey: 'forwards',
    defaultViz: 'bar',
    supportedViz: ['bar', 'line'],
  },
  { id: 'tg.er', shape: 'value', category: 'engagement', drillKey: 'er' },
  { id: 'tg.erv', shape: 'value', category: 'engagement' },
  { id: 'tg.virality', shape: 'value', category: 'engagement' },
  // OD-4 не решён — записано как есть: столбцы по умолчанию (владелец 2026-08-13), линия рисует
  // накопление за окно (resolveNetGrowth). PROJECT_MEMORY называет каноном накопительную кривую.
  { id: 'tg.netGrowth', shape: 'series', category: 'growth', defaultViz: 'bar', supportedViz: ['bar', 'line'] },
  { id: 'tg.churn', shape: 'breakdown', category: 'growth' },
  { id: 'tg.newFollowersBySource', shape: 'breakdown', category: 'audience', additive: true },
  { id: 'tg.emoji', shape: 'breakdown', category: 'content', dimensions: POST_DIMS },
  { id: 'tg.engagementComposition', shape: 'breakdown', category: 'engagement', additive: true },
  { id: 'tg.viewsByType', shape: 'breakdown', category: 'content' },
  { id: 'tg.formatPerf', shape: 'breakdown', category: 'content', dimensions: ['tg.weekday'] },
  {
    id: 'tg.weekdayViews',
    shape: 'breakdown',
    category: 'content',
    defaultViz: 'bar',
    supportedViz: ['bar', 'line'],
    dimensions: ['tg.format'],
  },
  {
    id: 'tg.postCount',
    shape: 'breakdown',
    category: 'content',
    defaultViz: 'bar',
    supportedViz: ['bar', 'line'],
    dimensions: ['tg.format'],
    additive: true,
  },
  { id: 'tg.viewsBySource', shape: 'breakdown', category: 'audience', additive: true },
  { id: 'tg.languages', shape: 'breakdown', category: 'audience' },
  { id: 'tg.sentiment', shape: 'breakdown', category: 'audience', additive: true },
  {
    id: 'tg.hours',
    shape: 'breakdown',
    category: 'audience',
    defaultViz: 'bar',
    supportedViz: ['bar', 'line'],
    additive: true,
  },
  { id: 'tg.weeklyTable', shape: 'table', category: 'engagement' },
  { id: 'tg.topPosts', shape: 'table', category: 'content' },
  // ── Instagram
  { id: 'ig.reach', shape: 'series', category: 'engagement' },
  { id: 'ig.followers', shape: 'series', category: 'growth', seriesAgg: 'level', defaultViz: 'line', supportedViz: ['line'] },
  // Зеркало tg.netGrowth — OD-4, записано как есть.
  { id: 'ig.netFollowers', shape: 'series', category: 'growth', defaultViz: 'bar', supportedViz: ['bar', 'line'] },
  { id: 'ig.erv', shape: 'value', category: 'engagement' },
  // Счётный поток → столбцы (владелец 2026-08-13).
  { id: 'ig.interactions', shape: 'series', category: 'engagement', defaultViz: 'bar', supportedViz: ['bar', 'line'] },
  { id: 'ig.formats', shape: 'breakdown', category: 'content' },
  { id: 'ig.age', shape: 'breakdown', category: 'audience', defaultViz: 'bar', supportedViz: ['bar', 'list', 'donut'] },
  { id: 'ig.gender', shape: 'breakdown', category: 'audience' },
  { id: 'ig.countries', shape: 'breakdown', category: 'audience', defaultViz: 'donut', supportedViz: ['donut', 'list', 'bar'] },
  { id: 'ig.cities', shape: 'breakdown', category: 'audience' },
  { id: 'ig.hours', shape: 'breakdown', category: 'audience', defaultViz: 'bar', supportedViz: ['bar', 'line'] },
  // ── МойСклад (деньги за день дискретны — столбцы, владелец 2026-08-13)
  { id: 'ms.revenue', shape: 'series', category: 'growth', drillTo: '/sklad', defaultViz: 'bar', supportedViz: ['bar', 'line'] },
  { id: 'ms.orders', shape: 'series', category: 'growth', drillTo: '/sklad', defaultViz: 'bar', supportedViz: ['bar', 'line'] },
  // Средний чек — ratio, но корзины виджета сегодня берут последний день (PERIOD-6).
  { id: 'ms.avgCheck', shape: 'series', category: 'growth', drillTo: '/sklad', bucketAggOverride: 'level' },
  // ── Яндекс.Метрика
  { id: 'ym.visits', shape: 'series', category: 'growth', drillTo: '/metrika' },
  { id: 'ym.users', shape: 'series', category: 'growth', drillTo: '/metrika' },
  { id: 'ym.pageviews', shape: 'series', category: 'growth', drillTo: '/metrika' },
];

function widgetFacet(spec: WidgetSpec): WidgetFacet {
  const { id: _id, ...rest } = spec;
  const auto = vizForShape(spec.shape);
  return { ...rest, defaultViz: spec.defaultViz ?? auto.defaultViz, supportedViz: spec.supportedViz ?? auto.supportedViz };
}

// ── Сборка ───────────────────────────────────────────────────────────────────────────────────

function buildEntries(): MetricIndexEntry[] {
  const entries: MetricIndexEntry[] = [];
  const facets = new Map(WIDGET_SPECS.map((spec) => [spec.id, widgetFacet(spec)]));
  const withWidget = (entry: MetricIndexEntry): MetricIndexEntry => {
    const widget = facets.get(entry.id);
    return widget ? { ...entry, widgetId: entry.id, widget } : entry;
  };
  for (const family of ROUTE_FAMILIES) {
    const specs: Record<string, RouteSpec> = family.specs;
    for (const key of family.keys) {
      const spec = specs[key];
      entries.push(
        withWidget({
          id: spec.id,
          route: { scope: family.scope, key },
          source: family.source,
          kind: spec.kind,
          ...(spec.ratio ? { ratio: spec.ratio } : {}),
          unit: spec.unit,
          supportedViz: spec.viz,
          capabilities: spec.caps,
          zeroBased: spec.kind !== 'stock',
          evaluative: spec.evaluative ?? true,
        }),
      );
    }
  }
  for (const spec of UNROUTED) {
    entries.push(
      withWidget({
        id: spec.id,
        route: null,
        source: spec.source,
        kind: spec.kind,
        ...(spec.ratio ? { ratio: spec.ratio } : {}),
        unit: spec.unit,
        supportedViz: facets.get(spec.id)?.supportedViz ?? [],
        capabilities: NO_CAPABILITIES,
        zeroBased: spec.kind !== 'stock',
        evaluative: true,
      }),
    );
  }
  return entries;
}

/** Все записи: семьи маршрутов в порядке диспетчера, затем метрики без маршрута. */
export const METRIC_INDEX_ENTRIES: readonly MetricIndexEntry[] = buildEntries();

/** id → запись (plan API `metricIndex`). */
export const METRIC_INDEX: Readonly<Record<MetricId, MetricIndexEntry>> = Object.fromEntries(
  METRIC_INDEX_ENTRIES.map((entry) => [entry.id, entry]),
);

/** Widget ids в порядке каталога виджетов. */
export const WIDGET_METRIC_IDS: readonly MetricId[] = WIDGET_SPECS.map((spec) => spec.id);

const BY_ID = new Map(METRIC_INDEX_ENTRIES.map((entry) => [entry.id, entry]));
const BY_ROUTE = new Map(
  METRIC_INDEX_ENTRIES.flatMap((entry) => (entry.route ? [[`${entry.route.scope}:${entry.route.key}`, entry] as const] : [])),
);

export function metricEntry(id: string | null | undefined): MetricIndexEntry | undefined {
  return id == null ? undefined : BY_ID.get(id);
}

/** Путь полного разбора: `/metrics/<key>`; null — у метрики нет своего маршрута или он требует
 *  контекста (разбор кампании живёт под `/campaigns/:id`, см. campaignMetricPath). */
export function metricRoute(id: MetricId): string | null {
  const route = metricEntry(id)?.route;
  return route?.scope === 'metrics' ? `/metrics/${route.key}` : null;
}

/** Запись по ключу маршрута. */
export function metricByRoute(
  key: string | null | undefined,
  scope: MetricRouteRef['scope'] = 'metrics',
): MetricIndexEntry | undefined {
  return key == null ? undefined : BY_ROUTE.get(`${scope}:${key}`);
}

export function kindOf(id: MetricId): MetricValueKind | undefined {
  return metricEntry(id)?.kind;
}

export function capabilitiesOf(id: MetricId): MetricCapabilities | undefined {
  return metricEntry(id)?.capabilities;
}
