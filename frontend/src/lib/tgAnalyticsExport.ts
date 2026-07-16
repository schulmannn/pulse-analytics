// Telegram Analytics → long-form export rows. Only genuinely daily, additive flows are exported —
// channel views, reposts and the net follower flow — so every value is a real per-day observation
// that can be summed. Windowing goes through splitCalendarRows, the same primitive the charts use, so
// the export honours the exact top-bar window (preset OR custom «Свой») and only emits a `previous`
// window when the archive actually reaches back far enough (never fabricated).
import type { TgGraphs } from '@/api/schemas';
import { previousCalendarWindow, splitCalendarRows, type CalendarWindow } from '@/lib/period';
import { toYmd, type AnalyticsRow } from '@/lib/analyticsExport';

export interface TgDailySeries {
  metric: string;
  unit: string;
  values: number[];
  /** Epoch-ms x for each value; misaligned/short arrays yield NaN → the point is dropped. */
  x: number[];
}

export interface TgAnalyticsExportInput {
  source: string;
  /** Exact top-bar window; `null` = «Всё» (no previous window). */
  window: CalendarWindow | null;
  series: TgDailySeries[];
}

/**
 * Derive the exportable daily series straight from the graphs payload — decoupled from the analytics
 * panel so export correctness never depends on component render state. Names are matched explicitly
 * (view/share via provider labels, net = joined − left); an unknown series is omitted, never relabelled.
 */
export function tgDailySeriesFromGraphs(graphs: TgGraphs | undefined): TgDailySeries[] {
  const inter = graphs?.interactions;
  const interSeries = inter?.series ?? [];
  const interX = inter?.x ?? [];
  const viewSeries = interSeries.find((s) => /view|просмотр/i.test(s.name ?? ''));
  const shareSeries = interSeries.find((s) => /share|forward|репост|пересыл/i.test(s.name ?? ''));

  const followers = graphs?.followers;
  const fSeries = followers?.series ?? [];
  const fx = followers?.x ?? [];
  const joined = fSeries.find((s) => /join|подпис/i.test(s.name ?? ''));
  const left = fSeries.find((s) => /left|отпис/i.test(s.name ?? ''));

  const out: TgDailySeries[] = [];
  // Channel-level daily views (GetMessageStats views_graph — incremental daily). Named explicitly so
  // the export never reads as publication views (they are different metrics — PROJECT_MEMORY).
  if (viewSeries) out.push({ metric: 'Просмотры канала', unit: 'просмотры', values: viewSeries.values, x: interX });
  if (shareSeries) out.push({ metric: 'Репосты', unit: 'репосты', values: shareSeries.values, x: interX });
  if (joined && left) {
    const n = Math.min(joined.values.length, left.values.length);
    const net = Array.from({ length: n }, (_, i) => Number(joined.values[i] ?? 0) - Number(left.values[i] ?? 0));
    out.push({ metric: 'Чистый прирост подписчиков', unit: 'подписчики', values: net, x: fx });
  }
  return out;
}

/** Build the long-form analytics rows for the current window (and the equal previous window where
    the archive covers it). Returns [] when nothing falls inside the window. */
export function buildTgAnalyticsRows(input: TgAnalyticsExportInput): AnalyticsRow[] {
  const { source, window, series } = input;

  // Current bounds come from the top bar; «Всё» uses the observed data extent. Previous rows below
  // carry the actual equal-previous bounds rather than repeating the current dates.
  const allTimestamps: number[] = [];
  for (const s of series) {
    for (const t of s.x) if (Number.isFinite(t)) allTimestamps.push(Number(t));
  }
  const fromMs = window ? window.from : allTimestamps.length ? Math.min(...allTimestamps) : undefined;
  const toMs = window ? window.to : allTimestamps.length ? Math.max(...allTimestamps) : undefined;
  const currentBounds = {
    from: fromMs != null ? toYmd(fromMs) : '',
    to: toMs != null ? toYmd(toMs) : '',
  };
  const previousWindow = window ? previousCalendarWindow(window) : null;
  const previousBounds = previousWindow
    ? { from: toYmd(previousWindow.from), to: toYmd(previousWindow.to) }
    : null;

  const rows: AnalyticsRow[] = [];
  const emit = (points: { value: number; timestamp: number }[], scope: 'current' | 'previous', metric: string, unit: string) => {
    const bounds = scope === 'previous' && previousBounds ? previousBounds : currentBounds;
    for (const point of points) {
      if (!Number.isFinite(point.timestamp) || !Number.isFinite(point.value)) continue;
      rows.push({
        network: 'telegram',
        source,
        section: 'Аналитика',
        scope,
        ...bounds,
        date: toYmd(point.timestamp),
        metric,
        value: point.value,
        unit,
      });
    }
  };

  for (const s of series) {
    const dated = s.values.map((value, index) => ({ value: Number(value ?? 0), timestamp: Number(s.x[index] ?? Number.NaN) }));
    const split = splitCalendarRows(dated, window, (row) => row.timestamp);
    emit(split.current, 'current', s.metric, s.unit);
    if (split.previous) emit(split.previous, 'previous', s.metric, s.unit);
  }
  return rows;
}
