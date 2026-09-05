import { expect, test, type Page } from '@playwright/test';
import { bootDemo, overflowingCards } from './helpers';

/**
 * «Демография» Instagram — четыре разреза ОДНОЙ природы, значит и подача у них одна.
 *
 * Что здесь пришпилено:
 *  • четыре карточки одного размера в двух рядах по две. При третьинном размере их было три плюс
 *    одна: правило заполнения ряда (useRowFill) честно закрывало дыру, растягивая четвёртую на
 *    всю ширину — но «Топ городов» выходил втрое шире «Топ стран» при одинаковом содержимом, и
 *    разница ширин читалась как иерархия, которой нет;
 *  • ⓘ у каждой — доли у соседних карточек считаются от РАЗНЫХ знаменателей (подписчики против
 *    полного рейтинга), и молчание об этом и есть источник вопроса «почему не сходится в 100%»;
 *  • оговорка про охват стоит внутри карточки «Возраст», из чисел которой она и посчитана, а не
 *    свободным абзацем под сеткой, где отвечала сразу за все четыре знаменателя;
 *  • пустая демография называет ПОРОГ аккаунта. Прежнее «Нет данных за период» отправляло владельца
 *    крутить период, от которого снимок базы не зависит вовсе.
 *
 * Пустое состояние бутится БЕЗ pulse_demo: клиентские demoFixtures отдают IG-пути ДО сети, и
 * route-стаб под ними не срабатывает (грабля ig-period-morph).
 */

const CARDS = ['Возраст', 'Пол', 'Топ стран', 'Топ городов'];

test('демо: четыре равные карточки демографии, ⓘ у каждой, охват — внутри «Возраста»', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Двухрядная сетка — десктопная раскладка');
  await bootDemo(page, '/instagram/audience', { theme: 'dark' });
  await expect(page.getByRole('heading', { name: 'Демография' })).toBeVisible();

  const boxes = await Promise.all(
    CARDS.map(async (title) => {
      const card = page.locator('[data-widget-card]', { has: page.locator(`.widget-title:text-is("${title}")`) });
      await expect(card).toHaveCount(1);
      return (await card.boundingBox()) as { x: number; y: number; width: number; height: number };
    }),
  );
  // Равные — буквально: одна ширина и одна высота у всех четырёх.
  for (const box of boxes) {
    expect(box.width).toBeCloseTo(boxes[0].width, 0);
    expect(box.height).toBeCloseTo(boxes[0].height, 0);
  }
  // Два ряда по две: две разные вертикали и по две карточки на каждой.
  const rows = [...new Set(boxes.map((b) => Math.round(b.y)))];
  expect(rows).toHaveLength(2);
  for (const y of rows) expect(boxes.filter((b) => Math.round(b.y) === y)).toHaveLength(2);

  for (const title of CARDS) {
    await expect(page.getByRole('button', { name: `Что такое «${title}»` })).toHaveCount(1);
  }

  // Оговорка живёт В карточке «Возраст» и нигде больше — свободного абзаца под сеткой нет.
  const ageCard = page.locator('[data-widget-card]', { has: page.locator('.widget-title:text-is("Возраст")') });
  await expect(ageCard.locator('[data-breakdown-footnote]')).toContainText('Демография охватывает ≈');
  await expect(page.locator('[data-breakdown-footnote]')).toHaveCount(1);
  await expect(page.getByText('Охвачено ≈')).toHaveCount(0);

  // Примечание въезжает в бюджет тайла, а не выдавливает содержимое под кромку карточки.
  expect(await overflowingCards(page)).toEqual([]);
});

/** Подключённый аккаунт, у которого Instagram НЕ отдал ни одного разреза демографии. */
async function bootEmptyDemographics(page: Page) {
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const urlPath = new URL(request.url()).pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (urlPath === '/api/auth/me') return json(200, { uid: 42, email: 'owner@pulse.local', role: 'user', avatar: null });
    if (urlPath === '/api/channels' && request.method() === 'GET') {
      return json(200, {
        enabled: true,
        channels: [{ id: 9, username: 'bynotem', title: 'bynotem', status: 'active', source: 'ig', ig_connected: true }],
      });
    }
    if (urlPath === '/api/ig/oauth/status') {
      return json(200, {
        server_ready: true, env_fallback: false, connected: true, channel_id: 9,
        username: 'bynotem', ig_user_id: 'igid123', connected_at: '2026-07-03T10:00:00',
        token_expires_at: null, token_state: 'ok',
      });
    }
    // Аккаунт живой и НЕ мок — иначе шелл показал бы демо-панель вместо разрезов. Просто мелкий:
    // ровно та ситуация, ради которой у пустого состояния есть порог.
    if (urlPath === '/api/ig/profile') {
      return json(200, { username: 'bynotem', followers_count: 40, media_count: 3, synced_at: Date.now() });
    }
    if (urlPath.startsWith('/api/ig/')) return json(200, { data: [] });
    if (urlPath === '/api/tg/qr/status') return json(200, { connected: false, server_ready: false });
    if (urlPath === '/api/prefs') return json(200, {});
    return json(404, { error: 'not_stubbed' });
  });
  await page.addInitScript(() => {
    localStorage.setItem('pulse_channel', '9');
    localStorage.setItem('pulse_theme', 'dark');
  });
  await page.goto('/instagram/audience');
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
}

test('без демографии каждая из четырёх карточек называет порог — одним и тем же текстом', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop-поверхность Instagram');
  await bootEmptyDemographics(page);
  await expect(page.getByRole('heading', { name: 'Демография' })).toBeVisible();

  await expect(page.getByText('Instagram не отдаёт демографию')).toHaveCount(4);
  // Порог назван числом: «нужно больше подписчиков» без числа — это не ответ.
  await expect(page.getByText('Нужно не меньше 100 подписчиков', { exact: false })).toHaveCount(4);
  // Прежний текст отправлял крутить период, которым снимок базы не управляется.
  await expect(page.getByText('Нет данных за период')).toHaveCount(0);

  // Каждая карточка держит СВОЙ силуэт: три рейтинга строк и одно кольцо долей.
  const audience = page.locator('[data-widget-group-root]').first();
  await expect(audience.locator('[data-ghost="rows"]')).toHaveCount(3);
  await expect(audience.locator('[data-ghost="ring"]')).toHaveCount(1);
});
