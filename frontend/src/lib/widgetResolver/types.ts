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
  value: number;
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
  value?: string;
  valueRaw?: number;
  delta?: MetricDelta | null;
  caption?: string | null;
  series?: WidgetSeriesPoint[];
  ghost?: number[];
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
    visits: { total: number; series: Array<{ day: string; value: number }> };
    users: { total: number; series: Array<{ day: string; value: number }> };
    pageviews: { total: number; series: Array<{ day: string; value: number }> };
  } | null;
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
