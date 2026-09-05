import type { TgFull } from '@/api/schemas';

export const TG_DAY_NAMES = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const;

export interface HeatmapCell {
  n: number;
  ervSum: number;
  reachSum: number;
}

export interface HeatmapBestSlot {
  weekday: number;
  hour: number;
  avgErv: number;
  n: number;
  reachSum: number;
}

/** Второй конец шкалы — слот, где вовлечённость самая низкая. Без `reachSum`: у затишья нет
    роли «покажи, сколько людей пришло», оно отвечает только «когда не стоит публиковать». */
export interface HeatmapQuietSlot {
  weekday: number;
  hour: number;
  avgErv: number;
  n: number;
}

/**
 * Порог доверия для ЗАТИШЬЯ. Пик считается по всем ячейкам (у него есть бонус за повторяемость,
 * см. ниже), а вот назвать час мёртвым по ОДНОМУ посту нельзя: один неудачный пост — это анекдот,
 * а не свойство слота, и карточка советовала бы избегать времени, в которое канал просто ни разу
 * толком не публиковал.
 */
const QUIET_MIN_N = 2;

/**
 * Свести посты в 7×24 сетку среднего ERV + оба конца шкалы. Чистая функция без React: жила внутри
 * panels/Charts.tsx и потому не имела ни одного юнит-теста — вся математика «когда публиковать»
 * проверялась только глазами на демо-данных.
 */
export function buildHeatmap(
  posts: NonNullable<TgFull['posts']>,
  inRange: (dateISO: string | null | undefined) => boolean,
): {
  grid: HeatmapCell[][];
  maxErv: number;
  bestSlot: HeatmapBestSlot | null;
  quietSlot: HeatmapQuietSlot | null;
} {
  const grid: HeatmapCell[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ n: 0, ervSum: 0, reachSum: 0 })),
  );

  posts.forEach((p) => {
    if (!inRange(p.date) || !p.date) return;
    const d = new Date(p.date);
    if (isNaN(d.getTime())) return;

    const weekday = (d.getDay() + 6) % 7;
    const hour = d.getHours();

    const row = grid[weekday];
    if (!row) return;
    const cell = row[hour];
    if (!cell) return;

    const reach = Number(p.views ?? 0);
    const eng = Number(p.reactions ?? 0) + Number(p.forwards ?? 0) + Number(p.replies ?? 0);
    const erv = reach > 0 ? (eng / reach) * 100 : null;

    cell.n++;
    cell.reachSum += reach;
    if (erv !== null) cell.ervSum += erv;
  });

  let maxErv = 0;
  let bestSlot: HeatmapBestSlot | null = null;
  let maxScore = -1;
  let quietSlot: HeatmapQuietSlot | null = null;
  let quietCandidates = 0;

  for (let w = 0; w < 7; w++) {
    const row = grid[w];
    if (!row) continue;
    for (let hr = 0; hr < 24; hr++) {
      const cell = row[hr];
      if (cell && cell.n > 0) {
        const avgErv = cell.ervSum / cell.n;
        if (avgErv > maxErv) maxErv = avgErv;
        const score = avgErv * (cell.n >= 2 ? 1.15 : 1);
        if (score > maxScore) {
          maxScore = score;
          bestSlot = { weekday: w, hour: hr, avgErv, n: cell.n, reachSum: cell.reachSum };
        }
        if (cell.n >= QUIET_MIN_N) {
          quietCandidates++;
          if (!quietSlot || avgErv < quietSlot.avgErv) {
            quietSlot = { weekday: w, hour: hr, avgErv, n: cell.n };
          }
        }
      }
    }
  }

  // Одна подтверждённая ячейка — это не шкала: сравнивать её не с чем, и «тише всего» стало бы
  // вторым именем той же строки. Совпадение с пиком возможно и при нескольких кандидатах (пик
  // берётся по ВСЕМ ячейкам, включая одиночные) — такой вердикт называл бы один слот и лучшим,
  // и худшим сразу.
  if (
    quietCandidates < 2 ||
    (bestSlot && quietSlot && bestSlot.weekday === quietSlot.weekday && bestSlot.hour === quietSlot.hour)
  ) {
    quietSlot = null;
  }

  return { grid, maxErv, bestSlot, quietSlot };
}
