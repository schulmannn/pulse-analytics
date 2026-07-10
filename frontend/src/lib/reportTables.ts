import type { CSSProperties } from 'react';
import type { HistoryData } from '@/api/schemas';
import { fmt } from '@/lib/format';

export const DAY_MS = 24 * 60 * 60 * 1000;

type HistoryRow = HistoryData['rows'][number];

/** Monday-start UTC week key for a YYYY-MM-DD day (date-only strings parse as UTC midnight). */
function mondayKey(dayISO: string): string | null {
  const t = Date.parse(dayISO);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

interface WeeklyTable {
  weeks: { key: string; label: string }[];
  rows: { label: string; signed?: boolean; values: (number | null)[] }[];
}

/**
 * Weekly rollup of the daily archive for the heat-shaded table (steep Reports' signature
 * visual): volume metrics sum per week, the subscriber row is the within-week change.
 */
export function buildWeeklyTable(rows: HistoryRow[]): WeeklyTable | null {
  const byWeek = new Map<string, HistoryRow[]>();
  for (const row of rows) {
    const key = mondayKey(row.day);
    if (!key) continue;
    const bucket = byWeek.get(key);
    if (bucket) bucket.push(row);
    else byWeek.set(key, [row]);
  }
  const keys = [...byWeek.keys()].sort().slice(-6);
  if (keys.length < 2) return null;

  const sumOf = (week: HistoryRow[], pick: (r: HistoryRow) => number | null | undefined): number | null => {
    let sum = 0;
    let has = false;
    for (const r of week) {
      const v = pick(r);
      if (v == null) continue;
      sum += Number(v);
      has = true;
    }
    return has ? sum : null;
  };
  const subsDelta = (week: HistoryRow[]): number | null => {
    const subs = week
      .filter((r) => r.subscribers != null)
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((r) => Number(r.subscribers));
    return subs.length >= 2 ? subs[subs.length - 1] - subs[0] : null;
  };

  const weekRows = keys.map((k) => byWeek.get(k)!);
  return {
    weeks: keys.map((k) => ({ key: k, label: fmt.day(k) })),
    rows: [
      { label: 'Просмотры', values: weekRows.map((w) => sumOf(w, (r) => r.views)) },
      { label: 'Реакции', values: weekRows.map((w) => sumOf(w, (r) => r.reactions)) },
      { label: 'Репосты', values: weekRows.map((w) => sumOf(w, (r) => r.forwards)) },
      { label: 'Подписчики, Δ', signed: true, values: weekRows.map(subsDelta) },
    ],
  };
}

/**
 * Data-driven cell shading (chart-class paint, hence inline hsl like the SVG fills): the alpha
 * ramps with the value's share of the row max — verdant for volume/growth, ember for losses.
 */
export function cellTint(value: number | null, rowMax: number, signed?: boolean): CSSProperties | undefined {
  if (value == null || rowMax <= 0) return undefined;
  const alpha = 0.05 + 0.3 * Math.min(Math.abs(value) / rowMax, 1);
  const token = signed && value < 0 ? '--brand-ember' : '--brand-verdant';
  return { backgroundColor: `hsl(var(${token}) / ${alpha.toFixed(3)})` };
}
