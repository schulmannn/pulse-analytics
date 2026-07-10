// Pure Telegram breakdown aggregators — the categorical splits (emoji / format / weekday /
// sources / languages / sentiment / hours / churn / composition) that until now lived inline in
// TgAnalytics.tsx's deriveTgAnalytics. Ported verbatim (same label maps, same math) into a pure,
// unit-testable home so the metric resolver (S3b) can produce them without importing the panel.
//
// The panel keeps its inline copies for now; migrating TgAnalytics onto these + the resolver/renderer
// is a later refactor (S12) — done here first because the live analytics page can't be verified
// locally (no authed render), so the safe move is: extract + test the logic, adopt it downstream once
// the renderer exists.

import type { NormalizedPost } from '@/lib/posts';
import type { TgFull, TgGraphs } from '@/api/schemas';
import { fmt, pluralRu } from '@/lib/format';

/** A categorical row (matches WidgetResult.breakdown / Breakdown component items). */
export interface BreakdownItem {
  label: string;
  value: number;
  display?: string;
  color?: string;
}

type ViewsSummary = NonNullable<TgFull['views_summary']>;
type LabelVal = { label?: string | null; value?: number | null };

// ── Label maps (ported from TgAnalytics) ──────────────────────────────────────────────────────
const SRC_NAMES: Record<string, string> = {
  Followers: 'Подписчики',
  URL: 'Ссылки',
  Search: 'Поиск',
  'Telegram Search': 'Поиск',
  Groups: 'Группы',
  Channels: 'Каналы',
  PM: 'Личные сообщения',
  Other: 'Прочее',
  'Shareable Chat Folders': 'Папки',
  'Shareable Folder Links': 'Папки',
};
const SENT_NAME: Record<string, string> = {
  Positive: 'Положительные',
  Other: 'Прочие',
  Negative: 'Отрицательные',
};
const SENT_COLOR: Record<string, string> = {
  Positive: 'hsl(var(--brand-verdant))',
  Other: 'hsl(var(--ink3))',
  Negative: 'hsl(var(--brand-ember))',
};
const TYPE_NAMES: Record<string, string> = {
  photo: 'Фото', video: 'Видео', poll: 'Опросы', document: 'Файлы',
  text: 'Текст', audio: 'Аудио', voice: 'Голос', link: 'Ссылки',
};
const WD_LABELS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const WD_ORDER = [1, 2, 3, 4, 5, 6, 0]; // Monday-first over JS getDay() (0 = Sunday)

