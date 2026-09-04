import { lttbDownsample } from '@/lib/downsample';
import { freshness, latestDataMs } from '@/lib/freshness';
import {
  DAY_MS,
  bucketKeyOf,
  bucketKeysInWindow,
  comparisonWindow,
} from '@/lib/metricSeries';
import type { SeriesGrain } from '@/lib/metricSeries';
import { CHART_MAX_POINTS, pickIndexes } from '@/lib/msSeries';
import type { NormalizedPost } from '@/lib/posts';
import type { PostMetricField } from '@/lib/kpiDerive';
import type { ComparisonConfig, ComparisonMode, WidgetConfig, WidgetGrain } from '@/lib/widgetConfig';
import type { SeriesAggregation, WidgetViz } from '@/lib/widgetMetrics';
import type { DataContext, WidgetMeta, WidgetResult, WidgetSeriesPoint } from '@/lib/widgetResolver/types';

export const COMPARISON_LABEL: Record<ComparisonMode, string> = {
  none: '',
  previous_period: 'прошлый период',
  same_period_last_month: 'прошлый месяц',
  same_period_last_year: 'год назад',
  same_weekday: 'типичный день недели',
  moving_average: 'скользящее среднее',
  custom: 'выбранный период',
};

function shiftMonthsUTC(ms: number, months: number): number {
  const d = new Date(ms);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const maxDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, maxDay));
  return d.getTime();
}

export function comparisonBaseline(
  cmp: ComparisonConfig | undefined,
  winFrom: number | null,
  winTo: number,
  grain: SeriesGrain,
): { from: number; to: number } | null {
  if (!cmp || cmp.mode === 'none') return null;
  if (cmp.mode === 'custom') return cmp.from != null && cmp.to != null ? { from: cmp.from, to: cmp.to } : null;
  if (winFrom == null) return null;
  if (cmp.mode === 'previous_period') return comparisonWindow(winFrom, winTo, 'prev');
  if (cmp.mode === 'same_period_last_year') return comparisonWindow(winFrom, winTo, 'year');
  if (cmp.mode === 'same_period_last_month') {
    if (grain === 'month' || grain === 'quarter' || grain === 'year') {
      return { from: shiftMonthsUTC(winFrom, -1), to: shiftMonthsUTC(winTo, -1) };
    }
    const shift = 30 * DAY_MS;
    return { from: winFrom - shift, to: winTo - shift };
  }
  return null;
}

export function wantsGhostLine(cmp: ComparisonConfig | undefined): boolean {
  return (cmp?.display ?? 'ghost_line') !== 'delta';
}

export function effectiveGrain(grain: WidgetGrain | undefined): SeriesGrain {
  return grain === 'week' || grain === 'month' || grain === 'quarter' || grain === 'year' ? grain : 'day';
}

export function bucketPostField(
  posts: NormalizedPost[],
  field: PostMetricField,
  winFrom: number | null,
  winTo: number,
  grain: SeriesGrain,
): WidgetSeriesPoint[] {
  const by = new Map<string, number>();
  for (const post of posts) {
    if (!post.date) continue;
    const timestamp = Date.parse(post.date);
    if (!Number.isFinite(timestamp)) continue;
    const key = bucketKeyOf(timestamp, grain);
    by.set(key, (by.get(key) ?? 0) + Number(post[field] ?? 0));
  }
  const keys = winFrom != null ? bucketKeysInWindow(winFrom, winTo, grain) : [...by.keys()].sort();
  return keys.map((key) => ({ date: key, value: by.get(key) ?? 0 }));
}

/**
 * Кап длинной серии виджета перед рендером (канон CLAUDE.md: серии длиннее CHART_MAX_POINTS
 * даунсэмплятся до отрисовки, иначе суб-пиксельная мазня и дорогие кадры — окно «Всё» отдаёт
 * до 730 дневных бакетов). Вызывается ОДИН раз в generic-слое resolveWidgetMetric, строго
 * последним шагом: хедлайн/дельта/target/ghost'ы/stats уже посчитаны от ПОЛНОЙ серии — кап
 * меняет только плотность точек графика.
 *
 * Линии — визуальная децимация: ghost прореживается ТЕМИ ЖЕ индексами (pickIndexes — канон
 * msSeries для мультисерий: LTTB выбирал бы разные индексы для каждой линии и рассинхронизировал
 * base↔current); одиночной линии форму держит LTTB. labels/titles сжимаются согласованно сами:
 * рендер строит их из выбранных точек серии (widgetRender.seriesToChart).
 *
 * Столбцы (`viz === 'bar'`) децимировать нельзя — пропущенные дни в барах врут. Вместо этого
 * длинная дневная серия ЧЕСТНО агрегируется в календарные недели (Monday-anchored — та же
 * математика корзин, что у windowGraphSeries в TgAnalytics): `kind === 'flow'` суммируется,
 * `kind === 'level'` (подписчики/фолловеры — bucketSubscriberLevels-серии) берёт last-of-bucket.
 * date корзины = понедельник (bucketKeyOf(..., 'week')), так что подписи оси — даты понедельников;
 * маркер «по неделям» дописывается в meta.periodLabel (строку меты карточки). Ghost выровнен по
 * ДНЕВНЫМ индексам и после агрегации длине не соответствует — отбрасывается с честной
 * meta.comparisonNote вместо рассинхронизированной пары серий.
 */
