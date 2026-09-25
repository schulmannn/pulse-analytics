import { expect, test, type Page } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Геометрия ряда таблицы контента Instagram (аудит #554, D10). До правки подпись «+44% к медиане»
 * не помещалась в колонку метрики (73–113 px) и переносилась на две строки, а «на уровне медианы»
 * — на три: ряд раздувался с 67 до 81 px. Слово формата в квадрате превью 40 px («Альбом» — 45 px)
 * обрезалось, а дата печаталась «8 авг., 15:26» против «31 авг. 12:24» в таблице Telegram.
 *
 * Гейт держит три инварианта разом, потому что чинились они одной правкой: подпись к медиане —
 * ровно одна строка, превью без обложки — пиктограмма (а не обрезанное слово), дата — в том же
 * виде, что и в таблице Telegram.
 */

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

// Шесть публикаций (≥ MEDIAN_MIN_SAMPLE = 5, иначе дельты к медиане скрыты). Значения подобраны
// так, чтобы воспроизвести ОБА старых переноса: у репостов медиана ровно 6 → две строки читаются
// «на уровне медианы» (три строки в старой вёрстке), а охват 120 против медианы 1050 даёт «−89% к
// медиане» (две строки). Карусель обязательна — её словесный фолбэк превью был самым длинным.
const POSTS = [
  { id: 'p1', timestamp: iso(1 * DAY), media_type: 'CAROUSEL_ALBUM', reach: 9000, views: 9400, like_count: 300, comments_count: 30, saved: 60, shares: 30, total_interactions: 420, caption: 'карусель кейса' },
  { id: 'p2', timestamp: iso(2 * DAY), media_type: 'VIDEO', media_product_type: 'REELS', reach: 4000, views: 12000, like_count: 200, comments_count: 20, saved: 40, shares: 12, total_interactions: 272, caption: 'reel drop' },
  { id: 'p3', timestamp: iso(3 * DAY), media_type: 'IMAGE', reach: 1100, views: 1200, like_count: 60, comments_count: 6, saved: 12, shares: 6, total_interactions: 84, caption: 'фото среды' },
  { id: 'p4', timestamp: iso(4 * DAY), media_type: 'VIDEO', media_product_type: 'FEED', reach: 1000, views: 1500, like_count: 55, comments_count: 5, saved: 10, shares: 6, total_interactions: 76, caption: 'видео в ленте' },
  { id: 'p5', timestamp: iso(6 * DAY), media_type: 'IMAGE', reach: 900, views: 950, like_count: 40, comments_count: 4, saved: 8, shares: 4, total_interactions: 56, caption: 'тихое фото' },
  { id: 'p6', timestamp: iso(8 * DAY), media_type: 'IMAGE', reach: 120, views: 130, like_count: 5, comments_count: 1, saved: 1, shares: 2, total_interactions: 9, caption: 'слабый пост' },
];

async function boot(page: Page) {
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/api/auth/me') return json(200, { uid: 11, email: 'e2e@test.local', role: 'user', avatar: null });
    if (path === '/api/channels') {
      return json(200, {
        enabled: true,
        channels: [{ id: 1, username: 'igacct', title: 'IG аккаунт', status: 'active', source: 'ig', ig_connected: true }],
        selected: 1,
      });
    }
    if (path === '/api/prefs') return json(200, {});
    if (path === '/api/ig/profile') return json(200, { mock: false, username: 'igacct', name: 'IG аккаунт', followers_count: 12000, synced_at: Date.now() });
    if (path === '/api/ig/posts') return json(200, { mock: false, data: POSTS });
    if (path === '/api/ig/history') return json(200, { enabled: true, rows: [] });
    if (path.startsWith('/api/ig/')) return json(200, { mock: false, data: [] });
    if (path === '/api/campaigns') return json(200, { campaigns: [] });
    return json(404, { error: 'not_mocked' });
  });
  await page.addInitScript(() => {
    localStorage.setItem('pulse_channel', '1');
    localStorage.setItem('pulse_theme', 'dark');
  });
}

