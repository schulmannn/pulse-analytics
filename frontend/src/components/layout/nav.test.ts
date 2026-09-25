import { describe, expect, it } from 'vitest';
import { NETWORKS } from '@/lib/networks';
import { FEEDS } from '@/panels/feed/feeds';
import { isFeedRoute, routeTitle } from './nav';

/**
 * Страница ленты несёт СВОЙ FeedBlock-заголовок, поэтому общий topbar над ней не монтируется.
 * Раньше это был список, который вели руками, и он трижды отставал: «МойСклад» дописали после
 * того, как дубль уехал в прод, «Метрику» после этого, а СДЭК повторил всё заново — над «Обзором»
 * висела надпись «Atlavue» с полосой.
 *
 * Поэтому тест проверяет не список, а ИНВАРИАНТ: каждая секция каждой зарегистрированной сети
 * подавляет topbar. Новый источник, забывший про это, валит прогон — а не уезжает в прод.
 */
describe('isFeedRoute — страницы лент подавляют общий topbar', () => {
  for (const net of NETWORKS) {
    const prefix = 'prefix' in net ? net.prefix : '';
    for (const section of FEEDS[net.key].sections) {
      const route = section.section === '' ? prefix || '/' : `${prefix}/${section.section}`;
      it(`${net.key}: ${route}`, () => {
        expect(isFeedRoute(route)).toBe(true);
      });
    }
  }

  it('поверхности со своим заголовком тоже подавляют topbar', () => {
    for (const route of ['/home', '/connect', '/settings']) {
      expect(isFeedRoute(route)).toBe(true);
    }
  });

  it('страницы БЕЗ своего заголовка его получают', () => {
    for (const route of ['/metrics/views', '/reports', '/admin']) {
      expect(isFeedRoute(route)).toBe(false);
      expect(routeTitle(route)).toBeTruthy();
    }
  });
});