export function capResultSeries(out: WidgetResult, viz: WidgetViz, kind: SeriesAggregation = 'flow'): WidgetResult {
  const series = out.series;
  if (!series || series.length <= CHART_MAX_POINTS) return out;
  if (viz === 'bar') {
    // Лексикографический сорт YYYY-MM-DD-ключей = хронология; для level порядок обязателен
    // (last-of-bucket), для flow безразличен. Непарсибельная дата — честно оставить как есть.
    const points = [...series].sort((a, b) => a.date.localeCompare(b.date));
    // Пропуск (value === null) НЕ участвует в корзине: для flow он не прибавляет ноль, для level
    // не становится «последним значением». Корзина, где ВСЕ дни — пропуск, сама остаётся пропуском,
    // иначе агрегация тихо родила бы ноль, которого не было.
    const by = new Map<string, number | null>();
    const meanAcc = new Map<string, { sum: number; n: number }>();
    for (const point of points) {
      const timestamp = Date.parse(point.date);
      if (!Number.isFinite(timestamp)) return out;
      const key = bucketKeyOf(timestamp, 'week');
      if (!by.has(key)) by.set(key, null);
      if (point.value == null) continue;
      const prev = by.get(key) ?? null;
      if (kind === 'level') {
        by.set(key, point.value);
      } else if (kind === 'mean') {
        // Точка ряда уже среднее (средний охват на пост) — суммировать средние нельзя, это
        // завысило бы неделю в разы. Копим сумму и счётчик, делим в конце.
        const cell = meanAcc.get(key) ?? { sum: 0, n: 0 };
        cell.sum += point.value;
        cell.n += 1;
        meanAcc.set(key, cell);
        by.set(key, cell.sum / cell.n);
      } else {
        by.set(key, (prev ?? 0) + point.value);
      }
    }
    out.series = [...by.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, value]) => ({ date, value }));
    if (out.ghost && out.ghost.length !== out.series.length) {
      out.ghost = undefined;
      out.ghostLabel = undefined;
      out.meta = { ...out.meta, comparisonNote: 'сравнение недоступно для агрегированных недель' };
    }
    out.meta = {
      ...out.meta,
      periodLabel: out.meta?.periodLabel ? `${out.meta.periodLabel} · по неделям` : 'по неделям',
      // Машинный признак для рендера: per-point тултипы обязаны нести « · неделя», иначе
      // «<дата понедельника>: значение» читается как один день (честность подписи).
      seriesGrain: 'week',
    };
    return out;
  }
  const ghost = out.ghost;
  // LTTB выбирает точки по ПЛОЩАДИ треугольников, то есть требует число в каждой точке; пропуск
  // пришлось бы чем-то заменить, и разрыв либо исчез бы (ложная непрерывность), либо провалился
  // бы в ноль. Поэтому серия с пропусками децимируется равномерными индексами — форма чуть
  // грубее, зато позиции разрывов сохраняются честно.
  const hasGaps = series.some((point) => point.value == null);
  if ((ghost && ghost.length === series.length) || hasGaps) {
    const idx = pickIndexes(series.length, CHART_MAX_POINTS);
    out.series = idx.map((i) => series[i]);
    if (ghost && ghost.length === series.length) out.ghost = idx.map((i) => ghost[i]);
  } else {
    out.series = lttbDownsample(series, CHART_MAX_POINTS, (point) => point.value ?? 0);
  }
  return out;
}

/**
 * СРЕДНЕЕ значение пост-метрики за корзину: Σ поля ÷ число постов корзины. Для «Среднего охвата
 * поста» это единственная честная форма ряда — {@link bucketPostField} даёт СУММУ дня, и на дне с
 * тремя постами столбец втрое выше охвата любого из них, хотя карточка называется «средний».
 *
 * Корзина без постов — `null`, а не ноль: среднее по пустому множеству не определено. Это НЕ тот
 * «честный ноль post-derived метрик», о котором говорит инвариант (у суммы реакций день без
 * публикаций действительно нулевой) — у отношения знаменатель просто отсутствует.
 */
