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
  // Слайс качества: точные итоги периода + качество из body.totals; серии остаются дневными.
  quality: {
    bounce_rate: 34.2,
    avg_visit_duration_seconds: 96,
    page_depth: 2.77,
    new_users: 61,
    percent_new_visitors: 42,
    robot_visits: 10,
    robot_percentage: 6.9,
  },
  quality_series: {
    bounce_rate: [
      { day: '2026-07-20', value: 31.2 },
      { day: '2026-07-21', value: null },
      { day: '2026-07-22', value: 34.2 },
    ],
    avg_visit_duration_seconds: [
      { day: '2026-07-20', value: 84 },
      { day: '2026-07-21', value: null },
      { day: '2026-07-22', value: 96 },
    ],
    page_depth: [
      { day: '2026-07-20', value: 2.4 },
      { day: '2026-07-21', value: null },
      { day: '2026-07-22', value: 2.77 },
    ],
    new_users: [
      { day: '2026-07-20', value: 21 },
      { day: '2026-07-21', value: 0 },
      { day: '2026-07-22', value: 40 },
    ],
    percent_new_visitors: [
      { day: '2026-07-20', value: 38 },
      { day: '2026-07-21', value: null },
      { day: '2026-07-22', value: 42 },
    ],
    robot_visits: [
      { day: '2026-07-20', value: 4 },
      { day: '2026-07-21', value: 0 },
      { day: '2026-07-22', value: 6 },
    ],
    robot_percentage: [
      { day: '2026-07-20', value: 5.1 },
      { day: '2026-07-21', value: null },
      { day: '2026-07-22', value: 6.9 },
    ],
  },
  meta: {
    exact_period_totals: true,
    all_time: false,
    sampled: true,
    sample_share: 0.5,
    sample_size: 500,
    sample_space: 1000,
    data_lag: 7200,
  },
};

