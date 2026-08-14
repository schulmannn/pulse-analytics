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
 * Три компактные TG-карточки (Ср. охват / Реакции / Вовлечённость) несут честный спарклайн по
 * UTC-дням ПУБЛИКАЦИИ, развёрнутый на ПОЛНОЕ активное окно (владелец, 2026-08-14, «вариант 2»;
 * прежний sparse-канон 2026-07 снят): «выбрал 7 дней — вижу 7 дней». День без публикаций у
 * avg-метрики — ПРОПУСК (null → штриховка), у счётного потока — честный ноль; «Всё» (days=0)
 * безгранично и остаётся разреженным. Разворот якорится на Date.now() — фикстуры относительные.
 */
describe('deriveKpis — спарклайны TG по датам публикаций', () => {
  const MEMBERS = 5000;
  const DAYS = 7;
  const DAY = 24 * 60 * 60 * 1000;
  /** UTC-ключ дня «n дней назад» — тот же slice(0,10), которым бакетируются посты. */
  const utcDayAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
  /** Полдень UTC дня «n дней назад»: при n ≤ DAYS−2 гарантированно внутри rolling-окна. */
  const tsAgo = (n: number) => `${utcDayAgo(n)}T12:00:00.000Z`;
  /** Значение спарка в день «k дней назад» (серия развёрнута на DAYS дней по возрастанию). */
  const at = (series: { values: Array<number | null> }, k: number) => series.values[DAYS - 1 - k];
  const post = (date: string, views: number, reactions: number, forwards: number, replies: number) =>
    ({ date, views, reactions, forwards, replies });
  const deriveSpark = (
    posts: unknown[],
    inWindow: (date: string | null | undefined) => boolean = () => true,
    days: import('@/lib/period').PeriodDays = DAYS,
  ) =>
    deriveKpis(
      { channel: { memberCount: MEMBERS }, posts } as never,
      { rows: [] } as never,
      undefined,
      null,
      days,
      null,
      inWindow,
    );

  it('окно разворачивается целиком: несколько постов одного UTC-дня агрегируются, пустые дни честные', () => {
    const d = deriveSpark([
      post(`${utcDayAgo(2)}T09:00:00.000Z`, 100, 10, 2, 1),
      post(`${utcDayAgo(2)}T21:00:00.000Z`, 300, 20, 4, 3),
      post(tsAgo(1), 200, 5, 1, 0),
    ]);
    expect(d.avgReachSpark.values).toHaveLength(DAYS);
    expect(at(d.avgReachSpark, 2)).toBe(200); // (100+300)/2
    expect(at(d.avgReachSpark, 1)).toBe(200); // 200/1
    // День без публикаций: у среднего — ПРОПУСК (не ноль), у счётного потока — честный ноль.
    expect(at(d.avgReachSpark, 0)).toBeNull();
    expect(at(d.avgReachSpark, 4)).toBeNull();
    expect(at(d.reactionsSpark, 2)).toBe(30); // 10+20
    expect(at(d.reactionsSpark, 1)).toBe(5);
    expect(at(d.reactionsSpark, 0)).toBe(0);
    expect(at(d.reactionsSpark, 4)).toBe(0);
  });

  it('Вовлечённость за день = 100·(reactions + replies + forwards) ÷ member count; пустой день = 0', () => {
    const d = deriveSpark([
      post(`${utcDayAgo(2)}T09:00:00.000Z`, 100, 10, 2, 1),
      post(`${utcDayAgo(2)}T21:00:00.000Z`, 300, 20, 4, 3),
      post(tsAgo(1), 200, 5, 1, 0),
    ]);
    expect(at(d.erSpark, 2)).toBeCloseTo(0.8, 10); // 100·(30+4+6)/5000
    expect(at(d.erSpark, 1)).toBeCloseTo(0.12, 10); // 100·(5+0+1)/5000
    expect(at(d.erSpark, 0)).toBe(0);
  });

  it('серия отсортирована по возрастанию UTC-дня независимо от порядка входных постов', () => {
    const d = deriveSpark([
      post(tsAgo(1), 900, 9, 0, 0),
      post(tsAgo(3), 100, 1, 0, 0),
      post(tsAgo(2), 500, 5, 0, 0),
    ]);
    expect(at(d.reactionsSpark, 3)).toBe(1);
    expect(at(d.reactionsSpark, 2)).toBe(5);
    expect(at(d.reactionsSpark, 1)).toBe(9);
    expect(at(d.avgReachSpark, 3)).toBe(100);
    expect(at(d.avgReachSpark, 1)).toBe(900);
  });

  it('бакеты строятся только по постам точного активного окна top bar; отфильтрованный день пуст', () => {
    const cutoff = utcDayAgo(1); // всё, что позже позавчера, — вне «окна»
    const d = deriveSpark(
      [
        post(tsAgo(3), 100, 1, 0, 0),
        post(tsAgo(2), 200, 2, 0, 0),
        post(tsAgo(1), 900, 9, 0, 0),
      ],
      (date) => !!date && date < cutoff,
    );
    expect(at(d.avgReachSpark, 3)).toBe(100);
    expect(at(d.avgReachSpark, 2)).toBe(200);
    // Пост дня cutoff отфильтрован окном: его день в сетке остаётся, но ПУСТОЙ.
    expect(at(d.avgReachSpark, 1)).toBeNull();
    expect(at(d.reactionsSpark, 1)).toBe(0);
  });

  it('один день публикаций: полное окно всё равно рисуется (один столбец среди штриховки)', () => {
    const d = deriveSpark([post(tsAgo(2), 100, 1, 0, 0)]);
    expect(d.avgReachSpark.values).toHaveLength(DAYS);
    expect(d.avgReachSpark.values.filter((v) => v != null)).toHaveLength(1);
  });

  it('«Всё» (days=0) безгранично — остаётся разреженным, как раньше', () => {
    const d = deriveSpark(
      [post(tsAgo(5), 100, 2, 0, 0), post(tsAgo(1), 200, 4, 0, 0)],
      () => true,
      0,
    );
    expect(d.reactionsSpark.values).toEqual([2, 4]); // ровно два бакета, без нулевых дней между
  });
});