test.describe('Таблица контента Instagram — геометрия ряда (D10)', () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-таблица скрыта на мобильном');
  });

  test('подпись к медиане не переносится и не раздувает ряд', async ({ page }, testInfo) => {
    await boot(page);
    await page.goto('/instagram/content');

    const rows = page.locator('[data-ig-content-table] tbody tr');
    await expect(rows).toHaveCount(POSTS.length); // мерим таблицу, а не пустую страницу
    // Подпись ищется СТРУКТУРНО (второй span ячейки метрики), а не по тексту или атрибуту: гейт
    // должен падать на самой геометрии, а не на том, что старая разметка называлась иначе.
    const deltas = page.locator('[data-ig-content-table] tbody td > span:nth-child(2)');
    // Дельты вообще есть: без них гейт ниже был бы вакуумным.
    expect(await deltas.count()).toBeGreaterThanOrEqual(POSTS.length);

    const geometry = await page.evaluate(() => {
      const table = document.querySelector('[data-ig-content-table]') as HTMLElement;
      // Перенос виден только по числу строчных боксов, которые реально занял текст.
      const lineBoxes = (el: Element) => {
        const range = document.createRange();
        range.selectNodeContents(el);
        return range.getClientRects().length;
      };
      const cells = Array.from(table.querySelectorAll('tbody td > span:nth-child(2)'));
      const heights = Array.from(table.querySelectorAll('tbody tr')).map((tr) =>
        Math.round(tr.getBoundingClientRect().height),
      );
      return {
        multiline: cells.filter((el) => lineBoxes(el) > 1).map((el) => (el.textContent ?? '').trim()),
        maxRow: Math.max(...heights),
        spread: Math.max(...heights) - Math.min(...heights),
      };
    });

    // Ровно одна строка на подпись — это и есть D10.
    expect(geometry.multiline).toEqual([]);
    // Ряд держится в габарите превью (40 px + отбивки), как в таблице Telegram (64–65 px).
    expect(geometry.maxRow).toBeLessThanOrEqual(64);
    // И ни один ряд не выше соседей из-за своей подписи.
    expect(geometry.spread).toBeLessThanOrEqual(2);
    // Смысл сокращённой подписи не теряется: «к медиане за период» переехало в title, а нулевая
    // дельта (тот самый ряд, что раньше нёс «на уровне медианы» на трёх строках) читается «±0%».
    const titled = page.locator('[data-ig-content-table] tbody [title="к медиане за период"]');
    expect(await titled.count()).toBe(await deltas.count());
    await expect(titled.filter({ hasText: '±0%' }).first()).toBeVisible();

    await testInfo.attach('ig-content-row-geometry', { body: await page.screenshot(), contentType: 'image/png' });
  });

  test('превью без обложки — пиктограмма формата, а не обрезанное слово', async ({ page }) => {
    await boot(page);
    await page.goto('/instagram/content');
    await expect(page.locator('[data-ig-content-table] tbody tr')).toHaveCount(POSTS.length);

    // Квадрат превью ищется СТРУКТУРНО (вторая колонка ряда): гейт обязан падать на том, что
    // содержимое не влезло, а не на отсутствии нового data-атрибута.
    const thumbs = page.locator('[data-ig-content-table] tbody td:nth-child(2) > div');
    await expect(thumbs).toHaveCount(POSTS.length);
    const clipped = await thumbs.evaluateAll((nodes) =>
      nodes
        .filter((el) => {
          const box = el.getBoundingClientRect().width;
          return Array.from(el.children).some((child) => child.getBoundingClientRect().width > box);
        })
        .map((el) => (el.textContent ?? '').trim()),
    );
    // Ничего не обрезано рамкой 40 px — это и есть вторая половина D10.
    expect(clipped).toEqual([]);

    // Карусель — самое длинное слово формата (45 px в квадрате 40 px); теперь это пиктограмма,
    // а точный формат называет title тем же словом, что и тег в колонке «Публикация».
    const carousel = page.locator('[data-ig-content-table] tbody [data-ig-content-thumb="Карусель"]');
    await expect(carousel).toHaveCount(1);
    await expect(carousel).toHaveAttribute('title', 'Карусель');
    await expect(carousel.locator('svg')).toHaveCount(1);
  });

  test('дата в таблице Instagram печатается тем же форматом, что и в таблице Telegram', async ({ page }) => {
    // День и время двумя строками, без запятой: «10 авг.» / «02:58». Склеиваем innerText, поэтому
    // регулярка одна на обе таблицы — именно это и значит «один формат даты».
    const SHAPE = /^\d{1,2}\s[а-я]+\.?\s?\d{2}:\d{2}$/;

    await bootDemo(page, '/posts');
    const tgDate = page.locator('table tbody tr').first().locator('td').last();
    await expect(tgDate).toBeVisible();
    const tgText = (await tgDate.innerText()).replace(/\s+/g, ' ').trim();
    expect(tgText).toMatch(SHAPE);

    await bootDemo(page, '/instagram/content');
    const igRow = page.locator('[data-ig-content-table] tbody tr').first();
    await expect(igRow).toBeVisible();
    const igText = (await igRow.locator('td').nth(-2).innerText()).replace(/\s+/g, ' ').trim();
    expect(igText).toMatch(SHAPE);
    expect(igText).not.toContain(',');
  });
});
