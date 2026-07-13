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
  network?: 'tg' | 'ig';
  sourceLabel?: string;
  periodLabel?: string;
  samplePosts?: number;
  archiveDays?: number;
  fresh?: Freshness;
  comparisonNote?: string;
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

export interface DataContext {
  now: number;
  days: PeriodDays;
  range: DateRange | null;
  inRange: (dateISO: string | null | undefined) => boolean;
  tg?: TgDataContext;
  ig?: IgDataContext;
}

export type WidgetMetricResolver = (
  metric: MetricDef,
  config: WidgetConfig,
  ctx: DataContext,
  out: WidgetResult,
) => WidgetResult;
