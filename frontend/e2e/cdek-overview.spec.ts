import { expect, test, type Page } from '@playwright/test';
import { overflowingCards } from './helpers';

// «Обзор» СДЭКа на стабах: демо-режим read-only и не знает cdek-каналов, поэтому полный перехват
// /api/ со своими ответами. Спека бьёт по тому, что легко сломать незаметно: подпись выручки
// («без отмен и складских движений»), тип графика у каждой карточки и честное «сравнивать не с чем»
// на окне «Всё».

const DAY = 86_400_000;

/** Ряд по дням: детерминированный, но с разбросом — иначе даунсэмпл и ось нечего проверять. */
function series(count: number, from: number) {
  return Array.from({ length: count }, (_, i) => ({
    day: new Date(from + i * DAY).toISOString().slice(0, 10),
    revenue: 8000 + ((i * 37) % 11) * 900,
    orders: 2 + (i % 4),
    items: 2 + (i % 4),
  }));
}

const CURRENT = {
  revenue: 3_076_319.32,
  orders: 1035,
  items: 1061,
  avg_check: 2972.29,
  orders_all: 1095,
  orders_cancelled: 59,
  orders_returned: 1,
  cancel_share: 59 / 1095,
};

const PREVIOUS = { ...CURRENT, revenue: 2_500_000, orders: 900, avg_check: 2777.78 };

const CHANNELS = [
  { key: 'own', title: null, article: null, sku: null, revenue: 1_483_260, orders: 419, items: 430, prev_revenue: 1_200_000, prev_orders: 380 },
  { key: 'yandex_market', title: null, article: null, sku: null, revenue: 995_385, orders: 364, items: 370, prev_revenue: 1_050_000, prev_orders: 390 },
  { key: 'wildberries', title: null, article: null, sku: null, revenue: 547_932, orders: 234, items: 240, prev_revenue: 240_000, prev_orders: 120 },
  { key: 'ozon', title: null, article: null, sku: null, revenue: 45_992, orders: 17, items: 18, prev_revenue: 10_000, prev_orders: 4 },
];

const STATUSES = [
  { key: 'complete', title: null, article: null, sku: null, revenue: 2_900_000, orders: 957, items: 980, prev_revenue: 0, prev_orders: 0 },
  { key: 'delivery', title: null, article: null, sku: null, revenue: 176_319, orders: 78, items: 80, prev_revenue: 0, prev_orders: 0 },
  { key: 'cancel', title: null, article: null, sku: null, revenue: 251_703, orders: 59, items: 60, prev_revenue: 0, prev_orders: 0 },
  { key: 'return', title: null, article: null, sku: null, revenue: 2850, orders: 1, items: 1, prev_revenue: 0, prev_orders: 0 },
];

// Порядок — по убыванию выручки, как отдаёт сервер: ранг не пересортировывает строки сам.
const PRODUCTS = [
  { key: 'p2', title: 'Городской рюкзак — Чёрный', article: 'BP-01-16-KK', sku: 'BP-01-16-KK', revenue: 455_430, orders: 57, items: 57, prev_revenue: 500_000, prev_orders: 62 },
  { key: 'p1', title: 'Чехол для ноутбука «плотно™» — 14"', article: 'CS-B14', sku: 'CS-B14', revenue: 276_450, orders: 97, items: 97, prev_revenue: 200_000, prev_orders: 70 },
];

const fold = (rows: typeof CHANNELS) => ({
  revenue: rows.reduce((s, r) => s + r.revenue, 0),
  orders: rows.reduce((s, r) => s + r.orders, 0),
  items: rows.reduce((s, r) => s + r.items, 0),
  prev_revenue: rows.reduce((s, r) => s + r.prev_revenue, 0),
  prev_orders: rows.reduce((s, r) => s + r.prev_orders, 0),
  groups: rows.length,
});

async function bootOverview(page: Page, { all = false }: { all?: boolean } = {}) {
  const from = Date.now() - 30 * DAY;
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/api/auth/me') return json(200, { uid: 11, email: 'cdek@test.local', role: 'user', avatar: null });
    if (path === '/api/channels') {
      return json(200, {
        enabled: true,
        channels: [{ id: 5, username: null, title: 'Склад Москва', status: 'active', source: 'cdek' }],
        selected: 5,
      });
    }
    if (path === '/api/prefs') return json(200, request.method() === 'GET' ? {} : { ok: true });
    if (path === '/api/cdek/status') {
      return json(200, { channel_id: 5, title: 'Склад Москва', warehouse_code: '19821', tz: 'Europe/Moscow', last_import: null });
    }

    const window = { days: all ? 0 : 30, from: all ? null : '2026-07-01', to: all ? null : '2026-07-30', all };
    const previousWindow = all ? null : { from: '2026-06-01', to: '2026-06-30' };

    if (path === '/api/cdek/summary') {
      return json(200, {
        window,
        previous_window: previousWindow,
        include: 'revenue',
        current: CURRENT,
        previous: all ? null : PREVIOUS,
        bounds: { first_day: '2025-07-31', last_day: '2026-07-30', orders: 1100 },
      });
    }
    if (path === '/api/cdek/series') {
      return json(200, { window, grain: 'day', include: 'revenue', current: series(30, from), previous: all ? [] : series(30, from - 30 * DAY) });
    }
    if (path === '/api/cdek/breakdown') {
      const dim = url.searchParams.get('dim');
      const rows = dim === 'status' ? STATUSES : dim === 'product' ? PRODUCTS : CHANNELS;
      return json(200, { window, dim, include: dim === 'status' ? 'all' : 'revenue', rows, other: null, total: fold(rows), truncated: false });
    }
    return json(404, { error: 'not_stubbed' });
  });

  await page.addInitScript(() => {
    localStorage.setItem('pulse_channel', '5');
    localStorage.setItem('pulse_theme', 'dark');
  });
  await page.goto('/cdek');
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  await page.waitForTimeout(900);
}

