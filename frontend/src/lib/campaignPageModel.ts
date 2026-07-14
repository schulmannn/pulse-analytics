import type { CampaignPost, CampaignSummary } from '@/api/schemas';
import type { TimelineSeries } from '@/lib/campaignSummary';
import { fmt } from '@/lib/format';

/**
 * Чистые построители представления ДЛЯ desktop-страницы кампании. Здесь только сборка
 * структур для верстки — числа считает сервер. Ключевой инвариант тот же, что в
 * campaignSummary.ts: методологии платформ (tg.views = показы, ig.reach = сумма охватов)
 * НИКОГДА не суммируются в один «общий охват». Доля источника считается ТОЛЬКО внутри
 * своей платформы, а порядок лидерборда — по числу публикаций (единственная величина,
 * сравнимая между сетями).
 */

type SourceRow = CampaignSummary['by_source'][number];

export interface SourceLeaderRow {
  key: string;
  network: 'tg' | 'ig';
  label: string;
  posts: number;
  /** tg_views | ig_reach — «своя» метрика платформы (иначе null). */
  metric: number | null;
  metricText: string;
  /** Доля метрики ВНУТРИ своей платформы (0..1), не между платформами; null без метрики. */
  share: number | null;
}

const sourceLabel = (row: SourceRow): string =>
  row.title || (row.username ? `@${row.username.replace(/^@/, '')}` : `Канал #${row.channel_id}`);

const rowMetric = (row: SourceRow): number | null =>
  row.network === 'tg'
    ? row.tg_views != null
      ? Number(row.tg_views)
      : null
    : row.ig_reach != null
      ? Number(row.ig_reach)
      : null;

/**
 * Лидерборд источников: порядок — по числу публикаций (сравнимо между сетями), доля метрики —
 * внутри своей платформы. Метрика TG (просмотры) и IG (охват) остаётся раздельной: доля источника
 * нормируется на сумму ТОЛЬКО своей сети, поэтому tg-полоска и ig-полоска ничего не смешивают.
 */
export function sourceLeaderboard(rows: SourceRow[]): SourceLeaderRow[] {
  const totals = rows.reduce(
    (acc, row) => {
      const metric = rowMetric(row);
      if (metric != null) acc[row.network] += metric;
      return acc;
    },
    { tg: 0, ig: 0 } as Record<'tg' | 'ig', number>,
  );
  return rows
    .map((row) => {
      const metric = rowMetric(row);
      const netTotal = totals[row.network];
      return {
        key: `${row.network}:${row.channel_id}`,
        network: row.network,
        label: sourceLabel(row),
        posts: row.posts,
        metric,
        metricText: metric != null ? fmt.short(metric) : '—',
        share: metric != null && netTotal > 0 ? metric / netTotal : null,
      } satisfies SourceLeaderRow;
    })
    .sort((a, b) => b.posts - a.posts || (b.metric ?? -1) - (a.metric ?? -1));
}

/** Строка охвата данных под фильтром источника: «N из M публ. · без даты: K · период: … — …». */
export function scopeNote(
  summary: Pick<CampaignSummary, 'posts_total' | 'undated_posts' | 'period'>,
  baseTotal: number,
  scoped: boolean,
): string {
  const parts: string[] = [
    scoped
      ? `${fmt.num(summary.posts_total)} из ${fmt.num(baseTotal)} публ.`
      : `${fmt.num(summary.posts_total)} публ.`,
  ];
  if (summary.undated_posts > 0) parts.push(`без даты: ${fmt.num(summary.undated_posts)}`);
  if (summary.period?.from) parts.push(`период данных: ${summary.period.from} — ${summary.period.to ?? summary.period.from}`);
  return parts.join(' · ');
}

