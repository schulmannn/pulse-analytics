import type { CampaignBestWorst, CampaignPlatformStats, CampaignSummary, CampaignTimelinePoint } from '@/api/schemas';
import { fmt } from '@/lib/format';

/**
 * Чистые построители представления сводки кампании. Числа считает СЕРВЕР
 * (GET /api/campaigns/:id/summary); здесь только сборка серий для графиков и подписей —
 * с явным разведением методологий платформ: tg.views = показы поста Telegram,
 * ig.reach = уникальные аккаунты Instagram, ig.views = просмотры (plays). Эти метрики
 * НИКОГДА не суммируются в один «общий охват» — только рядом, с подписями.
 */

export const METHODOLOGY = {
  tg_views: 'Просмотры Telegram — показы поста',
  ig_reach: 'Сумма охватов публикаций Instagram; аудитория между публикациями не дедуплицируется',
  ig_views: 'Просмотры Instagram — воспроизведения (plays)',
} as const;

const dayLabel = (day: string) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;

export interface TimelineSeries {
  labels: string[];
  titles: string[];
  posts: number[];
  tgViews: number[];
  igReach: number[];
  tgPresent: boolean[];
  igPresent: boolean[];
  hasTg: boolean;
  hasIg: boolean;
}

/** Серии «динамика публикаций и охвата»: по дням публикации (сервер уже сгруппировал). */
export function timelineSeries(timeline: CampaignTimelinePoint[]): TimelineSeries {
  const sorted = [...timeline].sort((a, b) => (a.day < b.day ? -1 : 1));
  const labels = sorted.map((t) => dayLabel(t.day));
  return {
    labels,
    titles: sorted.map(
      (t) =>
        `${dayLabel(t.day)}: ${t.posts} публ.` +
        (t.tg_views != null ? ` · TG ${fmt.short(t.tg_views)}` : '') +
        (t.ig_reach != null ? ` · IG ${fmt.short(t.ig_reach)}` : ''),
    ),
    posts: sorted.map((t) => t.posts),
    tgViews: sorted.map((t) => Number(t.tg_views ?? 0)),
    igReach: sorted.map((t) => Number(t.ig_reach ?? 0)),
    tgPresent: sorted.map((t) => t.tg_views != null),
    igPresent: sorted.map((t) => t.ig_reach != null),
    hasTg: sorted.some((t) => t.tg_views != null),
    hasIg: sorted.some((t) => t.ig_reach != null),
  };
}

const FORMAT_LABEL: Record<string, string> = {
  photo: 'Фото',
  video: 'Видео',
  text: 'Текст',
  IMAGE: 'Фото',
  VIDEO: 'Видео',
  CAROUSEL_ALBUM: 'Карусель',
  REELS: 'Reels',
};

export function formatLabel(network: string, mediaType: string | null | undefined): string {
  const net = network === 'ig' ? 'IG' : 'TG';
  const type = mediaType ? (FORMAT_LABEL[mediaType] ?? mediaType) : 'Без типа';
  return `${net} · ${type}`;
}

/** Срезы для донат-чарта форматов — по числу публикаций (число постов сравнимо между сетями,
    в отличие от их метрик охвата). */
export function formatSlices(byFormat: CampaignSummary['by_format']): {
  labels: string[];
  values: number[];
  titles: string[];
} {
  const sorted = [...byFormat].sort((a, b) => b.posts - a.posts);
  return {
    labels: sorted.map((f) => formatLabel(f.network, f.media_type)),
    values: sorted.map((f) => f.posts),
    titles: sorted.map((f) => {
      const metric =
        f.network === 'tg'
          ? f.tg_views != null
            ? ` · ${fmt.short(f.tg_views)} просмотров`
            : ''
          : f.ig_reach != null
            ? ` · сумма охватов ${fmt.short(f.ig_reach)}`
            : '';
      return `${formatLabel(f.network, f.media_type)}: ${f.posts} публ.${metric}`;
    }),
  };
}

