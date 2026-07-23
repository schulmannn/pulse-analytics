import { expect, test, type Page } from '@playwright/test';

/**
 * Яндекс.Метрика, слайс 1: Обзор /metrika (карточки визитов/посетителей/просмотров + источники
 * трафика) и connect-флоу с выбором счётчика на /connect.
 *
 * Boot БЕЗ pulse_demo: клиентские demoFixtures «съедают» сеть, а здесь весь API замокан роутами
 * с состоянием в замыкании (паттерн connect-wizard.spec) — управляем и списком счётчиков,
 * и исходом connect'а.
 */

const SUMMARY = {
  visits: {
    total: 145,
    series: [
      { day: '2026-07-20', value: 40 },
      { day: '2026-07-21', value: 0 },
      { day: '2026-07-22', value: 105 },
    ],
  },
  users: {
    total: 98,
    series: [
      { day: '2026-07-20', value: 30 },
      { day: '2026-07-21', value: 0 },
      { day: '2026-07-22', value: 68 },
    ],
  },
  pageviews: {
    total: 402,
    series: [
      { day: '2026-07-20', value: 120 },
      { day: '2026-07-21', value: 0 },
      { day: '2026-07-22', value: 282 },
    ],
  },
};

const SOURCES = {
  visits_total: 145,
  users_total: 98,
  rows: [
    { id: 'organic', name: 'Переходы из поисковых систем', visits: 80, users: 52 },
    { id: 'direct', name: 'Прямые заходы', visits: 40, users: 30 },
    { id: 'social', name: 'Переходы из соцсетей', visits: 15, users: 10 },
    { id: 'ad', name: 'Переходы по рекламе', visits: 6, users: 4 },
    { id: 'internal', name: 'Внутренние переходы', visits: 4, users: 2 },
  ],
};

async function bootMetrika(page: Page, path: string, { connected = true } = {}) {
  const state = { connected, connectCalls: [] as Array<Record<string, unknown>> };
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const urlPath = new URL(request.url()).pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (urlPath === '/api/auth/me') return json(200, { uid: 42, email: 'owner@pulse.local', role: 'user', avatar: null });
    if (urlPath === '/api/channels' && request.method() === 'GET') {
      return json(200, {
        enabled: true,
        channels: state.connected
          ? [{ id: 9, username: null, title: 'nōtem', status: 'active', source: 'ym', ig_connected: false }]
          : [{ id: 7, username: 'demo_channel', title: 'Demo Channel', status: 'active', source: 'collector', ig_connected: false }],
      });
    }
    if (urlPath === '/api/ym/status') {
      return json(200, state.connected
        ? { connected: true, counter_name: 'nōtem', counter_id: '65383336', site: 'notem.ru' }
        : { connected: false, counter_name: null, counter_id: null, site: null });
    }
    if (urlPath === '/api/ym/summary') return json(200, SUMMARY);
    if (urlPath === '/api/ym/sources') return json(200, SOURCES);
    if (urlPath === '/api/ym/connect' && request.method() === 'POST') {
      const body = request.postDataJSON() as Record<string, unknown>;
      state.connectCalls.push(body);
      // Первый шаг (без counter_id): на аккаунте два счётчика — сервер просит выбрать.
      if (!body.counter_id) {
        return json(200, {
          ok: false,
          choice_required: true,
          counters: [
            { id: '65383336', name: 'nōtem', site: 'notem.ru' },
            { id: '111', name: 'второй проект', site: 'b.ru' },
          ],
        });
      }
      state.connected = true;
      return json(200, { ok: true, channel_id: 9, counter_name: 'nōtem', site: 'notem.ru' });
    }
    if (urlPath === '/api/tg/qr/status') return json(200, { connected: false, server_ready: false });
    if (urlPath === '/api/ig/oauth/status') return json(200, { connected: false, server_ready: false, env_fallback: false });
    return json(404, { error: 'not_stubbed' });
  });
  await page.addInitScript(({ channel }) => {
    localStorage.setItem('pulse_channel', channel);
    localStorage.setItem('pulse_theme', 'dark');
  }, { channel: connected ? '9' : '7' });
  await page.goto(path);
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  return state;
}

test('Обзор Метрики: карточки метрик, источники трафика, свой FeedBlock-заголовок без дублей', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Метрика — desktop-first поверхность');
  await bootMetrika(page, '/metrika');

  // Свой заголовок секции (FEED_ROUTES) — общий Atlavue-topbar не дублируется.
  await expect(page.getByRole('heading', { name: 'Обзор', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Atlavue', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-source-identity]')).toContainText('Метрика');

  // Три карточки метрик с итогами окна (fmt.short: 145 / 98 / 402 — без сокращения).
  await expect(page.getByRole('heading', { name: 'Визиты', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Посетители', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Просмотры страниц', exact: true })).toBeVisible();
  await expect(page.getByText('145', { exact: true })).toBeVisible();
  await expect(page.getByText('402', { exact: true })).toBeVisible();
  // Честная подпись «посетители = сумма дневных уникальных».
  await expect(page.getByText(/сумма по дням/)).toBeVisible();

  // Источники: компактный топ-4 + сводный хвост (5-я строка спрятана до разворота).
  await expect(page.getByRole('heading', { name: 'Источники трафика', exact: true })).toBeVisible();
  await expect(page.getByText('Переходы из поисковых систем')).toBeVisible();
  await expect(page.getByText('Прямые заходы')).toBeVisible();
  await expect(page.getByText('Внутренние переходы')).toHaveCount(0);
  await expect(page.getByText(/Ещё 4 визитов из 145/)).toBeVisible();

  // Период-чипсы (общий page-period контракт) на месте.
  await expect(page.getByRole('group', { name: 'Период', exact: true })).toHaveCount(1);
});

test('Подключение Метрики: токен → выбор счётчика → подключено (токен только в POST-теле)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Метрика — desktop-first поверхность');
  const state = await bootMetrika(page, '/connect?source=metrika', { connected: false });

  // Панель источника выбрана дип-линком.
  await expect(page.getByRole('heading', { name: 'Яндекс.Метрика' })).toBeVisible();
  const tokenInput = page.getByPlaceholder('OAuth-токен Яндекса');
  await tokenInput.fill('y0_test_oauth_token');
  await page.getByRole('button', { name: 'Подключить', exact: true }).click();

  // Два счётчика → сервер попросил выбрать; выбираем первый.
  await expect(page.getByText('На аккаунте несколько счётчиков — выберите, какой подключить:')).toBeVisible();
  await expect(page.getByRole('button', { name: /второй проект/ })).toBeVisible();
  await page.getByRole('button', { name: /nōtem/ }).click();

  // Мгновенный connected-отклик панели + ссылка в Обзор.
  await expect(page.getByText(/Подключён счётчик/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Открыть Обзор Метрики →' })).toBeVisible();

  // Контракт connect-флоу: первый вызов без counter_id, второй — с выбранным; токен один и тот же.
  expect(state.connectCalls).toEqual([
    { token: 'y0_test_oauth_token' },
    { token: 'y0_test_oauth_token', counter_id: '65383336' },
  ]);
});