/**
 * ── Таймлайн-эксплорер: ОДИН full-width график с сегментным переключателем режима. ──
 * TG-просмотры и IG-охват НИКОГДА не рисуются одной серией — это разные РЕЖИМЫ одного графика,
 * пользователь выбирает один за раз. Режимы отдаются только для платформ, у которых есть данные,
 * плюс «публикации по дням» — всегда, если таймлайн непуст.
 */
export type TimelineMode = 'tg_views' | 'ig_reach' | 'posts';

export interface TimelineModeOption {
  key: TimelineMode;
  /** Подпись сегментной кнопки (компактная). */
  label: string;
  /** Заголовок графика в выбранном режиме (методология подписана). */
  title: string;
  kind: 'line' | 'bar';
  labels: string[];
  values: number[];
  titles: string[];
}

const metricTitles = (labels: string[], values: number[], suffix: string): string[] =>
  labels.map((label, index) => `${label}: ${fmt.short(values[index] ?? 0)} ${suffix}`);

const presentPoints = (labels: string[], values: number[], present: boolean[]) => {
  const points = labels.flatMap((label, index) =>
    present[index] ? [{ label, value: values[index] ?? 0 }] : [],
  );
  return {
    labels: points.map((point) => point.label),
    values: points.map((point) => point.value),
  };
};

export function timelineModes(series: TimelineSeries): TimelineModeOption[] {
  if (series.labels.length === 0) return [];
  const modes: TimelineModeOption[] = [];
  if (series.hasTg) {
    const points = presentPoints(series.labels, series.tgViews, series.tgPresent);
    modes.push({
      key: 'tg_views',
      label: 'Просмотры TG',
      title: 'Просмотры TG · по дате публикации',
      kind: 'line',
      labels: points.labels,
      values: points.values,
      titles: metricTitles(points.labels, points.values, 'просмотров TG'),
    });
  }
  if (series.hasIg) {
    const points = presentPoints(series.labels, series.igReach, series.igPresent);
    modes.push({
      key: 'ig_reach',
      label: 'IG сумма охватов',
      title: 'Сумма охватов IG · по дате публикации',
      kind: 'line',
      labels: points.labels,
      values: points.values,
      titles: metricTitles(points.labels, points.values, 'суммарного охвата IG'),
    });
  }
  modes.push({
    key: 'posts',
    label: 'Публикации',
    title: 'Публикации по дням',
    kind: 'bar',
    labels: series.labels,
    values: series.posts,
    titles: series.labels.map((label, index) => `${label}: ${fmt.num(series.posts[index] ?? 0)} публ.`),
  });
  return modes;
}

/** Resolve a URL mode against the modes that actually have data. */
export function resolveTimelineMode(
  raw: string | null | undefined,
  modes: TimelineModeOption[],
): TimelineMode | null {
  return modes.find((mode) => mode.key === raw)?.key ?? modes[0]?.key ?? null;
}

/** Write the selected mode while preserving source and table params; the default stays omitted. */
export function applyTimelineMode(
  prev: URLSearchParams,
  mode: TimelineMode | null,
  defaultMode: TimelineMode | null,
): URLSearchParams {
  const next = new URLSearchParams(prev);
  if (mode == null || mode === defaultMode) next.delete('metric');
  else next.set('metric', mode);
  return next;
}

/**
 * ── Таблица публикаций: две сопоставимые роли, но разные явно подписанные методологии. ──
 * «Основной результат» — просмотры TG или сумма охватов IG. «Взаимодействия» — сумма доступных
 * реакций конкретной платформы. Эти значения не агрегируются между сетями; они используются
 * только внутри отдельной строки и для управляемой пользователем сортировки.
 */
export type PostSortKey = 'date' | 'result' | 'interactions';
export type SortOrder = 'asc' | 'desc';

export interface CampaignPostMetric {
  value: number | null;
  label: string;
}

const finite = (value: number | null | undefined): number | null =>
  value == null || !Number.isFinite(value) ? null : Number(value);

const sumPresent = (values: Array<number | null | undefined>): number | null => {
  const present = values.map(finite).filter((value): value is number => value != null);
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : null;
};