/** «×2.0 к медиане кампании» — коэффициент лучшего/худшего поста против медианы СВОЕЙ платформы. */
export function ratioLabel(ratio: number | null | undefined): string | null {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  return `×${ratio.toFixed(1)} к медиане`;
}

/** Pick cross-platform extremes only by their normalized ratio to each platform's own median. */
export function campaignExtremes(summary: Pick<CampaignSummary, 'tg' | 'ig'>): {
  best: CampaignBestWorst | null;
  worst: CampaignBestWorst | null;
} {
  const best = [summary.tg?.best, summary.ig?.best]
    .filter((post): post is CampaignBestWorst => post != null && post.ratio != null)
    .sort((a, b) => Number(b.ratio) - Number(a.ratio))[0] ?? null;
  const worst = [summary.tg?.worst, summary.ig?.worst]
    .filter((post): post is CampaignBestWorst => post != null && post.ratio != null)
    .sort((a, b) => Number(a.ratio) - Number(b.ratio))[0] ?? null;
  return { best, worst };
}

/** Текст сравнения с предыдущим равным периодом (только tg; появляется при достатке данных). */
export function comparisonText(summary: Pick<CampaignSummary, 'comparison' | 'tg'>): string | null {
  const c = summary.comparison;
  if (!c || !c.available) return null;
  const delta = c.views_avg_delta_pct;
  const deltaPart =
    delta == null ? '' : `${delta > 0 ? '+' : ''}${fmt.num(Math.round(delta))}% к среднему · `;
  return `TG: ${deltaPart}предыдущий равный период — ${c.prev_posts} публ., в среднем ${fmt.short(Number(c.prev_views_avg ?? 0))} просмотров`;
}

/** Причина, почему сравнения нет, — честный insufficient-data state, а не пустое место. */
export function comparisonUnavailableText(summary: Pick<CampaignSummary, 'comparison' | 'tg' | 'ig'>): string | null {
  const c = summary.comparison;
  if (c && c.available) return null;
  return 'Сравнение с предыдущим периодом недоступно: недостаточно публикаций тех же источников в предыдущем равном окне (для Instagram даты вне кампании не архивируются).';
}

export interface KpiTile {
  label: string;
  value: string;
  hint?: string;
}

/** KPI-плитки платформ. Раздельные блоки: методологии подписаны, суммы не смешиваются. */
export function platformKpis(summary: Pick<CampaignSummary, 'tg' | 'ig'>): { tg: KpiTile[]; ig: KpiTile[] } {
  const tg: KpiTile[] = [];
  const ig: KpiTile[] = [];
  const t: CampaignPlatformStats = summary.tg ?? { posts: 0 };
  const i: CampaignPlatformStats = summary.ig ?? { posts: 0 };
  if (t.posts > 0) {
    tg.push({ label: 'Публикации TG', value: fmt.num(t.posts) });
    if (t.views != null) tg.push({ label: 'Просмотры', value: fmt.short(t.views), hint: METHODOLOGY.tg_views });
    if (t.median != null) tg.push({ label: 'Медиана просмотров', value: fmt.short(t.median) });
    if (t.avg != null) tg.push({ label: 'Средний пост', value: fmt.short(t.avg) });
    if (t.reactions != null) tg.push({ label: 'Реакции', value: fmt.short(t.reactions) });
    if (t.forwards != null) tg.push({ label: 'Репосты', value: fmt.short(t.forwards) });
  }
  if (i.posts > 0) {
    ig.push({ label: 'Публикации IG', value: fmt.num(i.posts) });
    if (i.reach != null) ig.push({ label: 'Сумма охватов', value: fmt.short(i.reach), hint: METHODOLOGY.ig_reach });
    if (i.median != null) ig.push({ label: 'Медиана охвата', value: fmt.short(i.median) });
    if (i.views != null) ig.push({ label: 'Просмотры', value: fmt.short(i.views), hint: METHODOLOGY.ig_views });
    if (i.likes != null) ig.push({ label: 'Лайки', value: fmt.short(i.likes) });
    if (i.saved != null) ig.push({ label: 'Сохранения', value: fmt.short(i.saved) });
  }
  return { tg, ig };
}
