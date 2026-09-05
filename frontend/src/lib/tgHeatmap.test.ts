import { describe, expect, it } from 'vitest';
import { buildHeatmap, TG_DAY_NAMES } from '@/lib/tgHeatmap';
import { demoFixture } from '@/lib/demoFixtures';
import { TgFullSchema } from '@/api/schemas';
import type { TgFull } from '@/api/schemas';

/**
 * Агрегация тепловой карты жила внутри panels/Charts.tsx и потому не проверялась ничем, кроме
 * глаз: вся математика «когда публиковать» — и пик, и новое затишье — держалась на разметке.
 * Здесь она проверяется как чистая функция.
 *
 * Даты СОБИРАЮТСЯ ОТ «СЕГОДНЯ», а не пишутся константами: сетка группирует посты по ЛОКАЛЬНОМУ
 * дню недели и часу, поэтому фиксированная дата привязала бы тест к таймзоне раннера.
 */
const HOUR_MS = 3_600_000;

/** Пост в конкретном слоте недели: `daysAgo` задаёт день, `hour` — час локального времени. */
function postAt(daysAgo: number, hour: number, views: number, engagement: number) {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return { date: d.toISOString(), views, reactions: engagement, forwards: 0, replies: 0 };
}

const slotOf = (daysAgo: number, hour: number) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return { weekday: (d.getDay() + 6) % 7, hour };
};

const all = () => true;
const build = (posts: ReturnType<typeof postAt>[]) =>
  buildHeatmap(posts as NonNullable<TgFull['posts']>, all);

describe('buildHeatmap — пик и затишье', () => {
  it('называет пик и затишье разными слотами', () => {
    // Слот A (7 дней назад, 10:00): ERV 10% на двух постах. Слот B (5 дней назад, 20:00): ERV 2%
    // на двух постах. Оба подтверждены повтором, значит шкала есть.
    const { bestSlot, quietSlot } = build([
      postAt(7, 10, 1000, 100),
      postAt(14, 10, 1000, 100),
      postAt(5, 20, 1000, 20),
      postAt(12, 20, 1000, 20),
    ]);

    expect(bestSlot).toMatchObject({ ...slotOf(7, 10), n: 2 });
    expect(bestSlot?.avgErv).toBeCloseTo(10, 6);
    expect(quietSlot).toMatchObject({ ...slotOf(5, 20), n: 2 });
    expect(quietSlot?.avgErv).toBeCloseTo(2, 6);
  });

  it('не берёт в затишье слот, подтверждённый одним постом', () => {
    // Самый низкий ERV (0.5%) — у одиночного поста. Затишьем становится следующий по низости
    // слот, у которого есть повтор: один пост — анекдот, а не свойство часа.
    const { quietSlot } = build([
      postAt(7, 10, 1000, 100),
      postAt(14, 10, 1000, 100),
      postAt(5, 20, 1000, 20),
      postAt(12, 20, 1000, 20),
      postAt(3, 4, 1000, 5),
    ]);

    expect(quietSlot).toMatchObject(slotOf(5, 20));
    expect(quietSlot?.n).toBe(2);
  });

  it('молчит про затишье, пока подтверждённый слот всего один', () => {
    const { bestSlot, quietSlot } = build([
      postAt(7, 10, 1000, 100),
      postAt(14, 10, 1000, 100),
      postAt(3, 4, 1000, 5),
    ]);

    expect(bestSlot).not.toBeNull();
    expect(quietSlot).toBeNull();
  });

  it('молчит про затишье, когда минимум совпал с пиком', () => {
    // Два одинаковых подтверждённых слота: минимум и максимум — один и тот же час, и вердикт
    // назвал бы его лучшим и худшим сразу.
    const { bestSlot, quietSlot } = build([
      postAt(7, 10, 1000, 100),
      postAt(14, 10, 1000, 100),
      postAt(5, 20, 1000, 100),
      postAt(12, 20, 1000, 100),
    ]);

    // Какой из двух равных слотов назовётся пиком — вопрос порядка обхода; важно, что вторым
    // сегментом вердикт молчит, а не повторяет первый.
    expect(bestSlot?.avgErv).toBeCloseTo(10, 6);
    expect(quietSlot).toBeNull();
  });

  it('на двух постах в одном слоте затишья нет', () => {
    const { bestSlot, quietSlot } = build([postAt(7, 10, 1000, 100), postAt(14, 10, 1000, 50)]);

    expect(bestSlot).toMatchObject({ ...slotOf(7, 10), n: 2 });
    expect(quietSlot).toBeNull();
  });
});

