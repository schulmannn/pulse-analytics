import { describe, expect, it } from 'vitest';
import { aggregatePair, windowPair } from '@/lib/igMetrics';
import { igWindowMetrics } from '@/lib/igWindowMetrics';
import type { IgInsights } from '@/api/schemas';

/**
 * Дедуплицированный охват Instagram молча терялся НА КАЖДОМ РЕНДЕРЕ.
 *
 * Бэкенд отдаёт «охват за окно» синтетическим агрегатом из двух точек и штампует их временем
 * СВОЕГО запроса. Клиент считал верхнюю границу окна как floor(now / 60_000) * 60_000 — округление
 * ВНИЗ до минуты ради стабильности мемоизации. Серверный штамп всегда оказывался позже этой
 * границы, `windowPair` отбрасывал точку по `t > endMs`, и охват откатывался на сумму дневных.
 *
 * На проде это давало 83.3k вместо честных 26.1k при 25.4k у самого Instagram — завышение росло с
 * длиной окна (1.3× / 3.1× / 3.9× на 7/30/90 днях), потому что чем длиннее окно, тем больше
 * зрителей посчитано повторно.
 */
const AGG = (cur: number, prev: number, curEnd: string, prevEnd: string): IgInsights =>
  ({
    data: [
      {
        name: 'reach_window',
        period: 'day',
        values: [
          { end_time: prevEnd, value: prev },
          { end_time: curEnd, value: cur },
        ],
        total_value: { value: cur },
      },
    ],
  }) as unknown as IgInsights;

describe('aggregatePair — синтетический агрегат окна', () => {
  it('берёт текущее окно, даже если серверный штамп ПОЗЖЕ клиентской границы', () => {
    const now = Date.now();
    const ahead = new Date(now + 45_000).toISOString(); // сервер опередил клиента на 45 секунд
    const pair = aggregatePair(AGG(26136, 20844, ahead, new Date(now - 45 * 864e5).toISOString()), 'reach_window');
    expect(pair.hasCur).toBe(true);
    expect(pair.cur).toBe(26136);
    expect(pair.prev).toBe(20844);
  });

  // Регрессия «до»: тот же payload через date-фильтр теряет текущую точку целиком.
  it('date-фильтр на том же payload теряет текущее окно — почему и понадобился позиционный чтец', () => {
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    const ahead = new Date(now + 45_000).toISOString();
    const points = [
      { day: new Date(now - 45 * 864e5).toISOString(), value: 20844 },
      { day: ahead, value: 26136 },
    ];
    const viaDates = windowPair(points, now - 30 * 864e5, now);
    expect(viaDates.hasCur).toBe(false);
    expect(viaDates.cur).toBe(0);
  });

  // Дневной ряд агрегатом НЕ является: иначе вернули бы значение одного дня вместо суммы окна.
  it('без total_value признаёт себя неприменимым и уступает сумме дневных', () => {
    const daily = {
      data: [
        {
          name: 'views',
          period: 'day',
          values: [
            { end_time: '2026-08-09T00:00:00Z', value: 100 },
            { end_time: '2026-08-10T00:00:00Z', value: 166 },
          ],
        },
      ],
    } as unknown as IgInsights;
    const pair = aggregatePair(daily, 'views');
    expect(pair.hasCur).toBe(false);
  });

  it('метрики нет вовсе — тоже неприменим', () => {
    expect(aggregatePair({ data: [] } as unknown as IgInsights, 'reach_window').hasCur).toBe(false);
  });
});

describe('igWindowMetrics — охват берётся из дедуплицированного окна', () => {
  const DAY = 864e5;
  // Форма ответа `GET /api/ig/insights`: дневной `reach` + синтетические агрегаты окна, точки
  // которых штампуются временем СЕРВЕРНОГО запроса (здесь — на 45 с позже клиентской границы).
  function payload(until: number) {
    const ahead = new Date(until + 45_000).toISOString();
    const prevPoint = new Date(until - 45 * DAY).toISOString();
    const daily = Array.from({ length: 30 }, (_, i) => ({
      end_time: new Date(until - (29 - i) * DAY).toISOString(),
      value: 2800, // сумма 30 дней = 84 000 — те самые «83.3k» вместо 26 136
    }));
    const aggregate = (name: string, cur: number, prev: number) => ({
      name,
      period: 'day',
      values: [
        { end_time: prevPoint, value: prev },
        { end_time: ahead, value: cur },
      ],
      total_value: { value: cur },
    });
    return {
      data: [
        { name: 'reach', period: 'day', values: daily },
        aggregate('reach_window', 26136, 20844),
        aggregate('total_interactions', 5000, 4000),
        aggregate('follows', 900, 800),
        aggregate('unfollows', 300, 250),
      ],
    } as unknown as IgInsights;
  }

  const run = () => {
    const until = Math.floor(Date.now() / 60_000) * 60_000;
    return igWindowMetrics({
      profile: undefined,
      insights: payload(until),
      historyRows: undefined,
      since: until - 30 * DAY,
      until,
    });
  };

  it('охват = дедуплицированное окно, а не сумма дневных', () => {
    expect(run().pairs.reach.cur).toBe(26136);
  });

  it('ER считается от честного знаменателя (≈19%, а не ≈6%)', () => {
    expect(run().erReach).toBeCloseTo((5000 / 26136) * 100, 6);
  });

  it('прирост подписчиков не обнуляется: follows/unfollows тоже агрегаты окна', () => {
    const { followerNet } = run();
    expect(followerNet.hasCur).toBe(true);
    expect(followerNet.cur).toBe(600);
    expect(followerNet.prev).toBe(550);
  });
});
