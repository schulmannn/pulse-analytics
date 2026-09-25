import { expect, test, type Page } from '@playwright/test';
import { overflowingCards } from './helpers';

/**
 * Призрак формы в пустой карточке: карточка без данных обязана показать СИЛУЭТ того графика,
 * который нарисует, когда данные появятся, — а не полосу воздуха со значком.
 *
 * Почему именно эти поверхности. Шесть IG-карточек Главной — самый частый прод-случай «источник
 * не подключён»: раньше они давали шесть одинаковых серых полос подряд, и доска читалась как
 * сломанная. Страничный «МойСклад не подключён» — вторая природа пустоты (не окно без данных, а
 * источник, которого нет), и там призрак заменяет значок, а не встаёт рядом с ним.
 *
 * Boot БЕЗ pulse_demo: клиентские demoFixtures отдают эти пути ДО сети, и route-стаб под ними не
 * срабатывает (грабля ig-period-morph — спек годами проходил вхолостую). Весь API мокается роутами.
 */

const DAY = 24 * 60 * 60 * 1000;
const EXPIRED_AT = new Date(Date.now() - 3 * DAY).toISOString();

/** Все шесть IG-карточек реестра Главной. Дефолтная доска сеет лишь часть из них, поэтому доска
 *  задаётся явно — спек проверяет КАРТОЧКИ, а не правила сева (у тех свои юниты). */
const IG_HOME_KEYS = ['ig-reach', 'ig-follows', 'ig-movement', 'ig-compare', 'ig-insights', 'ig-kpi'];

async function bootIgHome(page: Page, mode: 'mock' | 'expired') {
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
        server_ready: true, env_fallback: false, connected: mode === 'expired', channel_id: 9,
        username: 'bynotem', ig_user_id: 'igid123', connected_at: '2026-07-03T10:00:00',
        token_expires_at: mode === 'expired' ? EXPIRED_AT : null,
        token_state: mode === 'expired' ? 'expired' : 'none',
      });
    }
    if (urlPath === '/api/ig/profile') {
      // Истёкший доступ падает различимым кодом; неподключённый аккаунт сервер отдаёт мок-профилем.
      return mode === 'expired'
        ? json(409, { error: 'Токен Instagram истёк — переподключите', code: 'ig_reauth', request_id: 'test' })
        : json(200, { mock: true, username: 'demo', followers_count: 0, media_count: 0 });
    }
    if (urlPath.startsWith('/api/ig/')) return json(200, { mock: mode !== 'expired', data: [] });
    if (urlPath === '/api/tg/qr/status') return json(200, { connected: false, server_ready: false });
    if (urlPath === '/api/prefs') return json(200, {});
    return json(404, { error: 'not_stubbed' });
  });
  await page.addInitScript(
    ({ keys }) => {
      localStorage.setItem('pulse_channel', '9');
      localStorage.setItem('pulse_theme', 'dark');
      localStorage.setItem('pulse_home_blocks', JSON.stringify({ keys }));
    },
    { keys: IG_HOME_KEYS },
  );
  await page.goto('/home');
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
}