test.beforeEach(({ page: _page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'СДЭК — desktop-first поверхность');
});

/** Карточка ищется по своему заголовку — тот же приём, что у card-tint-default. */
const card = (page: Page, title: string | RegExp) =>
  page.locator('section[data-widget-size]').filter({ has: page.getByRole('heading', { name: title }) });

test('выручка подписана честно: это продажи, а не вся сумма файла', async ({ page }) => {
  // Без подписи 3 076 319 ₽ читается как «всё, что в выгрузке» — а это на 428 тыс меньше наивной
  // суммы, потому что отмены и складские движения из неё вычтены.
  await bootOverview(page);
  const widget = card(page, 'Выручка');
  await expect(widget).toContainText('без отмен и складских движений');
  // Hero идёт через цифровой морф (NumberFlow): в DOM рядом с числом лежит барабан цифр, поэтому
  // совпадение проверяется по самому числу, а не по строке целиком.
  await expect(widget).toContainText('3 076 319');
});

test('каждая карточка ведёт своим типом графика', async ({ page }) => {
  await bootOverview(page);
  // Заказы — дискретный счёт: столбцы, а не линия.
  await expect(card(page, 'Заказы').locator('rect').first()).toBeVisible();
  // Средний чек — уровень: линия, а не столбцы.
  await expect(card(page, 'Средний чек').locator('path').first()).toBeVisible();
  // Каналы продаж — единственное кольцо на весь источник.
  await expect(card(page, 'Каналы продаж').locator('svg').first()).toBeVisible();
  await expect(card(page, 'Каналы продаж')).toContainText('Своя доставка');
});

test('статусы идут строками с точными числами, а не сектором в 0.09%', async ({ page }) => {
  await bootOverview(page);
  const widget = card(page, 'Статусы заказов');
  await expect(widget).toContainText('Завершён');
  await expect(widget).toContainText('Отменён');
  // Возврат — один заказ из 1095. В кольце такой сектор был бы неразличим, в строке он читается.
  await expect(widget).toContainText('Возврат');
});

test('переключатель каналов меняет величину, а не только подпись', async ({ page }) => {
  await bootOverview(page);
  const widget = card(page, 'Каналы продаж');
  await expect(widget).toContainText('1 483 260');
  await widget.getByRole('button', { name: 'Заказы' }).click();
  // Переключатель меняет ВЕЛИЧИНУ: 1 483 260 ₽ своей доставки становятся её 419 заказами.
  await expect(widget).toContainText('419');
  await expect(widget).not.toContainText('1 483 260');
});

test('топ товаров — ранг с базой прошлого окна', async ({ page }) => {
  await bootOverview(page);
  const widget = card(page, /^Топ товаров/);
  await expect(widget).toContainText('Городской рюкзак');
  await expect(widget).toContainText('Прошлое окно');
});

test('«Всё» не выдумывает сравнение: вклад в изменение честно пустует', async ({ page }) => {
  await bootOverview(page, { all: true });
  const widget = card(page, 'Что изменило выручку');
  await expect(widget).toContainText('сравнивать не с чем');
});

test('на окне со сравнением видно, кто добавил выручки, а кто отнял', async ({ page }) => {
  await bootOverview(page);
  const widget = card(page, 'Что изменило выручку');
  await expect(widget).toContainText('Wildberries');
  await expect(widget).toContainText('Яндекс.Маркет');
});

test('ни одна карточка не переполняется внутренним скроллом', async ({ page }) => {
  // Кольцо каналов на проде обрезалось снизу: PieChart берёт высоту ВСЕГО тела тайла из контекста
  // и рисовал себя во всю её величину, не зная про переключатель метрики над собой. Гейт меряет
  // всю доску, а не первый экран, — тела карточек грузятся по появлению.
  await bootOverview(page);
  expect(await overflowingCards(page)).toEqual([]);
});

test('«Развернуть» ведёт на страницу метрики, как у соседних источников', async ({ page }) => {
  // Пока у карточек не было drillTo, разворот падал в инлайновый оверлей — источник вёл себя
  // не как МойСклад и Метрика (жалоба владельца).
  await bootOverview(page);
  const btn = page.getByRole('button', { name: 'Развернуть виджет «Выручка»' });
  await btn.focus();
  await btn.press('Enter');
  await expect(page).toHaveURL(/\/metrics\/cdek-revenue/);
  await expect(page.getByRole('heading', { name: 'Выручка', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: /СДЭК · Обзор/ })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'Тип графика' })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: 'База сравнения' })).toBeVisible();
  await expect(page.getByText('без отмен, возвратов и складских движений')).toBeVisible();
});
