import { describe, expect, it } from 'vitest';
import { keepPreviousForChannel } from './keepPrevious';
import { qk } from './queryKeys';

describe('keepPreviousForChannel', () => {
  const hold = keepPreviousForChannel(7);

  it('держит прошлое окно того же канала', () => {
    expect(hold({ rows: 1 }, { queryKey: ['ms-funnel', 7, '30d'] })).toEqual({ rows: 1 });
  });

  it('НЕ переносит данные между каналами', () => {
    // Иначе на экране мелькнут числа чужого источника — прямое нарушение инварианта
    // «выбранный источник не меняется сам собой».
    expect(hold({ rows: 1 }, { queryKey: ['ms-funnel', 8, '30d'] })).toBeUndefined();
  });

  it('без предыдущего запроса отдаёт undefined, а не мусор', () => {
    expect(hold({ rows: 1 }, undefined)).toBeUndefined();
  });

  it('канал null сравнивается как значение, а не как «любой»', () => {
    const unknown = keepPreviousForChannel(null);
    expect(unknown({ rows: 1 }, { queryKey: ['ms-funnel', null, '30d'] })).toEqual({ rows: 1 });
    expect(unknown({ rows: 1 }, { queryKey: ['ms-funnel', 7, '30d'] })).toBeUndefined();
  });

  it('channelId стоит вторым элементом во всех оконных семьях — на этом держится guard', () => {
    const period = { days: 30, range: null } as never;
    const keys = [
      qk.msFunnel.window(7, period),
      qk.msSummary.window(7, period),
      qk.msStock.window(7, period),
      qk.ymSummary.window(7, period),
      qk.cdekHourly.window(7, period, 'revenue'),
      qk.historyChannel.window(7, 30),
      qk.mentionsArchive.window(7, 30, null, 50, null, null),
      qk.ig.insights(7, 30),
      qk.ig.history(7, 400),
    ];
    for (const key of keys) expect(key[1]).toBe(7);
  });
});

describe('фабрика ключей', () => {
  it('семья IG имеет общий префикс — инвалидация поканальная, а не по всем сразу', () => {
    const all = qk.ig.all(7);
    expect(all).toEqual(['ig', 7]);
    // TanStack матчит ключи поэлементно с начала: каждый ключ семьи обязан начинаться с префикса.
    for (const key of [qk.ig.profile(7), qk.ig.insights(7, 30), qk.ig.posts(7, 24),
                       qk.ig.breakdowns(7, 'last_30_days'), qk.ig.online(7), qk.ig.stories(7),
                       qk.ig.tags(7), qk.ig.history(7, 400), qk.ig.oauthStatus(7)]) {
      expect(key.slice(0, 2)).toEqual(all);
    }
    // Ключ соседнего канала под этот префикс НЕ подпадает.
    expect(qk.ig.profile(8).slice(0, 2)).not.toEqual(all);
  });

  it('root покрывает все каналы — нужен только на возврате из OAuth', () => {
    expect(qk.ig.root).toEqual(['ig']);
    for (const cid of [7, 8, null]) expect(qk.ig.profile(cid)[0]).toBe('ig');
  });

  it('msAll перечисляет префиксы всех семей склада без дублей', () => {
    const names = qk.msAll.map((family) => family[0]);
    expect(new Set(names).size).toBe(names.length);
    // Каждая семья из фабрики обязана быть в списке: иначе новая витрина молча выпадет из сброса.
    const declared = Object.entries(qk)
      .filter(([name]) => name.startsWith('ms') && name !== 'msAll')
      .map(([, family]) => (family as { all?: readonly string[] }).all?.[0])
      .filter(Boolean);
    for (const family of declared) expect(names).toContain(family);
  });

  it('ключи стабильны: тот же вход даёт тот же массив', () => {
    const period = { days: 30, range: null } as never;
    expect(qk.msFunnel.window(7, period)).toEqual(qk.msFunnel.window(7, period));
    expect(qk.ig.insights(7, 30)).toEqual(qk.ig.insights(7, 30));
  });
});
