import { fmt } from '@/lib/format';
import { parseContentPeriod, serializeContentPeriod } from '@/lib/contentFilters';
import { CHART_MAX_POINTS, lttbDownsample } from '@/lib/downsample';
import { bucketKeyOf } from '@/lib/metricSeries';
import { pickIndexes } from '@/lib/msSeries';
import type { PeriodDays } from '@/lib/period';
import type { SortOrder } from '@/lib/contentFilters';

/**
 * URL-BACKED MENTIONS FILTERS + pure view model for the desktop «Упоминания» surface. Like
 * lib/contentFilters, this module is the single, testable owner of the reproducible view state:
 *   period=7|30|90|all · source=<mentioning channel_id> · q=<text> · sort=date|views|source · order=asc|desc
 * Defaults are OMITTED from the URL and every param normalises safely to its default on garbage,
 * so a hand-edited or stale deep link can never wedge the page. Beyond the filters it also holds the
 * period-comparison timeline builder (ghost = previous equal window, aligned by ordinal day), the
 * derived «Контекст периода» insights and the table filter/sort — all pure so the whole
 * parse → scope → render pipeline is unit-testable end to end.
 */

export type MentionsSort = 'date' | 'views' | 'source';

export interface MentionsFilters {
  period: PeriodDays;
  /** Mentioning external channel_id (bigint string), or '' for «все». Server-authoritative scope. */
  source: string;
  q: string;
  sort: MentionsSort;
  order: SortOrder;
}

export const MENTIONS_DEFAULTS: MentionsFilters = {
  period: 30,
  source: '',
  q: '',
  sort: 'date',
  order: 'desc',
};

const SORT_KEYS: ReadonlySet<string> = new Set<MentionsSort>(['date', 'views', 'source']);

/** A positive-bigint mentioning channel_id, or '' when the raw value is missing/garbage. */
function normalizeSource(raw: string | null | undefined): string {
  if (!raw || !/^\d+$/.test(raw)) return '';
  const normalized = raw.replace(/^0+(?=\d)/, '');
  return normalized === '0' ? '' : normalized;
}

/** Parse all five params. Every field normalises to its default — the result is always valid. */
export function parseMentionsFilters(params: URLSearchParams): MentionsFilters {
  const rawSort = params.get('sort');
  const rawOrder = params.get('order');
  return {
    period: parseContentPeriod(params.get('period')),
    source: normalizeSource(params.get('source')),
    q: params.get('q') ?? '',
    sort: rawSort && SORT_KEYS.has(rawSort) ? (rawSort as MentionsSort) : MENTIONS_DEFAULTS.sort,
    order: rawOrder === 'asc' ? 'asc' : MENTIONS_DEFAULTS.order,
  };
}

/**
 * Write a MentionsFilters onto a COPY of `prev` (preserving unrelated params), omitting every
 * default so the URL stays minimal. Merge-and-replace idiom matching lib/contentFilters.
 */
export function applyMentionsFilters(prev: URLSearchParams, filters: MentionsFilters): URLSearchParams {
  const next = new URLSearchParams(prev);

  const period = serializeContentPeriod(filters.period);
  if (period == null) next.delete('period');
  else next.set('period', period);

  const source = normalizeSource(filters.source);
  if (!source) next.delete('source');
  else next.set('source', source);

  if (filters.q.trim() === MENTIONS_DEFAULTS.q) next.delete('q');
  else next.set('q', filters.q);

  if (filters.sort === MENTIONS_DEFAULTS.sort) next.delete('sort');
  else next.set('sort', filters.sort);

  if (filters.order === MENTIONS_DEFAULTS.order) next.delete('order');
  else next.set('order', filters.order);

  return next;
}

// ── Data shapes (a loose subset of the /api/history/mentions response) ──────────────────────────
export interface MentionDailyPoint {
  day: string; // YYYY-MM-DD
  mentions: number;
  views: number;
  channels: number;
}

