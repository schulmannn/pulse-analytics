import { expect, test, type Page } from '@playwright/test';

/**
 * Instagram CHART cards — полноэкранные /metrics/ig-*. Проверяет миграцию карточек Аудитории/Контента
 * (Возраст/Пол/Топ стран/Топ городов, Лучшее время — heatmap, Вовлечённость по форматам, Ср. время
 * просмотра по Reels, Навигация по историям) с generic `?detail=` оверлея на выделенные route-страницы
 * той же грамматики, что эталон /metrics/ig-reach и /metrics/tg-*·/metrics/ym-*: клик по карточке ведёт
 * на route (не role=dialog), прямой заход держит IG-контекст, ни на одной странице нет фабрикованного
 * сравнения периодов, у breakdown/heatmap нет выбора Line/Bar, а stale `?detail=` канонизируется в route.
 *
 * Стейт живёт в замыкании мока (как настоящая БД) — тот же приём, что e2e/ig-content.spec.ts.
 */

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const IG_POSTS = [
  {
    id: 'reel1', timestamp: iso(1 * DAY), media_type: 'VIDEO', media_product_type: 'REELS',
    reach: 4000, views: 12000, like_count: 200, comments_count: 20, saved: 40, shares: 25, total_interactions: 285,
    caption: 'reel drop', ig_reels_avg_watch_time: 8200, ig_reels_video_view_total_time: 3_600_000,
  },
  {
    id: 'feed1', timestamp: iso(2 * DAY), media_type: 'IMAGE', media_product_type: 'FEED',
    reach: 3000, views: 3200, like_count: 120, comments_count: 12, saved: 20, shares: 10, total_interactions: 162, caption: 'photo',
  },
];

const IG_BREAKDOWNS = {
  mock: false,
  data: [
    {
      name: 'follower_demographics',
      total_value: {
        breakdowns: [
          { dimension_keys: ['age'], results: [{ dimension_values: ['25-34'], value: 400 }, { dimension_values: ['18-24'], value: 300 }] },
          { dimension_keys: ['gender'], results: [{ dimension_values: ['F'], value: 600 }, { dimension_values: ['M'], value: 400 }] },
          { dimension_keys: ['country'], results: [{ dimension_values: ['RU'], value: 500 }, { dimension_values: ['US'], value: 200 }] },
          { dimension_keys: ['city'], results: [{ dimension_values: ['Moscow, Moscow'], value: 300 }] },
        ],
      },
    },
    {
      name: 'total_interactions',
      total_value: {
        breakdowns: [
          { dimension_keys: ['media_product_type'], results: [{ dimension_values: ['REELS'], value: 900 }, { dimension_values: ['FEED'], value: 500 }] },
        ],
      },
    },
  ],
};

const IG_ONLINE = {
  mock: false,
  data: [{ values: [{ end_time: iso(1 * DAY), value: { '9': 40, '18': 120, '21': 80 } }] }],
};

const IG_STORIES = {
  mock: false,
  data: [
    { id: 's1', timestamp: iso(0.2 * DAY), expires_at: iso(-0.8 * DAY), media_type: 'IMAGE', views: 500, reach: 480, replies: 4, navigation: { tap_forward: 120, tap_exit: 30, swipe_forward: 18 } },
  ],
};

async function boot(page: Page, route: string, campaignMembers: string[] = []) {
  await page.route(/^https?:\/\/[^/]+\/api\//, async (r) => {
    const path = new URL(r.request().url()).pathname;
    const method = r.request().method();
    const json = (status: number, body: unknown) =>
      r.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/api/auth/me') return json(200, { uid: 11, email: 'e2e@test.local', role: 'user', avatar: null });
    if (path === '/api/channels') {
      return json(200, {
        enabled: true,
        channels: [{ id: 1, username: 'igacct', title: 'IG аккаунт', status: 'active', source: 'ig', ig_connected: true }],
        selected: 1,
      });
    }
    if (path === '/api/prefs') return json(200, method === 'GET' ? {} : { ok: true });

    if (path === '/api/ig/profile') return json(200, { mock: false, username: 'igacct', name: 'IG аккаунт', followers_count: 12000, synced_at: Date.now() });
    if (path === '/api/ig/insights') return json(200, { mock: false, data: [] });
    if (path === '/api/ig/posts') return json(200, { mock: false, data: IG_POSTS });
    if (path === '/api/ig/breakdowns') return json(200, IG_BREAKDOWNS);
    if (path === '/api/ig/online') return json(200, IG_ONLINE);
    if (path === '/api/ig/stories') return json(200, IG_STORIES);
    if (path === '/api/ig/tags') return json(200, { mock: false, data: [] });
    if (path === '/api/ig/history') return json(200, { enabled: true, rows: [] });
    if (path === '/api/ig/oauth/status') return json(200, { connected: true });
    if (path === '/api/campaigns' && method === 'GET') {
      return json(200, {
        campaigns:
          campaignMembers.length > 0
            ? [{
                id: 1,
                workspace_id: 1,
                name: 'Запуск',
                status: 'active',
                post_count: campaignMembers.length,
                my_role: 'owner',
              }]
            : [],
      });
    }
    if (path === '/api/campaigns/1/posts' && method === 'GET') {
      return json(200, {
        posts: campaignMembers.map((postRef) => ({
          network: 'ig',
          channel_id: 1,
          post_ref: postRef,
          accessible: true,
        })),
        inaccessible_count: 0,
      });
    }
    return json(404, { error: 'not_mocked' });
  });

  await page.addInitScript(() => {
    localStorage.setItem('pulse_token', 'e2e-token');
    localStorage.setItem('pulse_token_exp', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('pulse_channel', '1');
    localStorage.setItem('pulse_theme', 'dark');
  });
  await page.goto(route);
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
}

