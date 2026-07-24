import { expect, test, type Page } from '@playwright/test';

/**
 * Яндекс.Метрика — полноэкранные метрики /metrics/ym-*. Проверяем миграцию карточек Обзора с
 * generic `?detail=` оверлея на выделенные route-страницы (грамматика эталона /metrics/ig-views):
 * клик по карточке ведёт на route (не role=dialog), прямой заход + reload держат YM-контекст,
 * у time-series есть Line/Bar + честная деградация сравнения, у breakdown — полный список без
 * выдуманного графика/типа графика.
 *
 * Boot БЕЗ pulse_demo: весь API замокан роутами (паттерн ym-overview.spec) — demo-фикстуры, не
 * прод-креды. Архив короткий (3 дня), поэтому «Пред. период»/«Год назад» обязаны честно
 * деградировать, а не рисовать выдуманный baseline.
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
  meta: { exact_period_totals: true, all_time: true, archive_last_day: '2026-07-22' },
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

// Superset empty shape valid against every remaining ym-* schema (breakdown/demographics/utm/pages/
// landings/hourly/goals/exits) so the /metrika board load in the click test raises no api-drift noise.
const EMPTY_BREAKDOWN = {
  visits_total: 0,
  users_total: 0,
  pageviews_total: 0,
  tagged_visits: 0,
  untagged_visits: 0,
  goal_id: null,
  peak_hour: null,
  known_visits: 0,
  unknown_visits: 0,
  coverage_percent: null,
  contains_sensitive_data: false,
  truncated: false,
  rows: [],
};

const YM_ROUTE_HEADINGS = {
  'ym-visits': 'Визиты',
  'ym-users': 'Посетители',
  'ym-pageviews': 'Просмотры страниц',
  'ym-hourly': 'Трафик по часам',
  'ym-sources': 'Источники трафика',
  'ym-referrers': 'Реферальные сайты',
  'ym-social': 'Соцсети',
  'ym-messengers': 'Мессенджеры',
  'ym-devices': 'Устройства',
  'ym-countries': 'Страны',
  'ym-cities': 'Города',
  'ym-age': 'Возраст',
  'ym-gender': 'Пол',
  'ym-goals': 'Цели',
  'ym-utm': 'UTM-метки',
  'ym-pages': 'Топ-страницы',
  'ym-landings': 'Страницы входа',
  'ym-exits': 'Страницы выхода',
} as const;

async function bootMetrika(page: Page, path: string) {
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const urlPath = new URL(request.url()).pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (urlPath === '/api/auth/me') return json(200, { uid: 42, email: 'owner@pulse.local', role: 'user', avatar: null });
    if (urlPath === '/api/channels' && request.method() === 'GET') {
      return json(200, {
        enabled: true,
        channels: [{ id: 9, username: null, title: 'nōtem', status: 'active', source: 'ym', ig_connected: false }],
      });
    }
    if (urlPath === '/api/ym/status') {
      return json(200, { connected: true, counter_name: 'nōtem', counter_id: '65383336', site: 'notem.ru' });
    }
    if (urlPath === '/api/ym/summary') return json(200, SUMMARY);
    if (urlPath === '/api/ym/sources') return json(200, SOURCES);
    if (urlPath === '/api/ym/goals') return json(200, GOALS);
    if (urlPath.startsWith('/api/ym/')) return json(200, EMPTY_BREAKDOWN);
    if (urlPath === '/api/tg/qr/status') return json(200, { connected: false, server_ready: false });
    if (urlPath === '/api/ig/oauth/status') return json(200, { connected: false, server_ready: false, env_fallback: false });
    return json(404, { error: 'not_stubbed' });
  });
  await page.addInitScript(() => {
    localStorage.setItem('pulse_channel', '9');
    localStorage.setItem('pulse_theme', 'dark');
  });
  await page.goto(path);
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
}

test('Клик по карточке ym-visits ведёт на /metrics/ym-visits (route, не модалка), Назад возвращает', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Метрика — desktop-first поверхность');
  await bootMetrika(page, '/metrika');

  // Клик по карточке «Визиты» на доске Обзора.
  await page.getByRole('heading', { name: 'Визиты', exact: true }).click();

  // Перешли на выделенный route, БЕЗ модального оверлея.
  await expect(page).toHaveURL(/\/metrics\/ym-visits$/);
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Визиты', level: 1 })).toBeVisible();

  // Line/Bar на месте (реальная дневная серия).
  await expect(page.getByRole('group', { name: 'Тип графика' })).toBeVisible();

  // Назад-ссылка возвращает в Обзор Метрики.
  await page.getByRole('link', { name: /Метрика · Обзор/ }).click();
  await expect(page).toHaveURL(/\/metrika$/);
  await expect(page.getByRole('heading', { name: 'Обзор', exact: true })).toBeVisible();
});

test('Прямой заход /metrics/ym-visits + reload рендерит и держит YM-контекст', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Метрика — desktop-first поверхность');
  await bootMetrika(page, '/metrics/ym-visits');

  await expect(page.getByRole('heading', { name: 'Визиты', level: 1 })).toBeVisible();
  await expect(page.locator('[data-source-identity]')).toContainText('Метрика');
  await expect(page.getByRole('group', { name: 'Тип графика' })).toBeVisible();

  await page.reload();
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  await expect(page.getByRole('heading', { name: 'Визиты', level: 1 })).toBeVisible();
  await expect(page.locator('[data-source-identity]')).toContainText('Метрика');
});

test('Сравнение time-series честно деградирует на коротком архиве', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Метрика — desktop-first поверхность');
  await bootMetrika(page, '/metrics/ym-visits');

  // Дефолт — «Пред. период»; архив 3 дня не покрывает 2×30, поэтому честная деградация, не выдуманный baseline.
  await expect(page.getByText(/недостаточно истории за прошлый период/i)).toBeVisible();

  // Bar-режим переключается без падения.
  await page.getByRole('group', { name: 'Тип графика' }).getByText('Столбцы').click();

  // Для годового сравнения тоже не подставляем неполный или синтетический baseline.
  await page.getByRole('group', { name: 'База сравнения' }).getByText('Год назад').click();
  await expect(page.getByText(/архив ym_daily пока не достаёт до прошлого года/i)).toBeVisible();
});

test('ym-sources — полный список без селектора типа графика, сравнение не рассчитывается', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Метрика — desktop-first поверхность');
  await bootMetrika(page, '/metrics/ym-sources');

  await expect(page.getByRole('heading', { name: 'Источники трафика', level: 1 })).toBeVisible();

  // Полный список: даже пятая строка (в Обзоре ушла бы в хвост) видна на route-странице.
  await expect(page.getByText('Переходы из поисковых систем')).toBeVisible();
  await expect(page.getByText('Внутренние переходы')).toBeVisible();

  // Никакого выдуманного Line/Bar на breakdown-странице.
  await expect(page.getByRole('group', { name: 'Тип графика' })).toHaveCount(0);

  // Rail «Сравнение» честно объясняет, что сравнение периодов не рассчитывается.
  await expect(page.getByText(/сравнение периодов не рассчитывается/i)).toBeVisible();

  // Атрибуция цели сохранена (на счётчике есть цели).
  await expect(page.getByLabel('Цель для источников трафика')).toBeVisible();
});

test('все 18 карточек Метрики имеют рабочую полноэкранную route-страницу без dialog-оверлея', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Метрика — desktop-first поверхность');
  test.setTimeout(90_000);
  await bootMetrika(page, '/metrics/ym-visits');

  for (const [metricKey, heading] of Object.entries(YM_ROUTE_HEADINGS)) {
    await page.goto(`/metrics/${metricKey}`);
    await expect(page).toHaveURL(new RegExp(`/metrics/${metricKey}$`));
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  }
});
