import { describe, expect, it } from 'vitest';
import { hasDailySeries, windowPair, type Point } from '@/lib/igMetrics';

/**
 * Почему DB-бэк аддитивных IG-метрик (views/взаимодействия/лайки/…) безопасен и убирает лаг «—».
 *
 * Живой insights отдаёт эти метрики ДВУМЯ синтет-точками окна (prev@середина, cur@конец) — до его
 * ответа KPI пусты. Крон копит их в ig_daily ежедневно; longerSeries берёт архив, когда он длиннее.
 * Инвариант, который это оправдывает: для АДДИТИВНЫХ метрик сумма дневного архива по окну РАВНА
 * оконному агрегату живого API. (reach — исключение: дедуп повторных зрителей, поэтому он остаётся
 * на reach_window; здесь мы это фиксируем как контраст.)
 */

const DAY = 86400000;
const lastDay = Date.parse('2026-07-07T00:00:00.000Z'); // полночь последней точки архива
// Границы окна в ПОЛДЕНЬ, чтобы ни одна суточная точка не села ровно на границу (иначе off-by-one).
const until = lastDay + DAY / 2;
const since = until - 7 * DAY; // окно = 7 последних суточных точек

/** 14 дневных точек (старые → новые), последняя = `lastDay`. */
const daily = (vals: number[]): Point[] =>
  vals.map((v, i) => ({ day: new Date(lastDay - (vals.length - 1 - i) * DAY).toISOString().slice(0, 10), value: v }));

const prev7 = [10, 20, 30, 40, 50, 60, 70]; // сумма 280
const cur7 = [11, 22, 33, 44, 55, 66, 77]; // сумма 308
const archive = daily([...prev7, ...cur7]);

/** Как реконструирует живой бэкенд: 2 синтет-точки (prev в прошлом окне, cur в текущем). */
const liveSynthetic: Point[] = [
  { day: new Date(lastDay - 10 * DAY).toISOString().slice(0, 10), value: 280 }, // prev-window total
  { day: new Date(lastDay).toISOString().slice(0, 10), value: 308 }, // cur-window total
];

describe('аддитивные IG-метрики: архив по дням == оконный агрегат живого API', () => {
  it('сумма дневного архива за окно равна текущему оконному тоталу', () => {
    const p = windowPair(archive, since, until);
    expect(p.cur).toBe(308);
    expect(p.hasCur).toBe(true);
  });

  it('предыдущее окно берётся из архива корректно (для дельты)', () => {
    const p = windowPair(archive, since, until);
    expect(p.prev).toBe(280);
    expect(p.hasPrev).toBe(true);
  });

  it('своп live→DB сохраняет число: обе формы дают один и тот же KPI', () => {
    const fromArchive = windowPair(archive, since, until);
    const fromLive = windowPair(liveSynthetic, since, until);
    expect(fromArchive.cur).toBe(fromLive.cur); // 308 — цифра не «прыгает» при переключении источника
    expect(fromArchive.prev).toBe(fromLive.prev); // 280
  });

  it('синтет-точка «total» (без даты) в окно не попадает — не задваивает', () => {
    const withTotal: Point[] = [...archive, { day: 'total', value: 9999 }];
    expect(windowPair(withTotal, since, until).cur).toBe(308);
  });
});

describe('гейт промоушена метрик-страницы: hasDailySeries(series, 3)', () => {
  const synthetic2: Point[] = liveSynthetic; // ровно 2 датированные точки (prev+cur живого агрегата)
  it('живой 2-точечный синтет НЕ считается графопригодным (min=3) → страница остаётся сводкой', () => {
    expect(hasDailySeries(synthetic2, 3)).toBe(false);
  });
  it('реальный многодневный ряд (архив) проходит гейт → рисуем дневной график', () => {
    expect(hasDailySeries(archive, 3)).toBe(true);
  });
  it('reach/follows используют дефолт min=2 (у них честный живой дневной ряд)', () => {
    expect(hasDailySeries(synthetic2)).toBe(true); // 2 точки достаточно для reach/follows
  });
});