/** term (h1) — точное имя карточки-источника; periodControl — есть ли тайм-бар «Окно». */
const IG_ROUTES: { key: string; heading: string; periodControl: boolean }[] = [
  { key: 'ig-age', heading: 'Возраст', periodControl: false },
  { key: 'ig-gender', heading: 'Пол', periodControl: false },
  { key: 'ig-countries', heading: 'Топ стран', periodControl: false },
  { key: 'ig-cities', heading: 'Топ городов', periodControl: false },
  { key: 'ig-best-time', heading: 'Лучшее время для публикации', periodControl: false },
  { key: 'ig-format-engagement', heading: 'Вовлечённость по форматам', periodControl: true },
  { key: 'ig-reels-watch-time', heading: 'Ср. время просмотра по Reels', periodControl: true },
  { key: 'ig-story-navigation', heading: 'Навигация по историям', periodControl: false },
];

test.describe('Instagram chart cards — /metrics/ig-*', () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'IG Аудитория/Контент — desktop-first поверхности');
  });

  for (const route of IG_ROUTES) {
    test(`прямой заход /metrics/${route.key} рендерит полноэкранно, IG-контекст, без dialog`, async ({ page }) => {
      await boot(page, `/metrics/${route.key}`);

      await expect(page.getByRole('heading', { name: route.heading, level: 1 })).toBeVisible();
      await expect(page.getByText('Instagram @igacct')).toBeVisible();
      // Никогда не generic-оверлей — это выделенный route.
      await expect(page.locator('[role="dialog"]')).toHaveCount(0);
      // Ни одна страница не фабрикует сравнение периодов и не даёт выбора Line/Bar.
      await expect(page.getByRole('group', { name: 'База сравнения' })).toHaveCount(0);
      await expect(page.getByRole('group', { name: 'Тип графика' })).toHaveCount(0);
      // Тайм-бар окна есть только у пост/timeframe-производных страниц.
      await expect(page.getByRole('group', { name: 'Окно' })).toHaveCount(route.periodControl ? 1 : 0);
    });
  }

  test('клик по «Возраст» на /instagram/audience ведёт на route, не открывает dialog', async ({ page }) => {
    await boot(page, '/instagram/audience');
    await page.getByRole('heading', { name: 'Возраст', exact: true }).click();

    await expect(page).toHaveURL(/\/metrics\/ig-age$/);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Возраст', level: 1 })).toBeVisible();
    // Назад ведёт в Аудиторию.
    await page.getByRole('link', { name: /Instagram · Аудитория/ }).click();
    await expect(page).toHaveURL(/\/instagram\/audience$/);
  });

  test('клик по heatmap «Лучшее время для публикации» ведёт на /metrics/ig-best-time', async ({ page }) => {
    await boot(page, '/instagram/audience');
    await page.getByRole('heading', { name: 'Лучшее время для публикации', exact: true }).click();

    await expect(page).toHaveURL(/\/metrics\/ig-best-time$/);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Лучшее время для публикации', level: 1 })).toBeVisible();
    // Heatmap — своя форма: ни выбора типа графика, ни тайм-бара.
    await expect(page.getByRole('group', { name: 'Тип графика' })).toHaveCount(0);
  });

  test('клик по «Вовлечённость по форматам» на /instagram/content ведёт на route', async ({ page }) => {
    await boot(page, '/instagram/content');
    await page.getByRole('heading', { name: 'Вовлечённость по форматам', exact: true }).click();

    await expect(page).toHaveURL(/\/metrics\/ig-format-engagement$/);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Вовлечённость по форматам', level: 1 })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Окно' })).toBeVisible();
  });

  test('campaign scope сохраняется в content-card → fullscreen → back и ограничивает данные', async ({ page }) => {
    await boot(page, '/instagram/content?more=formats&campaign=1', ['reel1']);
    await page.getByRole('heading', { name: 'Вовлечённость по форматам', exact: true }).click();

    await expect(page).toHaveURL(/\/metrics\/ig-format-engagement\?campaign=1$/);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(page.getByText('Reels', { exact: true })).toBeVisible();
    // Account-level breakdown contains Feed, but the selected campaign contains only reel1.
    await expect(page.getByText('Лента', { exact: true })).toHaveCount(0);

    await page.getByRole('link', { name: /Instagram · Контент/ }).click();
    await expect(page).toHaveURL(/\/instagram\/content\?more=formats&campaign=1$/);
  });

  test('stale ?detail=<мигрированная-карточка> канонизируется в /metrics/ig-age без dialog', async ({ page }) => {
    await boot(page, '/instagram/audience?detail=Возраст');

    await expect(page).toHaveURL(/\/metrics\/ig-age$/);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Возраст', level: 1 })).toBeVisible();
  });
});
