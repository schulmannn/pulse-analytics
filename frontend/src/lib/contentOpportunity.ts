import type { NormalizedPost } from '@/lib/posts';

export interface ContentOpportunity {
  key: string;
  label: string;
  count: number;
  share: number;
  avgReach: number;
  reachIndex: number;
  avgErv: number | null;
  confidence: 'low' | 'medium' | 'high';
  opportunity: boolean;
}

export function opportunityX(share: number): number {
  return Math.min(92, Math.max(8, share * 100));
}

/** 100% of channel-average reach sits exactly on the chart's 50% reference line. */
export function opportunityY(reachIndex: number): number {
  return Math.min(88, Math.max(12, 50 + (reachIndex - 1) * 36));
}

export function opportunityShareBoundary(formatCount: number): number {
  return formatCount > 0 ? 1 / formatCount : 0.5;
}

const FORMAT_LABELS: Record<string, string> = {
  text: 'Текст',
  photo: 'Фото',
  video: 'Видео',
  poll: 'Опросы',
  document: 'Файлы',
  audio: 'Аудио',
  voice: 'Голос',
  link: 'Ссылки',
};

/**
 * Formats are compared on two independent axes: publishing share and average reach.
 * A format is an opportunity only when it beats the channel baseline while being used
 * less often than an even format mix. Small samples remain visible but are never promoted.
 */
export function deriveContentOpportunities(posts: NormalizedPost[]): ContentOpportunity[] {
  if (posts.length === 0) return [];

  const groups = new Map<string, NormalizedPost[]>();
  for (const post of posts) {
    const key = post.mediaType || 'text';
    groups.set(key, [...(groups.get(key) ?? []), post]);
  }

  const channelAvgReach = posts.reduce((sum, post) => sum + post.reach, 0) / posts.length;
  const evenShare = opportunityShareBoundary(groups.size);

  return [...groups.entries()]
    .map(([key, rows]) => {
      const avgReach = rows.reduce((sum, post) => sum + post.reach, 0) / rows.length;
      const erv = rows.map((post) => post.erv).filter((value): value is number => value != null);
      const share = rows.length / posts.length;
      const reachIndex = channelAvgReach > 0 ? avgReach / channelAvgReach : 0;
      const confidence = rows.length >= 8 ? 'high' : rows.length >= 4 ? 'medium' : 'low';
      return {
        key,
        label: FORMAT_LABELS[key] ?? key,
        count: rows.length,
        share,
        avgReach,
        reachIndex,
        avgErv: erv.length ? erv.reduce((sum, value) => sum + value, 0) / erv.length : null,
        confidence,
        opportunity: confidence !== 'low' && reachIndex >= 1.1 && share < evenShare,
      } satisfies ContentOpportunity;
    })
    .sort((a, b) => b.reachIndex - a.reachIndex || b.count - a.count);
}
