// Instagram Analytics → long-form export rows. Instagram returns the engagement metrics
// (views/interactions/likes/saves/…) as period TOTALS, and reach as a DEDUPED window total — none of
// them is a summable daily series, so this export is strictly aggregate: one `current` row per metric
// (plus one `previous` row when the equal preceding window is calculable), NEVER a fabricated daily
// value. It reads the already-windowed pairs from igWindowMetrics, so it reflects the exact top-bar
// window and can never leak the full ig.series history the old exporter dumped.
import { toYmd, type AnalyticsRow } from '@/lib/analyticsExport';

/** Windowed current/previous pair (subset of igMetrics.WindowPair). */
export interface ExportPair {
  cur: number;
  prev: number;
  hasCur: boolean;
  hasPrev: boolean;
}

export interface IgAnalyticsExportInput {
  source: string;
  window: { since: number; until: number };
  pairs: {
    reach: ExportPair;
    views: ExportPair;
    ti: ExportPair;
    likes: ExportPair;
    saves: ExportPair;
    comments: ExportPair;
    shares: ExportPair;
  };
  /** Net follower movement (follows − unfollows) over the window. */
  netMovement: ExportPair;
  /** Engagement rate on reach, already computed as a percentage (0 when unavailable). */
  erReach: number;
  erReachPrev: number;
}

interface MetricDef {
  metric: string;
  unit: string;
  pair: ExportPair;
}

/** Build aggregate long-form rows for the current window (+ previous window where present). */
export function buildIgAnalyticsRows(input: IgAnalyticsExportInput): AnalyticsRow[] {
  const { source, window, pairs, netMovement, erReach, erReachPrev } = input;
  const currentBounds = { from: toYmd(window.since), to: toYmd(window.until) };
  // Keep these bounds identical to igMetrics.windowPair, which produced the pairs below.
  const previousSpan = Math.max(window.until - window.since, 24 * 60 * 60 * 1000);
  const previousBounds = {
    from: toYmd(window.since - previousSpan),
    to: toYmd(window.since - 1),
  };

  const defs: MetricDef[] = [
    // Reach and views are DIFFERENT metrics and neither equals a publication view — kept distinct.
    { metric: 'Охват', unit: 'охват', pair: pairs.reach },
    { metric: 'Просмотры', unit: 'просмотры', pair: pairs.views },
    { metric: 'Взаимодействия', unit: 'взаимодействия', pair: pairs.ti },
    { metric: 'Лайки', unit: 'лайки', pair: pairs.likes },
    { metric: 'Сохранения', unit: 'сохранения', pair: pairs.saves },
    { metric: 'Комментарии', unit: 'комментарии', pair: pairs.comments },
    { metric: 'Репосты', unit: 'репосты', pair: pairs.shares },
    { metric: 'Чистый прирост подписчиков', unit: 'подписчики', pair: netMovement },
  ];

  const rows: AnalyticsRow[] = [];
  const { from, to } = currentBounds;
  const base = { network: 'instagram' as const, source, section: 'Аналитика', from, to };
  for (const def of defs) {
    if (!def.pair.hasCur) continue; // honest: no value → no row (never a fabricated 0)
    rows.push({ ...base, scope: 'current', metric: def.metric, value: def.pair.cur, unit: def.unit });
    if (def.pair.hasPrev) {
      rows.push({ ...base, ...previousBounds, scope: 'previous', metric: def.metric, value: def.pair.prev, unit: def.unit });
    }
  }

  // A real 0% ER is data, not absence. Availability comes from both source pairs; reach must be
  // positive because division by a missing/zero denominator is not a metric.
  const hasCurrentEr = pairs.reach.hasCur && pairs.reach.cur > 0 && pairs.ti.hasCur;
  const hasPreviousEr = pairs.reach.hasPrev && pairs.reach.prev > 0 && pairs.ti.hasPrev;
  if (hasCurrentEr) {
    rows.push({ ...base, scope: 'current', metric: 'ER (охват)', value: erReach, unit: '%' });
    if (hasPreviousEr) {
      rows.push({ ...base, ...previousBounds, scope: 'previous', metric: 'ER (охват)', value: erReachPrev, unit: '%' });
    }
  }
  return rows;
}