export function bucketPostMean(
  posts: NormalizedPost[],
  field: PostMetricField,
  winFrom: number | null,
  winTo: number,
  grain: SeriesGrain,
): WidgetSeriesPoint[] {
  const by = new Map<string, { sum: number; count: number }>();
  for (const post of posts) {
    if (!post.date) continue;
    const timestamp = Date.parse(post.date);
    if (!Number.isFinite(timestamp)) continue;
    const key = bucketKeyOf(timestamp, grain);
    const cell = by.get(key) ?? { sum: 0, count: 0 };
    cell.sum += Number(post[field] ?? 0);
    cell.count += 1;
    by.set(key, cell);
  }
  const keys = winFrom != null ? bucketKeysInWindow(winFrom, winTo, grain) : [...by.keys()].sort();
  return keys.map((key) => {
    const cell = by.get(key);
    return { date: key, value: cell && cell.count > 0 ? cell.sum / cell.count : null };
  });
}

/**
 * КАНАЛЬНЫЙ дневной поток (channel_daily.views) по корзинам окна — та же величина, что хедлайн
 * `deriveKpis().channelViews` и что рисуют Обзор и `/metrics/views`. В отличие от
 * {@link bucketPostField} меряет просмотры ВСЕГО канала за день, а не только постов, опубликованных
 * в этот день.
 *
 * Корзина без единой строки архива — это ПРОПУСК СБОРА (`null`), а не нулевой день: канал не может
 * набрать ровно ноль просмотров за сутки, ноль тут всегда означал бы «мы не спросили». Строка
 * архива со значением 0 остаётся честным нулём и пропуском не считается.
 */
export function bucketChannelFlow(
  rows: { day: string; views?: number | null }[],
  winFrom: number | null,
  winTo: number,
  grain: SeriesGrain,
): WidgetSeriesPoint[] {
  const by = new Map<string, number>();
  for (const row of rows) {
    if (row.views == null) continue;
    const timestamp = Date.parse(row.day);
    if (!Number.isFinite(timestamp)) continue;
    const key = bucketKeyOf(timestamp, grain);
    by.set(key, (by.get(key) ?? 0) + Number(row.views));
  }
  const keys = winFrom != null ? bucketKeysInWindow(winFrom, winTo, grain) : [...by.keys()].sort();
  return keys.map((key) => ({ date: key, value: by.has(key) ? (by.get(key) as number) : null }));
}

export function bucketSubscriberLevels(
  rows: { day: string; subscribers?: number | null }[],
  grain: SeriesGrain,
): WidgetSeriesPoint[] {
  const by = new Map<string, number>();
  rows
    .filter((row) => row.subscribers != null)
    .sort((a, b) => a.day.localeCompare(b.day))
    .forEach((row) => {
      const timestamp = Date.parse(row.day);
      if (Number.isFinite(timestamp)) by.set(bucketKeyOf(timestamp, grain), Number(row.subscribers));
    });
  return [...by.keys()].sort().map((key) => ({ date: key, value: by.get(key)! }));
}

function localDay(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function commonMeta(config: WidgetConfig, ctx: DataContext, network: 'tg' | 'ig' | 'ms' | 'ym'): WidgetMeta {
  const meta: WidgetMeta = {
    network,
    periodLabel: ctx.range ? 'выбранный период' : ctx.days > 0 ? `за ${ctx.days} дн.` : 'за всё время',
  };
  if (config.source != null) {
    if (network === 'tg') {
      const channel = ctx.tg?.channels?.channels?.find((candidate) => candidate.id === ctx.tg?.channelId);
      if (channel) meta.sourceLabel = `@${channel.username || channel.title || channel.id}`;
    } else if (network === 'ms') {
      // Имя организации в ctx недоступно (summary его не несёт) — честная подпись источника-сети.
      meta.sourceLabel = 'МойСклад';
    } else if (network === 'ym') {
      // Имя счётчика в ctx недоступно (summary его не несёт) — та же честная сетевая подпись.
      meta.sourceLabel = 'Метрика';
    } else {
      const username = ctx.ig?.profile?.username;
      if (username) meta.sourceLabel = `@${username}`;
    }
  }
  if (network === 'tg' && ctx.tg) {
    const timestamp = latestDataMs(ctx.tg.full?.posts ?? undefined, ctx.tg.history ?? undefined);
    const fresh = timestamp != null ? freshness(localDay(timestamp), ctx.now) : null;
    if (fresh) meta.fresh = fresh;
  } else if (network === 'ig' && ctx.ig?.history?.rows?.length) {
    let latest: string | null = null;
    for (const row of ctx.ig.history.rows) {
      if (row.day && (latest === null || row.day > latest)) latest = row.day;
    }
    const fresh = freshness(latest, ctx.now);
    if (fresh) meta.fresh = fresh;
  }
  return meta;
}
