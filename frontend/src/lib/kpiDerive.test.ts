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
