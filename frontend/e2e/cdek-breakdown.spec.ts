import { expect, test, type Page } from '@playwright/test';
const DAY = 86_400_000;
// Восемь разрезов при потолке в шесть — проверяется и обрезка, и честная подпись про хвост.
const CHANNELS = ['own', 'yandex_market', 'wildberries', 'ozon', 'other', 'k6', 'k7', 'k8'];
async function boot(page: Page) {
  const asked: string[] = [];
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const url = new URL(route.request().url()); const p = url.pathname;
    const json = (s: number, b: unknown) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
    if (p === '/api/auth/me') return json(200, { uid: 11, email: 'c@t.local', role: 'user', avatar: null });
    if (p === '/api/channels') return json(200, { enabled: true, channels: [{ id: 5, username: null, title: 'Склад', status: 'active', source: 'cdek' }], selected: 5 });
    if (p === '/api/prefs') return json(200, route.request().method() === 'GET' ? {} : { ok: true });
    if (p === '/api/cdek/status') return json(200, { channel_id: 5, title: 'Склад', warehouse_code: '1', tz: 'Europe/Moscow', last_import: null });
    const window = { days: 30, from: '2026-07-27', to: '2026-08-25', all: false };
    if (p === '/api/cdek/summary') return json(200, { window, previous_window: { from: '2026-06-27', to: '2026-07-26' }, include: 'revenue', current: { revenue: 250_000, orders: 120, items: 140, avg_check: 2083, orders_all: 120, orders_cancelled: 0, orders_returned: 0, cancel_share: 0 }, previous: { revenue: 200_000, orders: 100, items: 110, avg_check: 2000, orders_all: 100, orders_cancelled: 0, orders_returned: 0, cancel_share: 0 }, bounds: { first_day: '2025-07-31', last_day: '2026-08-25', orders: 900 } });
    if (p === '/api/cdek/series') {
      asked.push(url.search);
      const day = (i: number) => new Date(Date.parse('2026-07-27') + i * DAY).toISOString().slice(0, 10);
      const dim = url.searchParams.get('breakdown');
      if (dim) {
        return json(200, { window, grain: 'day', include: 'revenue', dim, current: [], previous: [],
          groups: CHANNELS.map((key, gi) => ({ key, points: Array.from({ length: 30 }, (_, i) => ({
            day: day(i), revenue: 900 - gi * 180 + ((i * (7 + gi)) % 9) * 60, orders: 2, items: 2 })) })) });
      }
      const pts = Array.from({ length: 30 }, (_, i) => ({ day: day(i), revenue: 2000 + ((i * 53) % 17) * 120, orders: 4, items: 4 }));
      return json(200, { window, grain: 'day', include: 'revenue', current: pts, previous: pts });
    }
    if (p === '/api/cdek/breakdown') return json(200, { window, dim: url.searchParams.get('dim'), include: 'revenue', rows: [], other: null, total: { revenue: 1, orders: 1, items: 1, prev_revenue: 1, prev_orders: 1, groups: 0 }, truncated: false });
    return json(404, { error: 'not_stubbed' });
  });
  await page.addInitScript(() => { localStorage.setItem('pulse_channel', '5'); localStorage.setItem('pulse_theme', 'light'); });
  await page.goto('/metrics/cdek-revenue');
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  await page.waitForTimeout(1300);
  return asked;
}
/**
 * Разбивка ряда по разрезу: один график вместо переключения между карточками.
 *
 * Разрез выбирается тем же приёмом, что и фильтры («+» в строке раздела), и по той же причине:
 * пять вариантов сегментированным контролом в 300px колонку не влезли — подписи налезали друг на
 * друга, что и было видно на первом кадре.
 */
test('разрез раскладывает ряд на серии и называет их по-человечески', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'десктоп');
  const asked = await boot(page);
  await page.getByRole('button', { name: 'Выбрать разрез' }).click();
  await page.getByRole('menuitem', { name: 'Каналам продаж' }).click();

  await expect(page.getByText('Своя доставка')).toBeVisible();
  await expect(page.getByText('Яндекс.Маркет')).toBeVisible();
  await expect.poll(() => asked.some((q) => q.includes('breakdown=channel'))).toBe(true);
  // Строка раздела говорит, по чему разложено.
  await expect(page.getByText(/По: каналам продаж/)).toBeVisible();
});

test('серий не больше читаемого потолка, а хвост назван числом', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'десктоп');
  // Восемь каналов, потолок шесть: показать все значило бы нарисовать частокол, а молча обрезать —
  // соврать про то, из чего сложилась выручка.
  await boot(page);
  await page.getByRole('button', { name: 'Выбрать разрез' }).click();
  await page.getByRole('menuitem', { name: 'Каналам продаж' }).click();
  await expect(page.getByText(/и ещё 2 разреза не показаны/)).toBeVisible();
});

test('снятие разреза возвращает одиночный ряд', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'десктоп');
  await boot(page);
  await page.getByRole('button', { name: 'Выбрать разрез' }).click();
  await page.getByRole('menuitem', { name: 'Каналам продаж' }).click();
  await expect(page.getByText('Своя доставка')).toBeVisible();

  await page.getByRole('button', { name: 'Убрать разбивку' }).click();
  await expect(page.getByText('Своя доставка')).toHaveCount(0);
  await expect(page.getByText('Один ряд — без разреза')).toBeVisible();
});
