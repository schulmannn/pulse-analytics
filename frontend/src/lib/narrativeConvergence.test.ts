import { describe, expect, it } from 'vitest';
import { buildWeekNarrative, type NarrativeInput, type NarrativeSeg } from '@/lib/narrative';
import { windowIgSeries, type Point } from '@/lib/igMetrics';
import { fmt } from '@/lib/format';

/**
 * КОНТРАКТ СХОДИМОСТИ ЧИСЕЛ — главное обещание продукта: «каждое число в рассказе сходится со
 * страницей метрики 1-в-1». Оно держалось на ручных демо-сверках; здесь — как инвариант в CI.
 *
 * Приём: ожидания НЕ захардкожены — они вычисляются той же функцией `windowIgSeries`, которой
 * живёт страница /metrics/ig-* (её headline = `windowIgSeries(series, days).total`). Тест
 * прогоняет ОДНУ общую фикстуру через страницу-функцию и через движок рассказа и требует
 * равенства. Разъедется окно/формат в одном из путей — CI покраснеет, а не «тихо живёт».
 */

const day = (i: number) => `2026-06-${String(8 + i).padStart(2, '0')}`;
/** 14 дней охвата (2 полных недели) — прошлая + текущая. */
const reachVals = [410, 620, 580, 505, 470, 0, 690, 845, 900, 610, 720, 655, 0, 980];
const followsVals = [3, 5, 2, 4, 0, 1, 6, 2, 3, -1, 4, 0, 2, 5]; // дневной ЧИСТЫЙ прирост

const asPoints = (vals: number[]): Point[] => vals.map((v, i) => ({ day: day(i), value: v }));
const asDaily = (vals: number[]) => vals.map((v, i) => ({ day: day(i), v }));

const base: NarrativeInput = {
  viewsDaily: asDaily([980, 454, 463, 471, 467, 0, 417, 845, 381, 691, 314, 0, 242, 166]),
  posts: [],
  avgErv: null,
  subsNow: 4749,
  subsD7: -27,
  ig: {
    reachDaily: asDaily(reachVals),
    followsDaily: asDaily(followsVals),
    followersNow: 12480,
  },
};

/** Число-сегменты рассказа, сгруппированные по drill-цели (`to`). */
function numbersByTo(input: NarrativeInput): Map<string, NarrativeSeg[]> {
  const map = new Map<string, NarrativeSeg[]>();
  for (const seg of buildWeekNarrative(input).paragraphs.flat()) {
    if (seg.kind === 'number' && seg.to) {
      const arr = map.get(seg.to) ?? [];
      arr.push(seg);
      map.set(seg.to, arr);
    }
  }
  return map;
}

describe('сходимость чисел рассказа со страницами метрик', () => {
  it('IG-охват в рассказе == headline /metrics/ig-reach (7д), той же windowIgSeries', () => {
    // Страница ig-reach на окне 7д показывает ровно это:
    const pageHeadline = fmt.kpi(windowIgSeries(asPoints(reachVals), 7, 'охвата').total);
    const nums = numbersByTo(base);
    const reachSegs = nums.get('/metrics/ig-reach') ?? [];
    expect(reachSegs.length).toBe(1);
    expect(reachSegs[0].kind === 'number' && reachSegs[0].text).toBe(pageHeadline);
  });

  it('IG-движение базы в рассказе == сумма недельного окна страницы ig-follows', () => {
    // ig-follows headline = сумма последнего 7-дневного окна той же серии (может быть знаковой).
    const weekTotal = windowIgSeries(asPoints(followsVals), 7, 'подписок').total;
    const nums = numbersByTo(base);
    const followSegs = (nums.get('/metrics/ig-follows') ?? []).filter((s) => s.kind === 'number');
    // Первый ig-follows-сегмент — величина движения (рассказ пишет её модулем: «набрала N»).
    const moveSeg = followSegs[0];
    expect(moveSeg && moveSeg.kind === 'number' && moveSeg.text).toBe(fmt.num(Math.abs(weekTotal)));
  });

  it('текущая база IG в рассказе == fmt.kpi(followersNow)', () => {
    const nums = numbersByTo(base);
    const followSegs = (nums.get('/metrics/ig-follows') ?? []).filter((s) => s.kind === 'number');
    const nowSeg = followSegs[followSegs.length - 1];
    expect(nowSeg && nowSeg.kind === 'number' && nowSeg.text).toBe(fmt.kpi(12480));
  });

  it('окно рассказа честно 7-дневное: не 8, не «весь ряд» (иначе число разойдётся со страницей)', () => {
    // Если движок случайно возьмёт другое окно, суммы разойдутся — проверяем именно 7, а не 14.
    const seven = fmt.kpi(windowIgSeries(asPoints(reachVals), 7, 'охвата').total);
    const all = fmt.kpi(windowIgSeries(asPoints(reachVals), 0, 'охвата').total);
    expect(seven).not.toBe(all); // фикстура выбрана так, что окна различимы
    const reachSeg = (numbersByTo(base).get('/metrics/ig-reach') ?? [])[0];
    expect(reachSeg.kind === 'number' && reachSeg.text).toBe(seven);
  });
});
