import { expect, test, type Page } from '@playwright/test';
import { overflowingCards } from './helpers';

// «Товары» СДЭКа. Главное, что проверяется, — размах цены: у большинства товаров склада цена
// продажи плавает, и средняя её прячет. Если таблица начнёт показывать одну усреднённую цифру,
// история скидок маркетплейсов исчезнет молча.

const DAY = 86_400_000;

const PRODUCTS = [
  {
    key: 'p1', title: 'Городской рюкзак — Чёрный', article: 'BP-01-16-KK', sku: 'BP-01-16-KK',
    revenue: 455_430, orders: 57, items: 57, prev_revenue: 400_000, prev_orders: 50,
    price_min: 7290, price_median: 7990, price_max: 8490,
  },
  {
    key: 'p2', title: 'Чехол для ноутбука «плотно™» — 14"', article: 'CS-B14', sku: 'CS-B14',
    revenue: 276_450, orders: 97, items: 97, prev_revenue: 200_000, prev_orders: 70,
    price_min: 1818, price_median: 2450, price_max: 3750,
  },
  {
    key: 'p3', title: 'Мини-сумка для смартфона — Серый', article: 'BG-GR7T', sku: 'BG-GR7T',
    revenue: 60_000, orders: 16, items: 16, prev_revenue: 55_000, prev_orders: 15,
    price_min: 3750, price_median: 3750, price_max: 3750,
  },
];

function series(count: number, from: number) {
  return Array.from({ length: count }, (_, i) => ({
    day: new Date(from + i * DAY).toISOString().slice(0, 10),
    revenue: 9000 + ((i * 17) % 7) * 1200,
    orders: 2 + (i % 3),
    items: 3 + (i % 3),
  }));
}

async function bootProducts(page: Page, savedFilters?: string) {
  const from = Date.now() - 30 * DAY;
  /** Что уходило в запросы окна — по этому видно, доехал ли сохранённый выбор. */
  const asked: string[] = [];
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/api/cdek/series' || path === '/api/cdek/breakdown') {
      asked.push(
        `${path.split('/').pop()} include=${url.searchParams.get('include') ?? ''} products=${url.searchParams.get('products') ?? ''} channels=${url.searchParams.get('sales_channels') ?? ''}`,
      );
    }
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

    const window = { days: 30, from: '2026-07-01', to: '2026-07-30', all: false };
    if (path === '/api/cdek/series') {
      return json(200, { window, grain: 'day', include: 'revenue', current: series(30, from), previous: [] });
    }
    if (path === '/api/cdek/breakdown') {
      const total = {
        revenue: PRODUCTS.reduce((s, r) => s + r.revenue, 0),
        orders: PRODUCTS.reduce((s, r) => s + r.orders, 0),
        items: PRODUCTS.reduce((s, r) => s + r.items, 0),
        prev_revenue: PRODUCTS.reduce((s, r) => s + r.prev_revenue, 0),
        prev_orders: PRODUCTS.reduce((s, r) => s + r.prev_orders, 0),
        groups: PRODUCTS.length,
      };
      return json(200, { window, dim: 'product', include: 'revenue', rows: PRODUCTS, other: null, total, truncated: false });
    }
    return json(404, { error: 'not_stubbed' });
  });

  await page.addInitScript((filters) => {
    localStorage.setItem('pulse_channel', '5');
    localStorage.setItem('pulse_theme', 'dark');
    if (filters) localStorage.setItem('pulse_saved_filters', filters);
  }, savedFilters ?? '');
  await page.goto('/cdek/products');
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  await page.waitForTimeout(700);
  return asked;
}

const card = (page: Page, title: string | RegExp) =>
  page.locator('section[data-widget-size]').filter({ has: page.getByRole('heading', { name: title }) });

test.beforeEach(({ page: _page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'СДЭК — desktop-first поверхность');
});

test('таблица показывает РАЗМАХ цены, а не одну усреднённую цифру', async ({ page }) => {
  await bootProducts(page);
  const row = page.getByRole('row', { name: /Чехол для ноутбука/ });
  await expect(row).toContainText('1 818 ₽');
  await expect(row).toContainText('2 450 ₽');
  await expect(row).toContainText('3 750 ₽');
});

test('товар с одной ценой не выглядит находкой', async ({ page }) => {
  // Три одинаковых числа — это отсутствие размаха, и подсвечивать их как разброс нельзя.
  await bootProducts(page);
  const row = page.getByRole('row', { name: /Мини-сумка/ });
  await expect(row).toContainText('3 750 ₽');
  await expect(row.locator('td.text-foreground')).toHaveCount(0);
});

test('концентрация ассортимента названа числом, а не оставлена на глаз', async ({ page }) => {
  await bootProducts(page);
  const widget = card(page, /^Концентрация ассортимента/);
  await expect(widget).toContainText('из 3');
  await expect(widget).toContainText('80% выручки');
});

test('цена считается на ШТУКУ, а не на заказ', async ({ page }) => {
  // Деление выручки на заказы дало бы средний чек — другую величину под тем же заголовком.
  await bootProducts(page);
  const widget = card(page, 'Средняя цена продажи');
  await expect(widget).toContainText('цена плавала у 2 из 3 товаров');
});

test('штуки ведут столбцами — это дискретный счёт', async ({ page }) => {
  await bootProducts(page);
  await expect(card(page, 'Штук продано').locator('rect').first()).toBeVisible();
});

test('ни одна карточка не переполняется внутренним скроллом', async ({ page }) => {
  // Тот же гейт, что у «Обзора»: столбцы «Штук продано» лежат в фикс-тайле и берут высоту тела
  // из контекста — без флекс-колонки вокруг ChartBand карточка переполняется молча.
  await bootProducts(page);
  expect(await overflowingCards(page)).toEqual([]);
});

/**
 * Сохранённый выбор действует и на «Товарах». Страница ходила мимо него совсем, и соседние экраны
 * одного источника отвечали на разные вопросы: «Обзор» считал отгруженное по выбранным каналам, а
 * «Товары» — весь оборот целиком, без единой подсказки почему.
 *
 * Фильтр ПО ТОВАРАМ при этом не применяется НИГДЕ на этой странице: сузь её выбранными товарами —
 * и она покажет ровно их, а ABC «сколько первых товаров дают 80% выручки» превратится в «три из
 * трёх». Тот же довод, по которому кольцо каналов не сужается каналами.
 */
test('сохранённые статусы и каналы доезжают, а фильтр товаров список не сужает', async ({ page }) => {
  const asked = await bootProducts(
    page,
    JSON.stringify({
      'cdek:status:5': ['complete'],
      'cdek:sales-channels:5': ['ozon'],
      'cdek:products:5': ['p1'],
    }),
  );

  await expect.poll(() => asked.some((q) => q.includes('include=status:complete'))).toBe(true);
  await expect.poll(() => asked.some((q) => q.includes('channels=ozon'))).toBe(true);
  // Ни один запрос страницы не сужен по товарам.
  expect(asked.every((q) => q.includes('products='))).toBe(true);
  expect(asked.some((q) => /products=\S/.test(q))).toBe(false);

  // И список остаётся полным: второй товар на месте, хотя в фильтре стоит только первый.
  // Ищем по АРТИКУЛУ: название несёт кавычки-ёлочки и ™, и дословный поиск по нему хрупок.
  await expect(page.getByText(PRODUCTS[1].article, { exact: false }).first()).toBeVisible();
});
