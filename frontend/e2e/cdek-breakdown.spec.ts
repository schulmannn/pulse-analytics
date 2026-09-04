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
  // Строка раздела говорит, по чему разложено — и это СЕЛЕКТ: соседний разрез выбирается на
  // месте, без «снять и добавить заново» (анатомия элемента раздела у Steep).
  const picked = page.getByRole('button', { name: 'Разрез', exact: true });
  await expect(picked).toHaveText(/Каналам продаж/);
  await picked.click();
  await page.getByRole('menuitem', { name: 'Статусам' }).click();
  await expect(picked).toHaveText(/Статусам/);
  await expect.poll(() => asked.some((q) => q.includes('breakdown=status'))).toBe(true);
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
  // Пустой раздел МОЛЧИТ: отсутствие строки и есть отсутствие разреза — подпись про это была
  // пересказом пустоты и снята по замечанию владельца.
  await expect(page.getByRole('button', { name: 'Разрез', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Выбрать разрез' })).toBeVisible();
});

/**
 * Контрол, на который нажали и ничего не произошло, учит не доверять контролам. Под разбивкой
 * столбцы и прошлое окно бездействовали бы молча — оба гаснут и объясняют причину.
 */
test('под разбивкой недоступные варианты гаснут и называют причину', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'десктоп');
  await boot(page);
  const bars = page.getByRole('button', { name: 'Столбцы' });
  await expect(bars).toBeEnabled();

  await page.getByRole('button', { name: 'Выбрать разрез' }).click();
  await page.getByRole('menuitem', { name: 'Каналам продаж' }).click();
  await expect(page.getByText('Своя доставка')).toBeVisible();

  await expect(bars).toBeDisabled();
  await expect(page.getByText(/Разбивка рисуется линиями/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Пред. период' })).toBeDisabled();
  await expect(page.getByText(/прошлое окно не показывается/)).toBeVisible();

  // Сняли разрез — оба варианта вернулись.
  await page.getByRole('button', { name: 'Убрать разбивку' }).click();
  await expect(bars).toBeEnabled();
});

/**
 * Разбивка не должна переписывать язык графика. Раньше этот график жил мимо двух общих правил:
 * подписи оси брались из дат вместо канонической оси, а легенда рядов стояла ПОД полотном. Один
 * клик на семидневном окне менял и то и другое — человек решал, что смотрит на другой график.
 */
test('разбивка сохраняет канон оси и держит легенду над полотном', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'десктоп');
  await boot(page);
  await page.getByRole('button', { name: 'Выбрать разрез' }).click();
  await page.getByRole('menuitem', { name: 'Каналам продаж' }).click();
  await expect(page.getByText('Своя доставка')).toBeVisible();

  const geometry = await page.evaluate(() => {
    const svg = [...document.querySelectorAll('main svg')].sort(
      (a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width,
    )[0];
    const host = svg.closest('.bg-card');
    const legend = [...(host?.querySelectorAll('span') ?? [])].find((s) => /Своя доставка/.test(s.textContent ?? ''));
    return {
      legendAbove: legend ? legend.getBoundingClientRect().y < svg.getBoundingClientRect().y : false,
    };
  });
  expect(geometry.legendAbove).toBe(true);
});

/**
 * РАЗРЕЗЫ ПРИВЯЗАНЫ К МЕТРИКЕ. Список был один на все: «Средний чек по товарам» делил выручку
 * товара на заказы, в которых он есть, — величина под чужим именем, ровно та ошибка, от которой
 * отдельно предостерегает описание «Средней цены продажи». Пункт не исчезает, а ГАСНЕТ С
 * ПРИЧИНОЙ: исчезнувший человек ищет глазами и решает, что сломалось.
 */
test('«Средний чек» гасит разрез по товарам и называет причину', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'десктоп');
  await boot(page);
  await page.goto('/metrics/cdek-aov');
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  await page.getByRole('button', { name: 'Выбрать разрез' }).click();

  const item = page.getByRole('menuitem', { name: /Товарам/ });
  await expect(item).toHaveAttribute('data-disabled', '');
  await expect(item).toContainText('это не средний чек');
  // Соседние разрезы у той же метрики живы.
  await expect(page.getByRole('menuitem', { name: 'Каналам продаж' })).not.toHaveAttribute('data-disabled', '');
});

test('«Выручка» разрез по товарам разрешает', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'десктоп');
  await boot(page);
  await page.getByRole('button', { name: 'Выбрать разрез' }).click();
  await expect(page.getByRole('menuitem', { name: /Товарам/ })).not.toHaveAttribute('data-disabled', '');
});