export function postPrimaryResult(post: CampaignPost): CampaignPostMetric {
  return post.network === 'tg'
    ? { value: post.accessible === false ? null : finite(post.tg_views), label: 'TG просмотры' }
    : { value: post.accessible === false ? null : finite(post.ig_reach), label: 'IG сумма охватов' };
}

export function postInteractions(post: CampaignPost): CampaignPostMetric {
  return post.network === 'tg'
    ? {
        value: post.accessible === false
          ? null
          : sumPresent([post.tg_reactions, post.tg_forwards, post.tg_replies]),
        label: 'TG реакции + репосты + комментарии',
      }
    : {
        value: post.accessible === false
          ? null
          : sumPresent([post.ig_likes, post.ig_comments, post.ig_saved, post.ig_shares]),
        label: 'IG лайки + комментарии + сохранения + репосты',
      };
}

const postDateMs = (p: CampaignPost): number | null =>
  p.published_at && Number.isFinite(Date.parse(p.published_at)) ? Date.parse(p.published_at) : null;

const SORT_ACCESSOR: Record<PostSortKey, (p: CampaignPost) => number | null> = {
  date: postDateMs,
  result: (post) => postPrimaryResult(post).value,
  interactions: (post) => postInteractions(post).value,
};

export interface CampaignPostTableState {
  q: string;
  sort: PostSortKey;
  order: SortOrder;
}

export const CAMPAIGN_POST_TABLE_DEFAULTS: CampaignPostTableState = {
  q: '',
  sort: 'date',
  order: 'desc',
};

const POST_SORT_KEYS = new Set<PostSortKey>(['date', 'result', 'interactions']);

export function parseCampaignPostTableState(params: URLSearchParams): CampaignPostTableState {
  const rawSort = params.get('sort');
  return {
    q: params.get('q') ?? '',
    sort: rawSort && POST_SORT_KEYS.has(rawSort as PostSortKey)
      ? (rawSort as PostSortKey)
      : CAMPAIGN_POST_TABLE_DEFAULTS.sort,
    order: params.get('order') === 'asc' ? 'asc' : CAMPAIGN_POST_TABLE_DEFAULTS.order,
  };
}

export function applyCampaignPostTableState(
  prev: URLSearchParams,
  state: CampaignPostTableState,
): URLSearchParams {
  const next = new URLSearchParams(prev);
  if (state.q.trim()) next.set('q', state.q);
  else next.delete('q');
  if (state.sort === CAMPAIGN_POST_TABLE_DEFAULTS.sort) next.delete('sort');
  else next.set('sort', state.sort);
  if (state.order === CAMPAIGN_POST_TABLE_DEFAULTS.order) next.delete('order');
  else next.set('order', state.order);
  return next;
}

/** Отфильтровать по свободному запросу (подпись / название источника / @username), без регистра. */
export function filterPostsByQuery(posts: CampaignPost[], query: string): CampaignPost[] {
  const q = query.trim().toLowerCase();
  if (!q) return posts;
  return posts.filter((p) => {
    const hay = [p.caption, p.channel_title, p.channel_username, p.post_ref]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  });
}

/** Устойчивая сортировка: null-метрики всегда в конце, тай-брейк — по дате убыв. */
export function sortPosts(posts: CampaignPost[], key: PostSortKey, order: SortOrder): CampaignPost[] {
  const accessor = SORT_ACCESSOR[key];
  const dir = order === 'asc' ? 1 : -1;
  return [...posts].sort((a, b) => {
    const av = accessor(a);
    const bv = accessor(b);
    if (av == null && bv == null) return (postDateMs(b) ?? 0) - (postDateMs(a) ?? 0);
    if (av == null) return 1;
    if (bv == null) return -1;
    if (av === bv) return (postDateMs(b) ?? 0) - (postDateMs(a) ?? 0);
    return (av - bv) * dir;
  });
}