export interface MentionSourceOption {
  channel_id?: string | null;
  title?: string | null;
  username?: string | null;
  count: number;
  views: number;
}

export interface MentionRow {
  channel_id?: string | null;
  msg_id?: string | null;
  date?: string | null;
  title?: string | null;
  username?: string | null;
  link?: string | null;
  views?: number | null;
  snippet?: string | null;
}

// ── Period-comparison timeline (bars = discrete daily events; ghost = previous equal window) ─────
export interface MentionsTimeline {
  values: number[];
  /** Previous equal window aligned by ordinal day; undefined for all-time (no comparison). */
  ghost?: number[];
  labels: string[];
  titles: string[];
  /** ISO-дни точек текущего окна (нужны недельным корзинам capMentionsTimeline). */
  days: string[];
  /** Потенциальные просмотры по дням — той же длины, что values (кормят недельные тултипы). */
  views: number[];
}

function localIsoDay(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function shiftIsoDay(day: string, delta: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  const shifted = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + delta));
  return shifted.toISOString().slice(0, 10);
}

/**
 * Bar timeline for the surface. For 7/30/90 the calendar is zero-filled to exactly `days` bars
 * ending today, and the ghost is the immediately-preceding equal window aligned by ordinal day. For
 * all-time only the days that actually carry mentions are drawn (no giant synthetic zero-run, no
 * comparison). Missing-day zeros are honest (a discrete-event series has real gaps). `anchor` is
 * normally the server's `scope.current_to`; accepting epoch-ms keeps pure tests and offline callers
 * deterministic while avoiding a browser/server timezone split in production.
 */
export function buildMentionsTimeline(
  daily: MentionDailyPoint[],
  previousDaily: MentionDailyPoint[],
  days: PeriodDays,
  anchor: string | number = Date.now(),
  range?: { from: string; to: string } | null,
): MentionsTimeline {
  const curMap = new Map(daily.map((p) => [p.day, p]));

  // Custom range: zero-fill exactly the inclusive [from, to] calendar; the ghost is the immediately
  // preceding equal-length window aligned by ordinal day (server returns it as `previous_daily`).
  if (range && /^\d{4}-\d{2}-\d{2}$/.test(range.from) && /^\d{4}-\d{2}-\d{2}$/.test(range.to)) {
    const len =
      Math.round(
        (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86400000,
      ) + 1;
    const curDays: string[] = [];
    const prevDays: string[] = [];
    for (let i = 0; i < len; i++) {
      curDays.push(shiftIsoDay(range.from, i));
      prevDays.push(shiftIsoDay(range.from, i - len));
    }
    const prevMap = new Map(previousDaily.map((p) => [p.day, p]));
    return {
      values: curDays.map((d) => curMap.get(d)?.mentions ?? 0),
      ghost: prevDays.map((d) => prevMap.get(d)?.mentions ?? 0),
      labels: curDays.map((d) => fmt.day(d)),
      titles: curDays.map((d) => {
        const c = curMap.get(d);
        return `${fmt.day(d)}: ${fmt.num(c?.mentions ?? 0)} упом · ${fmt.short(c?.views ?? 0)} просм`;
      }),
      days: curDays,
      views: curDays.map((d) => curMap.get(d)?.views ?? 0),
    };
  }

  if (days === 0) {
    const sorted = [...daily].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    return {
      values: sorted.map((p) => p.mentions),
      labels: sorted.map((p) => fmt.day(p.day)),
      titles: sorted.map((p) => `${fmt.day(p.day)}: ${fmt.num(p.mentions)} упом · ${fmt.short(p.views)} просм`),
      days: sorted.map((p) => p.day),
      views: sorted.map((p) => p.views),
    };
  }

  const anchorDay = typeof anchor === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(anchor)
    ? anchor
    : localIsoDay(typeof anchor === 'number' ? anchor : Date.now());
  const curDays: string[] = [];
  const prevDays: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    curDays.push(shiftIsoDay(anchorDay, -i));
    prevDays.push(shiftIsoDay(anchorDay, -(i + days)));
  }
  const prevMap = new Map(previousDaily.map((p) => [p.day, p]));

  return {
    values: curDays.map((d) => curMap.get(d)?.mentions ?? 0),
    ghost: prevDays.map((d) => prevMap.get(d)?.mentions ?? 0),
    labels: curDays.map((d) => fmt.day(d)),
    titles: curDays.map((d) => {
      const c = curMap.get(d);
      return `${fmt.day(d)}: ${fmt.num(c?.mentions ?? 0)} упом · ${fmt.short(c?.views ?? 0)} просм`;
    }),
    days: curDays,
    views: curDays.map((d) => curMap.get(d)?.views ?? 0),
  };
}

