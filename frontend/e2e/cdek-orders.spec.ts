import { expect, test, type Page } from '@playwright/test';
import { overflowingCards } from './helpers';

// «Заказы» СДЭКа — рабочая лента склада. Проверяется то, ради чего страница существует: найти
// конкретную посылку по любому из трёх номеров и увидеть ритм спроса, посчитанный по заказам.

const ORDERS = [
  {
    order_id: '33905564', created_at: '2026-08-20T10:15:00', status: 'complete', channel: 'own',
    carrier: 'Cdek', external_order_id: null, track_number: '10145274548', comment: null,
    amount: 2850, items: 1, positions: 1,
  },
  {
    order_id: '33905573', created_at: '2026-08-21T08:30:00', status: 'delivery', channel: 'yandex_market',
    carrier: 'YM FBS', external_order_id: '3692481361', track_number: null, comment: null,
    amount: 8780, items: 2, positions: 1,
  },
];

/** Ритм с явным пиком в 8 утра — как в настоящей выгрузке склада. */
const CELLS = [
  { weekday: 1, hour: 8, orders: 24 },
  { weekday: 1, hour: 14, orders: 11 },
  { weekday: 3, hour: 9, orders: 7 },
  { weekday: 6, hour: 19, orders: 3 },
];

/** Длинная лента: ниже VIRTUALIZE_FROM (120) виртуализация спит, и её ветку никто не проверяет. */
function manyOrders(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    order_id: String(40000000 + i),
    created_at: '2026-08-20T10:15:00',
    status: 'complete',
    channel: 'own',
    carrier: 'Cdek',
    external_order_id: null,
    track_number: String(10000000000 + i),
    comment: null,
    amount: 1000 + i,
    items: 1,
    positions: 1,
  }));
}

async function bootOrders(page: Page, orders: typeof ORDERS = ORDERS) {
  const seen: string[] = [];
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

    const window = { days: 30, from: '2026-07-27', to: '2026-08-25', all: false };
    if (path === '/api/cdek/hourly') return json(200, { window, cells: CELLS });
    if (path === '/api/cdek/orders') {
      seen.push(url.search);
      const q = url.searchParams.get('q');
      const status = url.searchParams.get('status');
      const channel = url.searchParams.get('channel');
      // Стаб фильтрует так же, как сервер: по трём номерам сразу, статусу и каналу.
      const rows = orders.filter((o) => {
        if (status && o.status !== status) return false;
        if (channel && o.channel !== channel) return false;
        if (!q) return true;
        return [o.order_id, o.external_order_id, o.track_number].some((v) => v && v.includes(q));
      });
      return json(200, { window, total: rows.length, truncated: false, orders: rows });
    }
    return json(404, { error: 'not_stubbed' });
  });

  await page.addInitScript(() => {
    localStorage.setItem('pulse_channel', '5');
    localStorage.setItem('pulse_theme', 'dark');
  });
  await page.goto('/cdek/orders');
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  await page.waitForTimeout(700);
  return seen;
}

test.beforeEach(({ page: _page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'СДЭК — desktop-first поверхность');
});

test('лента показывает заказы окна с суммой и штуками', async ({ page }) => {
  await bootOrders(page);
  const row = page.getByRole('row', { name: /33905564/ });
  await expect(row).toContainText('Завершён');
  await expect(row).toContainText('Своя доставка');
  await expect(row).toContainText('2 850 ₽');
});

test('длинная лента: строки держат колонки шапки, а не схлопываются', async ({ page }) => {
  // Регресс с живых данных владельца: виртуализация ставила строке `display: table` и абсолютное
  // позиционирование, каждая строка становилась СВОЕЙ таблицей — шапка держала настоящие ширины,
  // а ячейки строк схлопывались в ~20px и наезжали друг на друга. Прежние тесты этого не видели:
  // они проверяли наличие текста, а фикстура была короче порога виртуализации.
  await bootOrders(page, manyOrders(200));
  const table = page.locator('table').last();
  await expect(table.locator('tbody tr[data-index]').first()).toBeVisible();

  const geom = await table.evaluate((node) => {
    const head = [...node.querySelectorAll('thead th')].map((c) => Math.round(c.getBoundingClientRect().width));
    const row = node.querySelector('tbody tr[data-index]');
    return {
      head,
      body: row ? [...row.children].map((c) => Math.round(c.getBoundingClientRect().width)) : [],
      rowDisplay: row ? getComputedStyle(row).display : null,
      virtualized: node.querySelector('tbody')?.getAttribute('data-virtualized') ?? null,
    };
  });

  // Сначала суть: ячейки строки обязаны совпасть с колонками шапки. Проверка «включилась ли
  // виртуализация» идёт последней — иначе регресс валил бы тест по служебному признаку, а не по
  // тому, что видит человек.
  expect(geom.rowDisplay, 'строка обязана остаться table-row').toBe('table-row');
  expect(geom.body).toHaveLength(geom.head.length);
  for (const [i, width] of geom.head.entries()) {
    expect(Math.abs(geom.body[i] - width), `колонка ${i} разъехалась с шапкой`).toBeLessThanOrEqual(2);
  }
  expect(geom.virtualized, 'виртуализация должна включиться на 200 строках').toBe('true');
});

test('поиск ищет по трек-номеру и по внешнему номеру маркетплейса', async ({ page }) => {
  // Трек есть только у своей доставки, внешний номер — только у маркетплейсов. Ищем по обоим
  // сразу, потому что человек приносит тот номер, который у него на руках.
  await bootOrders(page);
  const search = page.getByRole('searchbox', { name: 'Поиск заказа' });

  await search.fill('10145274548');
  await expect(page.getByRole('row', { name: /33905564/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /33905573/ })).toHaveCount(0);

  await search.fill('3692481361');
  await expect(page.getByRole('row', { name: /33905573/ })).toBeVisible();
});

test('ненайденный номер объясняет, где вообще искали', async ({ page }) => {
  await bootOrders(page);
  await page.getByRole('searchbox', { name: 'Поиск заказа' }).fill('нет-такого');
  await expect(page.getByText('Ничего не нашлось')).toBeVisible();
  await expect(page.getByText(/по номеру заказа, внешнему номеру и трек-номеру/)).toBeVisible();
});

test('фильтр канала и статуса уходит на сервер, а не режет уже полученное', async ({ page }) => {
  const seen = await bootOrders(page);
  await page.getByRole('button', { name: 'ЯМ' }).click();
  await expect(page.getByRole('row', { name: /33905573/ })).toBeVisible();
  await expect(page.getByRole('row', { name: /33905564/ })).toHaveCount(0);
  expect(seen.some((s) => s.includes('channel=yandex_market'))).toBe(true);
});

test('ритм называет пик словами, а не оставляет читать цвета', async ({ page }) => {
  await bootOrders(page);
  const card = page.locator('section[data-widget-size]').filter({ has: page.getByRole('heading', { name: /^Когда покупают/ }) });
  await expect(card).toContainText('Пик: Пн в 08:00 — 24 зак.');
});

test('ни одна карточка не переполняется внутренним скроллом', async ({ page }) => {
  await bootOrders(page);
  expect(await overflowingCards(page)).toEqual([]);
});
