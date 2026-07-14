// Pure view-model for the /reports index — kept React-free so the label/filter logic is
// unit-testable and shared between the desktop table and (potential) other surfaces. The list
// row carries only compact summary facts (server-extracted from the JSONB config); everything
// here degrades gracefully for legacy rows that predate those fields.
import type { ReportListItem } from '@/api/schemas';

// The fallback period applied when a report has no persisted periodDays — mirrors the document's
// own default (30д) so the index never invents a period the reader wouldn't see on open.
export const REPORT_DEFAULT_PERIOD_DAYS = 30;

export type ReportListFilter = 'all' | 'delivery';

const SCHEDULE_LABELS: Record<string, string> = {
  none: '—',
  weekly: 'Раз в неделю',
  monthly: 'Раз в месяц',
};

/** «7д / 30д / 90д / Всё» — honest fallback to the document default when unset. */
export function reportPeriodLabel(periodDays: number | null | undefined): string {
  const d = periodDays == null ? REPORT_DEFAULT_PERIOD_DAYS : periodDays;
  if (d === 0) return 'Всё';
  if (d === 7 || d === 30 || d === 90) return `${d}д`;
  // Unknown value → still show something truthful rather than a bare number.
  return d > 0 ? `${d}д` : `${REPORT_DEFAULT_PERIOD_DAYS}д`;
}

/** Block count → «N» / «Базовый набор» (legacy row: no blocks array = the default set) / «—» (emptied). */
export function reportBlockCountLabel(blockCount: number | null | undefined): string {
  if (blockCount == null) return 'Базовый набор';
  if (blockCount <= 0) return '—';
  return String(blockCount);
}

/** Delivery (schedule) label — «Доставка» language, never «Выгрузка». */
export function reportDeliveryLabel(schedule: string | null | undefined): string {
  return SCHEDULE_LABELS[schedule ?? 'none'] ?? '—';
}

export function reportHasDelivery(item: Pick<ReportListItem, 'schedule'>): boolean {
  return (item.schedule ?? 'none') !== 'none';
}

/**
 * Filter + search the index rows. `sourceLabelOf` resolves a row's channel_id to a human name
 * (so search matches the visible source too); rows keep their server order (updated_at DESC).
 */
export function filterReports(
  items: ReportListItem[],
  opts: { query?: string; filter?: ReportListFilter; sourceLabelOf?: (item: ReportListItem) => string },
): ReportListItem[] {
  const q = (opts.query ?? '').trim().toLowerCase();
  const filter = opts.filter ?? 'all';
  return items.filter((item) => {
    if (filter === 'delivery' && !reportHasDelivery(item)) return false;
    if (!q) return true;
    const haystack = `${item.name} ${opts.sourceLabelOf?.(item) ?? ''}`.toLowerCase();
    return haystack.includes(q);
  });
}
