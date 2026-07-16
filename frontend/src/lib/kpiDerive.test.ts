import { describe, expect, it } from 'vitest';
import { deriveKpis } from '@/lib/kpiDerive';
import { fmt } from '@/lib/format';

/**
 * Вариант B (решение владельца): TG «Просмотры» = КАНАЛЬНЫЕ дневные просмотры из архива
 * (channel_daily.views), а не Σ views постов, опубликованных в окне. На проде эти два числа
 * расходились в разы (10.8k vs 1.8k) и ломали обещание нарратива «число сходится 1-в-1».
 * Здесь пиним: headline/channelViews берёт архив; при отсутствии архива — честный фолбэк в
 * пост-сумму; avg-reach-на-пост остаётся пост-базой (её channelViews НЕ трогает).
 */

const day = (i: number) => `2026-06-${String(8 + i).padStart(2, '0')}`;
const inRange = () => true; // все фикстурные даты считаем внутри окна

const derive = (archiveViews: number[], postViews: number[]) =>
  deriveKpis(
    {
      channel: { memberCount: 5000 },
      posts: postViews.map((v, i) => ({ date: `${day(i)}T12:00:00.000Z`, views: v, reactions: 0, forwards: 0, replies: 0 })),
    } as never,
    { rows: archiveViews.map((v, i) => ({ day: day(i), views: v, subscribers: 5000 })) } as never,
    undefined,
    null,
    7,
    null,
    inRange,
  );

describe('deriveKpis — «Просмотры» канальные (вариант B)', () => {
  it('headline = Σ канальных дневных просмотров из архива, НЕ Σ post-views', () => {
    const d = derive([1000, 2000, 3000, 4000], [100, 200, 300]); // архив Σ=10000, посты Σ=600
    expect(d.channelViews).toBe(10000);
    expect(d.drillMeta.views.total).toBe(fmt.short(10000));
    expect(d.drillMeta.views.total).not.toBe(fmt.short(600)); // не пост-сумма
  });

  it('avg-reach остаётся пост-базой (Σ post-views ÷ постов) — channelViews её не сдвигает', () => {
    const d = derive([1000, 2000, 3000, 4000], [100, 200, 300]);
    expect(d.avgViews).toBe(600 / 3); // 200, из totalViews (пост-сумма), не из channelViews
    expect(d.totalViews).toBe(600);
  });

  it('без архива — честный фолбэк headline в пост-сумму', () => {
    const d = derive([], [100, 200, 300]); // архива нет
    expect(d.channelViews).toBe(600);
    expect(d.drillMeta.views.total).toBe(fmt.short(600));
  });

  it('строки архива без views (null) не считаются архивом → фолбэк', () => {
    const d = deriveKpis(
      { channel: { memberCount: 5000 }, posts: [{ date: `${day(0)}T12:00:00.000Z`, views: 500, reactions: 0, forwards: 0, replies: 0 }] } as never,
      { rows: [{ day: day(0), subscribers: 5000 }, { day: day(1), subscribers: 5001 }] } as never, // views отсутствуют
      undefined,
      null,
      7,
      null,
      inRange,
    );
    expect(d.channelViews).toBe(500); // фолбэк в пост-сумму, не 0
  });
});

/**
 * Owner override (2026-07): три компактные TG-карточки (Ср. охват / Реакции / Вовлечённость) несут
 * честный спарклайн по UTC-дням ПУБЛИКАЦИИ активного окна (не зависит от предыдущего окна). Пиним
 * дневную математику, агрегацию нескольких постов в один день и сортировку по возрастанию дня.
 */
describe('deriveKpis — спарклайны TG по датам публикаций', () => {
  const MEMBERS = 5000;
  const post = (date: string, views: number, reactions: number, forwards: number, replies: number) =>
    ({ date, views, reactions, forwards, replies });
  const deriveSpark = (posts: unknown[], inWindow: (date: string | null | undefined) => boolean = () => true) =>
    deriveKpis(
      { channel: { memberCount: MEMBERS }, posts } as never,
      { rows: [] } as never,
      undefined,
      null,
      30,
      null,
      inWindow,
    );

  it('несколько постов за один UTC-день: Ср. охват = среднее просмотров, Реакции = Σ', () => {
    const d = deriveSpark([
      post('2026-06-08T09:00:00.000Z', 100, 10, 2, 1),
      post('2026-06-08T21:00:00.000Z', 300, 20, 4, 3),
      post('2026-06-09T12:00:00.000Z', 200, 5, 1, 0),
    ]);
    expect(d.avgReachSpark.values).toEqual([200, 200]); // (100+300)/2, 200/1
    expect(d.reactionsSpark.values).toEqual([30, 5]); // 10+20, 5
  });

  it('Вовлечённость за день = 100·(reactions + replies + forwards) ÷ member count', () => {
    const d = deriveSpark([
      post('2026-06-08T09:00:00.000Z', 100, 10, 2, 1),
      post('2026-06-08T21:00:00.000Z', 300, 20, 4, 3),
      post('2026-06-09T12:00:00.000Z', 200, 5, 1, 0),
    ]);
    // день A: 100·(30 + 4 + 6)/5000 = 0.8; день B: 100·(5 + 0 + 1)/5000 = 0.12
    expect(d.erSpark.values[0]).toBeCloseTo(0.8, 10);
    expect(d.erSpark.values[1]).toBeCloseTo(0.12, 10);
  });

  it('сортирует бакеты по возрастанию UTC-дня независимо от порядка входных постов', () => {
    const d = deriveSpark([
      post('2026-06-10T12:00:00.000Z', 900, 9, 0, 0),
      post('2026-06-08T12:00:00.000Z', 100, 1, 0, 0),
      post('2026-06-09T12:00:00.000Z', 500, 5, 0, 0),
    ]);
    expect(d.reactionsSpark.values).toEqual([1, 5, 9]); // 08, 09, 10
    expect(d.avgReachSpark.values).toEqual([100, 500, 900]);
  });

  it('строит серии только по постам точного активного окна top bar', () => {
    const d = deriveSpark(
      [
        post('2026-06-08T12:00:00.000Z', 100, 1, 0, 0),
        post('2026-06-09T12:00:00.000Z', 200, 2, 0, 0),
        post('2026-06-10T12:00:00.000Z', 900, 9, 0, 0),
      ],
      (date) => !!date && date < '2026-06-10',
    );
    expect(d.avgReachSpark.values).toEqual([100, 200]);
    expect(d.reactionsSpark.values).toEqual([1, 2]);
  });

  it('один день публикаций → один бакет (карточка покажет «Недостаточно дат…»)', () => {
    const d = deriveSpark([post('2026-06-08T12:00:00.000Z', 100, 1, 0, 0)]);
    expect(d.avgReachSpark.values).toHaveLength(1);
    expect(d.reactionsSpark.values).toHaveLength(1);
    expect(d.erSpark.values).toHaveLength(1);
  });

  it('разреженные дни публикаций не добиваются нулями', () => {
    const d = deriveSpark([
      post('2026-06-08T12:00:00.000Z', 100, 2, 0, 0),
      post('2026-06-12T12:00:00.000Z', 200, 4, 0, 0), // пропуск 09–11
    ]);
    expect(d.reactionsSpark.values).toEqual([2, 4]); // ровно два бакета, без нулевых дней между
  });
});
