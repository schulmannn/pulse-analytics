import { fmt } from '@/lib/format';
import { parseContentPeriod, serializeContentPeriod } from '@/lib/contentFilters';
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

/** «DD.MM» label from a YYYY-MM-DD ISO day. */
export function ddmmFromIso(iso: string): string {
  const parts = iso.split('-');
  return parts.length === 3 ? `${parts[2]}.${parts[1]}` : iso;
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
      labels: curDays.map(ddmmFromIso),
      titles: curDays.map((d) => {
        const c = curMap.get(d);
        return `${ddmmFromIso(d)}: ${fmt.num(c?.mentions ?? 0)} упом · ${fmt.short(c?.views ?? 0)} просм`;
      }),
    };
  }

  if (days === 0) {
    const sorted = [...daily].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
    return {
      values: sorted.map((p) => p.mentions),
      labels: sorted.map((p) => ddmmFromIso(p.day)),
      titles: sorted.map((p) => `${ddmmFromIso(p.day)}: ${fmt.num(p.mentions)} упом · ${fmt.short(p.views)} просм`),
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
    labels: curDays.map(ddmmFromIso),
    titles: curDays.map((d) => {
      const c = curMap.get(d);
      return `${ddmmFromIso(d)}: ${fmt.num(c?.mentions ?? 0)} упом · ${fmt.short(c?.views ?? 0)} просм`;
    }),
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