// ── Post-derived breakdowns ───────────────────────────────────────────────────────────────────
/** «Реакции по эмодзи» — top-8 emoji over the given (already window-filtered) posts. */
export function emojiBreakdown(posts: NormalizedPost[]): BreakdownItem[] {
  const map: Record<string, number> = {};
  posts.forEach((p) => p.reactionsDetail.forEach((rd) => {
    if (rd.emoji) map[rd.emoji] = (map[rd.emoji] ?? 0) + rd.count;
  }));
  return Object.entries(map)
    .map(([label, value]) => ({ label, value, display: fmt.num(value) }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
}

/** «Вовлечённость по формату» — avg ERV per media type over the given posts. */
export function formatPerfBreakdown(posts: NormalizedPost[]): BreakdownItem[] {
  const g: Record<string, { n: number; ervSum: number; ervN: number }> = {};
  posts.forEach((p) => {
    const t = p.mediaType || 'text';
    (g[t] ??= { n: 0, ervSum: 0, ervN: 0 }).n++;
    if (p.erv != null) {
      g[t].ervSum += p.erv;
      g[t].ervN++;
    }
  });
  return Object.entries(g)
    .map(([t, v]) => ({ label: TYPE_NAMES[t] || t, avgErv: v.ervN ? v.ervSum / v.ervN : 0, n: v.n }))
    .filter((x) => x.n > 0 && x.avgErv > 0)
    .sort((a, b) => b.avgErv - a.avgErv)
    .map((x) => ({ label: x.label, value: x.avgErv, display: `${x.avgErv.toFixed(1)}% ERV · ${x.n} ${pluralRu(x.n, ['пост', 'поста', 'постов'])}` }));
}

/** Weekday avg-views + post-count (Monday-first) over the given posts. */
function weekdayAgg(posts: NormalizedPost[]) {
  const views = Array<number>(7).fill(0);
  const count = Array<number>(7).fill(0);
  posts.forEach((p) => {
    if (!p.date) return;
    const t = Date.parse(p.date);
    if (!Number.isFinite(t)) return;
    const day = new Date(t).getDay();
    views[day] += Number(p.reach ?? 0);
    count[day] += 1;
  });
  const avg = WD_ORDER.map((i) => (count[i] ? Math.round(views[i] / count[i]) : 0));
  const cnt = WD_ORDER.map((i) => count[i]);
  return { avg, cnt };
}

/** «По дням недели» — avg views per weekday. */
export function weekdayViewsBreakdown(posts: NormalizedPost[]): BreakdownItem[] {
  const { avg } = weekdayAgg(posts);
  return avg.map((v, i) => ({ label: WD_LABELS[i], value: v, display: fmt.num(v) }));
}

/** «Количество постов» — post count per weekday. */
export function postCountBreakdown(posts: NormalizedPost[]): BreakdownItem[] {
  const { cnt } = weekdayAgg(posts);
  return cnt.map((v, i) => ({ label: WD_LABELS[i], value: v, display: fmt.num(v) }));
}

// ── Views-summary breakdowns (period-agnostic server aggregate) ───────────────────────────────
/** «Состав вовлечённости» — reactions vs forwards vs replies. */
export function engagementComposition(vs: ViewsSummary | null | undefined): BreakdownItem[] {
  return [
    { label: 'Реакции', value: Number(vs?.total_reactions ?? 0), color: 'hsl(var(--chart-1))' },
    { label: 'Репосты', value: Number(vs?.total_forwards ?? 0), color: 'hsl(var(--chart-2))' },
    { label: 'Комментарии', value: Number(vs?.total_replies ?? 0), color: 'hsl(var(--chart-3))' },
  ]
    .filter((i) => i.value > 0)
    .map((i) => ({ ...i, display: fmt.num(i.value) }));
}

/** «Ср. охват по типу» — avg views by media type. */
export function viewsByTypeBreakdown(vs: ViewsSummary | null | undefined): BreakdownItem[] {
  const raw = vs?.avg_views_by_type;
  if (!raw) return [];
  return Object.entries(raw)
    .map(([key, value]) => ({ label: TYPE_NAMES[key] || key, value: Number(value) }))
    .filter((i) => i.value > 0)
    .sort((a, b) => b.value - a.value)
    .map((i) => ({ ...i, display: fmt.num(i.value) }));
}

// ── Graphs breakdowns (source label/value arrays + followers group) ───────────────────────────
function mapSourceItems(
  arr: LabelVal[] | null | undefined,
  mapper?: Record<string, string>,
  colorMapper?: Record<string, string>,
): BreakdownItem[] {
  if (!arr) return [];
  return arr
    .map((item) => {
      const raw = item.label ?? '';
      return {
        label: mapper ? mapper[raw] || raw : raw,
        value: Number(item.value ?? 0),
        color: colorMapper ? colorMapper[raw] : undefined,
        display: fmt.num(Number(item.value ?? 0)),
      };
    })
    .filter((i) => i.value > 0);
}

export function viewsBySourceBreakdown(graphs: TgGraphs | undefined): BreakdownItem[] {
  return mapSourceItems(graphs?.views_by_source, SRC_NAMES);
}
export function newFollowersBySourceBreakdown(graphs: TgGraphs | undefined): BreakdownItem[] {
  return mapSourceItems(graphs?.new_followers_by_source, SRC_NAMES);
}
export function languagesBreakdown(graphs: TgGraphs | undefined): BreakdownItem[] {
  return mapSourceItems(graphs?.languages)
    .sort((a, b) => b.value - a.value)
    .slice(0, 8);
}
export function sentimentBreakdown(graphs: TgGraphs | undefined): BreakdownItem[] {
  return mapSourceItems(graphs?.reactions_sentiment, SENT_NAME, SENT_COLOR);
}

/** «Активность по часам» — views per hour of day. */
export function hoursBreakdown(graphs: TgGraphs | undefined): BreakdownItem[] {
  const th = graphs?.top_hours;
  if (!th || !th.values?.length) return [];
  return th.values.map((v, i) => {
    const hour = th.hours?.[i] ?? i;
    return { label: `${hour}:00`, value: Number(v), display: fmt.num(Number(v)) };
  });
}

/** «Чистый прирост подписчиков» — net daily = joined − left, dated from the followers graph x-axis.
 *  A flow series (the resolver buckets/sums it); returns [] when the graph has no follower series. */
export function netGrowthPoints(graphs: TgGraphs | undefined): { day: string; value: number }[] {
  const g = graphs?.followers;
  const series = g?.series ?? [];
  const joined = series.find((s) => /join|подпис/i.test(s.name ?? '')) || series[0];
  const left = series.find((s) => /left|отпис/i.test(s.name ?? '')) || series[1];
  const x = g?.x ?? [];
  if (!joined || !left) return [];
  const n = Math.min(joined.values.length, left.values.length, x.length);
  const out: { day: string; value: number }[] = [];
  for (let i = 0; i < n; i++) {
    const ts = x[i];
    if (ts == null || !Number.isFinite(ts)) continue;
    out.push({ day: new Date(ts).toISOString(), value: Number(joined.values[i] ?? 0) - Number(left.values[i] ?? 0) });
  }
  return out;
}

/** «Динамика оттока» — joined vs left totals over the followers graph window. */
export function churnBreakdown(graphs: TgGraphs | undefined): BreakdownItem[] {
  const series = graphs?.followers?.series ?? [];
  const joined = series.find((s) => /join|подпис/i.test(s.name ?? '')) || series[0];
  const left = series.find((s) => /left|отпис/i.test(s.name ?? '')) || series[1];
  if (!joined || !left) return [];
  const n = Math.min(joined.values.length, left.values.length);
  let joinedTotal = 0;
  let leftTotal = 0;
  for (let i = 0; i < n; i++) {
    joinedTotal += Number(joined.values[i] ?? 0);
    leftTotal += Number(left.values[i] ?? 0);
  }
  return [
    { label: 'Подписалось', value: joinedTotal, display: fmt.num(joinedTotal), color: 'hsl(var(--brand-verdant))' },
    { label: 'Отписалось', value: leftTotal, display: fmt.num(leftTotal), color: 'hsl(var(--brand-ember))' },
  ].filter((i) => i.value > 0);
}