describe('buildHeatmap — перенос из panels/Charts.tsx не изменил пик', () => {
  it('бонус за повторяемость сохранён: 1.15× у слота с n ≥ 2', () => {
    // Одиночный пост с ERV 10% против повторяющегося слота с 9.5%: score 10 против 10.925 —
    // выигрывает подтверждённый. Ровно это правило и переехало из разметки.
    const { bestSlot } = build([
      postAt(2, 15, 1000, 100),
      postAt(6, 9, 1000, 95),
      postAt(13, 9, 1000, 95),
    ]);

    expect(bestSlot).toMatchObject({ ...slotOf(6, 9), n: 2 });
  });

  it('на демо-постах пик совпадает с независимым пересчётом того же правила', () => {
    const full = TgFullSchema.parse(demoFixture('/api/tg/full?limit=40'));
    const posts = full.posts ?? [];
    expect(posts.length).toBeGreaterThan(5);

    const { bestSlot, maxErv } = buildHeatmap(posts, all);

    // Независимый (наивный) пересчёт: без сетки, прямым перебором постов.
    const cells = new Map<string, { n: number; ervSum: number }>();
    let naiveMax = 0;
    for (const p of posts) {
      if (!p.date) continue;
      const d = new Date(p.date);
      const key = `${(d.getDay() + 6) % 7}:${d.getHours()}`;
      const reach = Number(p.views ?? 0);
      const eng = Number(p.reactions ?? 0) + Number(p.forwards ?? 0) + Number(p.replies ?? 0);
      const cur = cells.get(key) ?? { n: 0, ervSum: 0 };
      cur.n += 1;
      if (reach > 0) cur.ervSum += (eng / reach) * 100;
      cells.set(key, cur);
    }
    let naiveBest: string | null = null;
    let naiveScore = -1;
    for (const [key, c] of cells) {
      const avg = c.ervSum / c.n;
      if (avg > naiveMax) naiveMax = avg;
      const score = avg * (c.n >= 2 ? 1.15 : 1);
      if (score > naiveScore) {
        naiveScore = score;
        naiveBest = key;
      }
    }

    expect(bestSlot).not.toBeNull();
    expect(`${bestSlot?.weekday}:${bestSlot?.hour}`).toBe(naiveBest);
    expect(maxErv).toBeCloseTo(naiveMax, 6);
    // День берётся из общего словаря, а не собирается на месте.
    expect(TG_DAY_NAMES[bestSlot?.weekday ?? -1]).toMatch(/^(Пн|Вт|Ср|Чт|Пт|Сб|Вс)$/);
  });
});

describe('buildHeatmap — окно периода', () => {
  it('посты вне окна не попадают ни в пик, ни в затишье', () => {
    const posts = [
      postAt(2, 10, 1000, 100),
      postAt(9, 10, 1000, 100),
      postAt(400, 3, 1000, 1),
      postAt(407, 3, 1000, 1),
    ];
    const within = (dateISO: string | null | undefined) =>
      !!dateISO && Date.now() - new Date(dateISO).getTime() < 30 * 24 * HOUR_MS;

    const { bestSlot, quietSlot } = buildHeatmap(posts as NonNullable<TgFull['posts']>, within);

    expect(bestSlot).toMatchObject(slotOf(2, 10));
    // Единственный оставшийся подтверждённый слот — он же пик, значит шкалы нет.
    expect(quietSlot).toBeNull();
  });
});