test('Главная: неподключённый Instagram — шесть силуэтов линии и шесть путей наружу', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop-доска Главной');
  await bootIgHome(page, 'mock');

  const ghosts = page.locator('[data-slot="empty-ghost"]');
  await expect.poll(async () => ghosts.count(), { timeout: 15_000 }).toBe(IG_HOME_KEYS.length);
  // Форма карточки — линия: именно её эти шесть карточек нарисуют после подключения.
  await expect(page.locator('[data-ghost="line"]')).toHaveCount(IG_HOME_KEYS.length);
  await expect(page.getByText('Instagram не подключён')).toHaveCount(IG_HOME_KEYS.length);
  await expect(page.getByRole('link', { name: 'Подключить' })).toHaveCount(IG_HOME_KEYS.length);

  // Призрак ≠ скелетон: скелетон мерцает и молчит, призрак статичен и подписан. Если бы силуэт
  // унаследовал animate-pulse, два разных состояния слились бы в одно нечитаемое.
  await expect(page.locator('[data-slot="empty-ghost"].animate-pulse')).toHaveCount(0);
  await expect(ghosts.first()).toBeVisible();
  await expect(ghosts.first()).toHaveAttribute('aria-hidden', 'true');

  // Силуэт покрашен НЕ так, как текст рядом: если краски совпадут, пустая карточка притворится
  // наполненной (коридор альфы держит scripts/contrast-tokens.mjs, здесь — что он вообще применён).
  const [ghostColor, titleColor] = await page.evaluate(() => {
    const ghost = document.querySelector('[data-slot="empty-ghost"]');
    const title = document.querySelector('[data-slot="empty-title"]');
    return [ghost ? getComputedStyle(ghost).color : '', title ? getComputedStyle(title).color : ''];
  });
  expect(ghostColor).not.toBe('');
  expect(ghostColor).not.toBe(titleColor);

  // Силуэт растёт ТОЛЬКО в свободное место фикс-тайла (264px → тело 181px), поэтому карточка не
  // становится выше и внутренних скроллбаров не появляется. Это единственный способ убедиться,
  // что полоса не отъела место у текста: класс `flex-1` сам по себе ничего не доказывает.
  expect(await overflowingCards(page)).toEqual([]);
  const bands = await page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="empty-ghost"]')].map((el) => el.getBoundingClientRect().height),
  );
  expect(bands).toHaveLength(IG_HOME_KEYS.length);
  for (const h of bands) expect(h).toBeGreaterThan(24);
});

test('Главная: истёкший доступ говорит другое — и всё равно показывает форму', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop-доска Главной');
  await bootIgHome(page, 'expired');

  await expect.poll(async () => page.locator('[data-slot="empty-ghost"]').count(), { timeout: 15_000 }).toBe(
    IG_HOME_KEYS.length,
  );
  // Путь наружу у истёкшего доступа ДРУГОЙ — и текст, и кнопка. Призрак при этом тот же:
  // карточка обещает ту же линию, просто её нечем наполнить.
  await expect(page.getByText('Доступ к Instagram истёк')).toHaveCount(IG_HOME_KEYS.length);
  await expect(page.getByRole('link', { name: 'Переподключить' })).toHaveCount(IG_HOME_KEYS.length);
  await expect(page.getByText('Instagram не подключён')).toHaveCount(0);
});

test('Склад: у страничного «не подключён» силуэт ЗАМЕНЯЕТ значок, а не встаёт рядом', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop-обзор склада');
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const urlPath = new URL(request.url()).pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (urlPath === '/api/auth/me') return json(200, { uid: 42, email: 'owner@pulse.local', role: 'user', avatar: null });
    if (urlPath === '/api/channels' && request.method() === 'GET') {
      return json(200, {
        enabled: true,
        channels: [{ id: 7, username: 'shop', title: 'shop', status: 'active', source: 'ms' }],
      });
    }
    // 404 = канал есть, а токена МойСклада на нём нет. Ровно тот случай, ради которого страничное
    // состояние вообще существует.
    if (urlPath.startsWith('/api/ms/')) return json(404, { error: 'ms_not_connected' });
    if (urlPath === '/api/tg/qr/status') return json(200, { connected: false, server_ready: false });
    if (urlPath === '/api/prefs') return json(200, {});
    return json(404, { error: 'not_stubbed' });
  });
  await page.addInitScript(() => {
    localStorage.setItem('pulse_channel', '7');
    localStorage.setItem('pulse_theme', 'dark');
  });
  await page.goto('/sklad');
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });

  await expect(page.getByText('МойСклад не подключён')).toBeVisible({ timeout: 15_000 });
  const ghost = page.locator('[data-slot="empty-ghost"]');
  await expect(ghost).toHaveCount(1);
  await expect(ghost).toHaveAttribute('data-ghost', 'bars');
  // Значок Inbox тут не рендерится: форма и есть значок. Две иконографии в одном столбце читались
  // бы как две разные системы.
  await expect(page.locator('[data-slot="empty-icon"]')).toHaveCount(0);
});