/**
 * Кап длинного таймлайна ПЕРЕД рендером (канон CLAUDE.md: серии длиннее CHART_MAX_POINTS не
 * рисуются сырыми; хедлайны/дельты считаются от полного таймлайна ДО капа — он чисто визуальный).
 *
 * Линия — визуальная децимация: при ghost'е точки отбираются pickIndexes (ЕДИНЫЕ индексы для
 * обеих серий — LTTB выбрал бы разные и рассинхронизировал base↔current, канон msSeries), без
 * ghost'а форму держит LTTB. Столбцы децимировать нельзя — пропущенные дни в барах врут, —
 * поэтому дневная серия честно схлопывается в Monday-anchored календарные недели (упоминания и
 * просмотры — потоки, суммы корзин), а ghost агрегируется ТЕМИ ЖЕ индексными корзинами текущего
 * окна: cur/ghost выровнены по порядковому дню, значит корзина сохраняет выравнивание by
 * construction (в отличие от capResultSeries, где ghost дневной и отбрасывается). Маркер
 * « · неделя» в тултипе — та же честность подписи, что у seriesGrain:'week'.
 */
export function capMentionsTimeline(timeline: MentionsTimeline, kind: 'line' | 'bar'): MentionsTimeline {
  const n = timeline.values.length;
  if (n <= CHART_MAX_POINTS) return timeline;

  if (kind === 'line') {
    if (timeline.ghost && timeline.ghost.length === n) {
      const idx = pickIndexes(n, CHART_MAX_POINTS);
      return {
        values: idx.map((i) => timeline.values[i]),
        ghost: idx.map((i) => timeline.ghost![i]),
        labels: idx.map((i) => timeline.labels[i]),
        titles: idx.map((i) => timeline.titles[i]),
        days: idx.map((i) => timeline.days[i]),
        views: idx.map((i) => timeline.views[i]),
      };
    }
    const idx = timeline.values.map((_, i) => i);
    const sampled = lttbDownsample(idx, CHART_MAX_POINTS, (i) => timeline.values[i]);
    return {
      values: sampled.map((i) => timeline.values[i]),
      labels: sampled.map((i) => timeline.labels[i]),
      titles: sampled.map((i) => timeline.titles[i]),
      days: sampled.map((i) => timeline.days[i]),
      views: sampled.map((i) => timeline.views[i]),
    };
  }

  // Столбцы: индексные корзины по календарной неделе дня точки (Monday-anchored).
  const bucketOf = new Map<string, number[]>();
  const order: string[] = [];
  timeline.days.forEach((day, i) => {
    const ts = Date.parse(`${day}T00:00:00Z`);
    const key = Number.isFinite(ts) ? bucketKeyOf(ts, 'week') : day;
    const bucket = bucketOf.get(key);
    if (bucket) bucket.push(i);
    else {
      bucketOf.set(key, [i]);
      order.push(key);
    }
  });
  const sum = (arr: number[] | undefined, idx: number[]): number =>
    arr ? idx.reduce((acc, i) => acc + (arr[i] ?? 0), 0) : 0;
  const hasGhost = !!timeline.ghost && timeline.ghost.length === n;
  return {
    values: order.map((key) => sum(timeline.values, bucketOf.get(key)!)),
    ghost: hasGhost ? order.map((key) => sum(timeline.ghost, bucketOf.get(key)!)) : timeline.ghost,
    labels: order.map((key) => fmt.day(key)),
    titles: order.map((key) => {
      const idx = bucketOf.get(key)!;
      return `${fmt.day(key)} · неделя: ${fmt.num(sum(timeline.values, idx))} упом · ${fmt.short(sum(timeline.views, idx))} просм`;
    }),
    days: order,
    views: order.map((key) => sum(timeline.views, bucketOf.get(key)!)),
  };
}