const LANDINGS = {
  goal_id: null,
  // Хвост «Ещё 3 визитов из 144» намеренно ОТЛИЧАЕТСЯ от хвоста источников, чтобы e2e-локатор
  // хвоста не совпал сразу с двумя карточками.
  visits_total: 144,
  rows: [
    { path: '/lp/promo', visits: 80, users: 60, bounce_rate: 22.5 },
    { path: '/lp/main', visits: 40, users: 35, bounce_rate: 40.1 },
    { path: '/lp/about', visits: 15, users: 12, bounce_rate: 55.0 },
    { path: '/lp/delivery', visits: 6, users: 5, bounce_rate: 60.0 },
    { path: '/lp/blog', visits: 3, users: 2, bounce_rate: 70.0 },
  ],
  meta: { sampled: false },
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

const GOALS = {
  truncated: false,
  rows: [
    { id: '11', name: 'Оформление заказа', reaches: 12, conversion_rate: 2.4 },
    { id: '22', name: 'Подписка на рассылку', reaches: 7, conversion_rate: 1.1 },
  ],
};

const UTM = {
  visits_total: 145,
  tagged_visits: 45,
  untagged_visits: 100,
  rows: [
    { id: 'instagram', name: 'instagram', visits: 30, users: 22 },
    { id: 'telegram', name: 'telegram', visits: 15, users: 12 },
  ],
};

const PAGES = {
  pageviews_total: 402,
  rows: [
    { path: '/catalog/notebooks', pageviews: 180, users: 90 },
    { path: '/', pageviews: 120, users: 80 },
    { path: '/about', pageviews: 42, users: 30 },
    { path: '/delivery', pageviews: 30, users: 22 },
    { path: '/blog/new-collection', pageviews: 20, users: 15 },
  ],
};

// Слайс аудитории/источников: реферальные сайты, соцсети, устройства. visits_total у каждого
// уникален, чтобы хвост «Ещё N визитов из M» не совпал одним локатором с несколькими карточками.
const REFERRERS = {
  visits_total: 210,
  users_total: 150,
  rows: [
    { id: null, name: 'vc.ru', visits: 90, users: 70, bounce_rate: 18.0 },
    { id: null, name: 'habr.com', visits: 60, users: 45, bounce_rate: 30.5 },
    { id: null, name: 't.me', visits: 30, users: 22, bounce_rate: 40.0 },
    { id: null, name: 'dzen.ru', visits: 20, users: 15, bounce_rate: 50.0 },
    { id: null, name: 'pikabu.ru', visits: 10, users: 8, bounce_rate: 60.0 },
  ],
  meta: {},
};

const SOCIAL = {
  visits_total: 60,
  users_total: 45,
  rows: [
    { id: 'vkontakte', name: 'ВКонтакте', visits: 40, users: 30, bounce_rate: 35.4 },
    { id: 'youtube', name: 'YouTube', visits: 10, users: 8, bounce_rate: 45.0 },
    { id: 'instagram', name: 'Instagram', visits: 10, users: 7, bounce_rate: 32.0 },
  ],
  meta: {},
};

const MESSENGERS = {
  visits_total: 34,
  users_total: 27,
  rows: [
    { id: 'telegram', name: 'Telegram', visits: 26, users: 21, bounce_rate: 28.0 },
    { id: 'whatsapp', name: 'WhatsApp', visits: 8, users: 6, bounce_rate: 37.5 },
  ],
  meta: {},
};

// Устройства: имена намеренно английские — карточка обязана локализовать по СТАБИЛЬНОМУ id
// (id '2' → «Смартфоны»), а не показывать сырое имя API. Четыре строки → без хвоста.
const DEVICES = {
  visits_total: 150,
  users_total: 105,
  rows: [
    { id: '2', name: 'Mobile', visits: 90, users: 60, bounce_rate: 41.2 },
    { id: '1', name: 'Desktop', visits: 50, users: 40, bounce_rate: 22.0 },
    { id: '3', name: 'Tablet', visits: 8, users: 4, bounce_rate: 30.0 },
    { id: '4', name: 'TV', visits: 2, users: 1, bounce_rate: 10.0 },
  ],
  meta: {},
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
    if (urlPath === '/api/ym/goals') return json(200, GOALS);
    if (urlPath === '/api/ym/utm') return json(200, UTM);
    if (urlPath === '/api/ym/pages') return json(200, PAGES);
    if (urlPath === '/api/ym/referrers') return json(200, REFERRERS);
    if (urlPath === '/api/ym/social') return json(200, SOCIAL);
    if (urlPath === '/api/ym/messengers') return json(200, MESSENGERS);
    if (urlPath === '/api/ym/devices') return json(200, DEVICES);
    if (urlPath === '/api/ym/landings') return json(200, LANDINGS);
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
  // Слайс качества: при точных итогах периода (meta.exact_period_totals) «Посетители» —
  // период-уникальные, поэтому подписи «сумма по дням» больше НЕТ (она осталась бы только на
  // «Всё» без живого токена).
  await expect(page.getByText(/сумма по дням/)).toHaveCount(0);

  // Источники: компактный топ-4 + сводный хвост (5-я строка спрятана до разворота).
  await expect(page.getByRole('heading', { name: 'Источники трафика', exact: true })).toBeVisible();
  await expect(page.getByText('Переходы из поисковых систем')).toBeVisible();
  await expect(page.getByText('Прямые заходы')).toBeVisible();
  await expect(page.getByText('Внутренние переходы')).toHaveCount(0);
  await expect(page.getByText(/Ещё 4 визитов из 145/)).toBeVisible();

  // Слайс 2 — цели: имя + reaches + конверсия отдельной метрикой.
  await expect(page.getByRole('heading', { name: 'Цели', exact: true })).toBeVisible();
  await expect(page.getByText('Оформление заказа')).toBeVisible();
  await expect(page.getByText(/CR 2,4%/)).toBeVisible();

  // Слайс 2 — UTM: размеченные строки + честная сноска о визитах без метки.
  await expect(page.getByRole('heading', { name: 'UTM-метки', exact: true })).toBeVisible();
  await expect(page.getByText('instagram', { exact: true })).toBeVisible();
  await expect(page.getByText(/Без метки — 100 визитов из 145/)).toBeVisible();

  // Слайс 2 — топ-страницы: пути, компактный топ-4 (5-я строка спрятана) + хвост «из полного отчёта».
  await expect(page.getByRole('heading', { name: 'Топ-страницы', exact: true })).toBeVisible();
  await expect(page.getByText('/catalog/notebooks')).toBeVisible();
  await expect(page.getByText('/blog/new-collection')).toHaveCount(0);
  await expect(page.getByText(/Ещё 20 просмотров из 402/)).toBeVisible();

  // Слайс аудитории/источников — реферальные сайты: внешние домены + хвост своего total.
  await expect(page.getByRole('heading', { name: 'Реферальные сайты', exact: true })).toBeVisible();
  await expect(page.getByText('vc.ru', { exact: true })).toBeVisible();
  await expect(page.getByText('pikabu.ru')).toHaveCount(0);
  await expect(page.getByText(/Ещё 10 визитов из 210/)).toBeVisible();

  // Соцсети: конкретные сети (lastsignSocialNetwork) + отказы вторичным контекстом.
  await expect(page.getByRole('heading', { name: 'Соцсети', exact: true })).toBeVisible();
  await expect(page.getByText('ВКонтакте', { exact: true })).toBeVisible();
  await expect(page.getByText(/35,4% отказов/)).toBeVisible();

  // Telegram у Метрики относится к отдельной размерности Messenger, а не SocialNetwork.
  await expect(page.getByRole('heading', { name: 'Мессенджеры', exact: true })).toBeVisible();
  await expect(page.getByText('Telegram', { exact: true })).toBeVisible();

  // Устройства: локализация по СТАБИЛЬНОМУ id (id '2' → «Смартфоны»), сырое имя API не течёт.
  await expect(page.getByRole('heading', { name: 'Устройства', exact: true })).toBeVisible();
  await expect(page.getByText('Смартфоны', { exact: true })).toBeVisible();
  await expect(page.getByText('Mobile')).toHaveCount(0);

  // Слайс качества — полоса качества трафика: отказы/средний визит/глубина/новые/доля новых.
  await expect(page.getByRole('heading', { name: 'Качество трафика', exact: true })).toBeVisible();
  await expect(page.getByText('Отказы', { exact: true })).toBeVisible();
  await expect(page.getByText('34,2%')).toBeVisible();
  await expect(page.getByText('Глубина', { exact: true })).toBeVisible();
  await expect(page.getByText('2,77')).toBeVisible();
  const qualityStrip = page.getByTestId('ym-quality-strip');
  await expect(qualityStrip.getByText('Роботы', { exact: true })).toBeVisible();
  await expect(qualityStrip.getByText('6,9% · 10', { exact: true })).toBeVisible();
  await expect(qualityStrip.getByText(/не исключены автоматически/)).toBeVisible();
  await expect(qualityStrip.locator('svg[aria-hidden="true"]')).toHaveCount(6);
  await expect(page.getByText(/выборка 50%/)).toBeVisible();
  await expect(page.getByText(/задержка данных ~2 ч/)).toBeVisible();

  // Слайс качества — страницы входа (startURLPath) с отказами по строке + селектор цели.
  // Карточка — последняя на доске; content-visibility гасит её отрисовку до подхода к вьюпорту,
  // поэтому доскролливаем заголовок в вид перед проверками.
  const landingHeading = page.getByRole('heading', { name: 'Страницы входа', exact: true });
  await landingHeading.scrollIntoViewIfNeeded();
  await expect(landingHeading).toHaveCount(1);
  await expect(page.getByText('/lp/promo')).toBeVisible();
  await expect(page.getByText(/22,5% отказов/)).toBeVisible();
  // Селектор цели виден, так как на счётчике есть цели.
  await expect(page.getByLabel('Цель для страниц входа')).toBeVisible();

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
