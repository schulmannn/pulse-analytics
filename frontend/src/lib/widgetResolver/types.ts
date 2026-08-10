import type {
  ChannelsResponse,
  HistoryData,
  IgBreakdowns,
  IgHistoryData,
  IgInsights,
  IgOnline,
  IgProfile,
  TgFull,
  TgGraphs,
} from '@/api/schemas';
import type { MetricDelta } from '@/lib/delta';
import type { Freshness } from '@/lib/freshness';
import type { DateRange, PeriodDays } from '@/lib/period';
import type { MetricDef, MetricKind, MetricUnit } from '@/lib/widgetMetrics';
import type { WidgetConfig } from '@/lib/widgetConfig';

export interface WidgetSeriesPoint {
  date: string;
  /**
   * `null` = ИЗМЕРЕНИЯ НЕТ (пропуск сбора в дневном архиве) — линия несёт разрыв, тултип честно
   * говорит «данных нет». Это НЕ то же самое, что ноль: реальный ноль (день без публикаций у
   * post-derived метрики) остаётся нулём и разрывом не считается (инвариант PROJECT_MEMORY).
   * Все производные — «Макс/Среднее», ghost, target, недельные корзины, LTTB — обязаны пропуск
   * ПРОПУСКАТЬ, а не подставлять 0, иначе он вернётся ложным нулём через чёрный ход.
   */
  value: number | null;
}

export interface WidgetBreakdownItem {
  label: string;
  value: number;
  display?: string;
  color?: string;
}

export interface WidgetLedgerRow {
  label: string;
  value: string;
}

export interface WidgetMeta {
  network?: 'tg' | 'ig' | 'ms' | 'ym';
  sourceLabel?: string;
  periodLabel?: string;
  samplePosts?: number;
  archiveDays?: number;
  fresh?: Freshness;
  comparisonNote?: string;
  /** Серия агрегирована по неделям (длинные бары) — рендер добавляет « · неделя» в тултипы. */
  seriesGrain?: 'week';
}

export interface WidgetResult {
  metricId: string;
  kind: MetricKind;
  unit: MetricUnit;
  /**
   * Единица РЯДА, когда она отличается от единицы хедлайна. Так бывает у метрик-отношений: у
   * `tg.er` хедлайн — проценты, а под ним рисуется величина, ИЗ КОТОРОЙ он посчитан (абсолютные
   * вовлечения). Без этого поля формат хедлайна применялся к ряду и тултип печатал «431.0%» —
   * подпись, которой не соответствует ни одно число на графике. Тот же приём давно применяет
   * MetricPage («ratio metrics … chart shows that underlying sum, not the ratio itself»).
   * Не задано — ряд форматируется как `unit`.
   */
  seriesUnit?: MetricUnit;
  value?: string;
  valueRaw?: number;
  delta?: MetricDelta | null;
  caption?: string | null;
  series?: WidgetSeriesPoint[];
  /** Сравнительная серия. Как и `series`, `null` = пропуск, а не ноль (LineChart рисует разрыв). */
  ghost?: Array<number | null>;
  ghostLabel?: string;
  /** «Макс/Среднее» от ПОЛНОЙ серии, посчитанные до визуального капа (LTTB оставляет экстремумы —
   *  среднее по прореженной выборке смещено вверх). Рендер предпочитает их пересчёту по series. */
  stats?: { max: number; avg: number };
  breakdown?: WidgetBreakdownItem[];
  rows?: WidgetLedgerRow[];
  target?: number;
  targetPct?: number;
  empty?: boolean;
  meta?: WidgetMeta;
}

export interface TgDataContext {
  full?: TgFull;
  history?: HistoryData;
  channels?: ChannelsResponse;
  graphs?: TgGraphs;
  channelId: number | null;
}

export interface IgDataContext {
  profile?: IgProfile;
  insights?: IgInsights;
  breakdowns?: IgBreakdowns;
  online?: IgOnline;
  history?: IgHistoryData;
}

/** Данные МойСклада для резолвера. Структурная копия ответа /api/ms/summary (queries.ts):
 *  серии УЖЕ нарезаны сервером под окно виджета (в отличие от IG, где окно режется на клиенте),
 *  суммы уже в рублях. */
export interface MsDataContext {
  summary?: {
    revenue: { total: number; series: Array<{ day: string; value: number }> };
    orders: { totalCount: number; totalSum: number; series: Array<{ day: string; count: number; sum: number }> };
  } | null;
}

/** Данные Яндекс.Метрики для резолвера. Структурная копия ответа /api/ym/summary (queries.ts):
 *  серии УЖЕ нарезаны сервером под окно виджета (зеркало MsDataContext). */
export interface YmDataContext {
  summary?: {
    visits: YmSummaryBlock;
    users: YmSummaryBlock;
    pageviews: YmSummaryBlock;
  } | null;
}

/** total nullable — пропуск сбора, а не ноль (см. buildSummary в server/routes/metrika.js).
    Резолвер до него не доходит: пустая серия отсекается раньше как `empty`. */
interface YmSummaryBlock {
  total: number | null;
  series: Array<{ day: string; value: number }>;
}

export interface DataContext {
  now: number;
  days: PeriodDays;
  range: DateRange | null;
  inRange: (dateISO: string | null | undefined) => boolean;
  tg?: TgDataContext;
  ig?: IgDataContext;
  ms?: MsDataContext;
  ym?: YmDataContext;
}

export type WidgetMetricResolver = (
  metric: MetricDef,
  config: WidgetConfig,
  ctx: DataContext,
  out: WidgetResult,
) => WidgetResult;