/**
 * Ось букв дней недели (владелец, 2026-08-14): короткое окно (≤ 8 дн.) несёт axisLabels —
 * однобуквенные латинские дни недели; labels ОСТАЮТСЯ полными датами (тултип). Длинное окно
 * и «всё время» осей-букв не получают.
 */
describe('deriveKpis — axisLabels короткого окна', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const utcDayAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);
  const withPosts = (days: import('@/lib/period').PeriodDays) =>
    deriveKpis(
      {
        channel: { memberCount: 5000 },
        // Разреженные дни публикаций внутри окна (6, 5 и 3 дня назад, полдень UTC).
        posts: [6, 5, 3].map((ago) => ({
          date: `${utcDayAgo(ago)}T12:00:00.000Z`,
          views: 100,
          reactions: 1,
          forwards: 0,
          replies: 0,
        })),
      } as never,
      { rows: [6, 5, 4, 3].map((ago) => ({ day: utcDayAgo(ago), views: 100, subscribers: 5000 })) } as never,
      undefined,
      null,
      days,
      null,
      () => true,
    );

  it('7-дневное окно: спарки публикаций (развёрнутые) и канальных просмотров несут буквы, labels — даты', () => {
    const d = withPosts(7);
    // Публикационные серии развёрнуты на полное окно → буква на каждый из 7 дней.
    const fullWeek = [6, 5, 4, 3, 2, 1, 0].map((ago) => fmt.weekday(utcDayAgo(ago)));
    expect(d.reactionsSpark.axisLabels).toEqual(fullWeek);
    expect(d.avgReachSpark.axisLabels).toEqual(fullWeek);
    expect(d.erSpark.axisLabels).toEqual(fullWeek);
    // Канальные просмотры идут по архиву (4 строки) — буквы по его дням.
    expect(d.viewsSpark.axisLabels).toEqual([6, 5, 4, 3].map((ago) => fmt.weekday(utcDayAgo(ago))));
    // Полные даты не тронуты — тултип по-прежнему называет день.
    expect(d.reactionsSpark.labels[0]).toBe(fmt.day(utcDayAgo(6)));
  });

  it('30-дневное окно и «всё время» остаются на датах (axisLabels нет)', () => {
    expect(withPosts(30).reactionsSpark.axisLabels).toBeUndefined();
    expect(withPosts(30).viewsSpark.axisLabels).toBeUndefined();
    expect(withPosts(0).reactionsSpark.axisLabels).toBeUndefined();
  });
});
