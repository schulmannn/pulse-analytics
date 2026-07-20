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

export interface OpportunityChipPoint {
  /** Позиция чипа в процентах плоскости (`y` — CSS `bottom`, больше = выше). */
  x: number;
  y: number;
}

export interface OpportunityChipLayoutOptions {
  /** Дистанция по X (п.п.), ближе которой чипы считаются пересекающимися по горизонтали. */
  xOverlap?: number;
  /** Высота чипа + зазор в процентах высоты плоскости — шаг вертикального разведения. */
  step?: number;
  /** Границы плоскости по вертикали (совпадают с клампами opportunityY). */
  minY?: number;
  maxY?: number;
}

/**
 * Детерминированное разведение чипов форматов на скаттер-плоскости — без физики и итераций
 * до сходимости. Чипы обходятся в порядке возрастания X (при равных X — исходный порядок);
 * последующий чип, пересекающийся с уже размещённым по обеим осям, каскадно пересаживается
 * на высоту чипа + зазор НИЖЕ конфликтующего. Если каскад выводит за нижний край плоскости,
 * чип разводится вверх; результат кламплен в границы. Позиции возвращаются по исходным
 * индексам входа.
 */
export function resolveOpportunityChipOverlaps(
  chips: readonly OpportunityChipPoint[],
  { xOverlap = 10, step = 14, minY = 12, maxY = 88 }: OpportunityChipLayoutOptions = {},
): OpportunityChipPoint[] {
  const order = chips.map((_, index) => index).sort((a, b) => chips[a].x - chips[b].x || a - b);
  const placed: OpportunityChipPoint[] = [];
  const result: OpportunityChipPoint[] = chips.map((chip) => ({ ...chip }));
  const conflictWith = (x: number, y: number) =>
    placed.find((other) => Math.abs(other.x - x) < xOverlap && Math.abs(other.y - y) < step);
  for (const index of order) {
    const { x } = chips[index];
    const start = Math.min(maxY, Math.max(minY, chips[index].y));
    // Каждый прыжок строго монотонен (ниже/выше конфликтующего ровно на step), поэтому каждый
    // размещённый чип встречается не более одного раза — цикл ограничен числом размещённых.
    let y = start;
    for (let hit = conflictWith(x, y); hit; hit = conflictWith(x, y)) y = hit.y - step;
    if (y < minY) {
      y = start;
      for (let hit = conflictWith(x, y); hit && y < maxY; hit = conflictWith(x, y)) {
        y = Math.min(maxY, hit.y + step);
      }
    }
    const resolved = { x, y };
    placed.push(resolved);
    result[index] = resolved;
  }
  return result;
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