// ── KPI comparison vs previous equal window ─────────────────────────────────────────────────────
export interface MentionsDelta {
  /** Percentage change vs the previous period; null when the previous base is zero. */
  pct: number | null;
  /** False when there is no comparable base (previous total is 0) → «нет базы». */
  hasBase: boolean;
}

/** Comparison for a KPI. Returns null when there is no previous period at all (all-time scope). */
export function mentionsDelta(current: number, previous: number | null | undefined): MentionsDelta | null {
  if (previous == null) return null;
  if (previous === 0) return { pct: null, hasBase: false };
  return { pct: ((current - previous) / previous) * 100, hasBase: true };
}

// ── «Контекст периода» derived insights (descriptive, no sentiment/AI claims) ────────────────────
export interface MentionsInsights {
  peak: { day: string; mentions: number } | null;
  topSourceLabel: string | null;
  /** Top source's share of mentions in the period (0..1), or null when there are none. */
  topSourceMentionShare: number | null;
  /** Top source's share of potential views in the period (0..1), or null. */
  topSourceViewShare: number | null;
}

function sourceLabel(s: MentionSourceOption): string {
  return s.username ? `@${s.username}` : s.title || 'Без названия';
}

export function mentionsInsights(
  daily: MentionDailyPoint[],
  sourceOptions: MentionSourceOption[],
  total: number,
  totalViews: number,
): MentionsInsights {
  const peak = daily.length
    ? daily.reduce((a, b) => (b.mentions > a.mentions || (b.mentions === a.mentions && b.day > a.day) ? b : a))
    : null;
  const top = sourceOptions[0] ?? null;
  return {
    peak: peak && peak.mentions > 0 ? { day: peak.day, mentions: peak.mentions } : null,
    topSourceLabel: top ? sourceLabel(top) : null,
    topSourceMentionShare: top && total > 0 ? top.count / total : null,
    topSourceViewShare: top && totalViews > 0 ? top.views / totalViews : null,
  };
}

// ── Table filter/sort (q client-side; source scope is server-authoritative) ──────────────────────
/** Case-insensitive q match over title / @username / snippet. Empty q matches everything. */
export function filterMentionRows(rows: MentionRow[], q: string): MentionRow[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(
    (r) =>
      (r.title ?? '').toLowerCase().includes(needle) ||
      (r.username ?? '').toLowerCase().includes(needle) ||
      (r.snippet ?? '').toLowerCase().includes(needle),
  );
}

/** Stable sort by date | views | source. Missing numeric metrics sink to the bottom either way. */
export function sortMentionRows(rows: MentionRow[], sort: MentionsSort, order: SortOrder): MentionRow[] {
  const dir = order === 'asc' ? 1 : -1;
  if (sort === 'source') {
    return [...rows].sort((a, b) => {
      const av = (a.username || a.title || '').toLowerCase();
      const bv = (b.username || b.title || '').toLowerCase();
      if (!av && !bv) return 0;
      if (!av) return 1;
      if (!bv) return -1;
      return av.localeCompare(bv) * dir;
    });
  }
  const num = (r: MentionRow): number | null => {
    if (sort === 'views') return r.views ?? null;
    const t = r.date ? Date.parse(r.date) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  return [...rows].sort((a, b) => {
    const av = num(a);
    const bv = num(b);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av - bv) * dir;
  });
}
