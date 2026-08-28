import { expect, test, type Page } from '@playwright/test';

/**
 * Цель метрики — «Целевой уровень», который до сих пор задавался только в редакторе виджета.
 * Владелец: «targets сделай тоже, мне казалось у нас они были» — они и были, просто до страницы
 * метрики не доходили.
 *
 * Второго механизма нет: цель пишется в те же `prefs.target` под id виджета «Обзора», поэтому
 * проверяется не «нарисовалась линия», а сквозной путь — ввод → линия → карточка.
 */
const DAY = 86_400_000;

async function boot(page: Page) {
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const json = (s: number, b: unknown) =>
      route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
    if (p === '/api/auth/me') return json(200, { uid: 11, email: 'c@t.local', role: 'user', avatar: null });
    if (p === '/api/channels')
      return json(200, { enabled: true, channels: [{ id: 5, username: null, title: 'Склад', status: 'active', source: 'cdek' }], selected: 5 });
    if (p === '/api/prefs') return json(200, route.request().method() === 'GET' ? {} : { ok: true });
    if (p === '/api/cdek/status')
      return json(200, { channel_id: 5, title: 'Склад', warehouse_code: '1', tz: 'Europe/Moscow', last_import: null });
    const window = { days: 30, from: '2026-07-27', to: '2026-08-25', all: false };
    if (p === '/api/cdek/summary')
      return json(200, {
        window,
        previous_window: { from: '2026-06-27', to: '2026-07-26' },
        include: 'revenue',
        current: { revenue: 250_000, orders: 120, items: 140, avg_check: 2083, orders_all: 120, orders_cancelled: 0, orders_returned: 0, cancel_share: 0 },
        previous: { revenue: 200_000, orders: 100, items: 110, avg_check: 2000, orders_all: 100, orders_cancelled: 0, orders_returned: 0, cancel_share: 0 },
        bounds: { first_day: '2025-07-31', last_day: '2026-08-25', orders: 900 },
      });
    if (p === '/api/cdek/series') {
      const day = (i: number) => new Date(Date.parse('2026-07-27') + i * DAY).toISOString().slice(0, 10);
      const dim = url.searchParams.get('breakdown');
      if (dim) {
        return json(200, {
          window, grain: 'day', include: 'revenue', dim, current: [], previous: [],
          groups: ['own', 'ozon'].map((key, gi) => ({
            key,
            points: Array.from({ length: 30 }, (_, i) => ({ day: day(i), revenue: 900 - gi * 180 + ((i * (7 + gi)) % 9) * 60, orders: 2, items: 2 })),
          })),
        });
      }
      // Ровно десять дней из тридцати выше 3000 — счёт достижения проверяем ТОЧНЫМ числом.
      const pts = Array.from({ length: 30 }, (_, i) => ({ day: day(i), revenue: i % 3 === 0 ? 4000 : 2000, orders: 4, items: 4 }));
      return json(200, { window, grain: 'day', include: 'revenue', current: pts, previous: pts });
    }
    if (p === '/api/cdek/breakdown')
      return json(200, { window, dim: url.searchParams.get('dim'), include: 'revenue', rows: [], other: null, total: { revenue: 1, orders: 1, items: 1, prev_revenue: 1, prev_orders: 1, groups: 0 }, truncated: false });
    return json(404, { error: 'not_stubbed' });
  });
  await page.addInitScript(() => {
    localStorage.setItem('pulse_channel', '5');
    localStorage.setItem('pulse_theme', 'light');
  });
  await page.goto('/metrics/cdek-revenue');
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  await page.waitForTimeout(1300);
}

const goalLabels = (page: Page) =>
  page.locator('main svg text').filter({ hasText: /^цель/ });

test('цель рисует линию и честно считает, в скольких днях достигнута', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'десктоп');
  await boot(page);

  // Пустой раздел молчит: ни линии, ни подписи, пока цель не поставили.
  await expect(goalLabels(page)).toHaveCount(0);

  await page.getByRole('button', { name: 'Добавить цель' }).click();
  await page.getByRole('spinbutton', { name: 'Цель за день' }).fill('3000');

  await expect(goalLabels(page)).toHaveCount(1);
  // Счёт по ТОЧКАМ ряда, а не по итогу окна: цель дневная, и «10 из 30» проверяемо глазами.
  await expect(page.getByText('Достигнута в 10 из 30 дней')).toBeVisible();
});

test('цель переживает переключение линия↔столбцы', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'десктоп');
  await boot(page);
  await page.getByRole('button', { name: 'Добавить цель' }).click();
  await page.getByRole('spinbutton', { name: 'Цель за день' }).fill('3000');
  await expect(goalLabels(page)).toHaveCount(1);

  // Оба графика читают ОДИН контекст — иначе цель исчезала бы при смене типа полотна.
  await page.getByRole('button', { name: 'Столбцы' }).click();
  await expect(goalLabels(page)).toHaveCount(1);
});

/**
 * Цель у метрики ОДНА, а рядов под разбивкой несколько: линия поверх шести серий читалась бы как
 * цель каждой из них. Молча не рисовать — тоже ложь, поэтому причина названа.
 */
test('под разбивкой линия цели снимается и причина названа', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'десктоп');
  await boot(page);
  await page.getByRole('button', { name: 'Добавить цель' }).click();
  await page.getByRole('spinbutton', { name: 'Цель за день' }).fill('3000');
  await expect(goalLabels(page)).toHaveCount(1);

  await page.getByRole('button', { name: 'Выбрать разрез' }).click();
  await page.getByRole('menuitem', { name: 'Каналам продаж' }).click();
  await expect(page.getByText('Своя доставка')).toBeVisible();

  await expect(goalLabels(page)).toHaveCount(0);
  await expect(page.getByText(/цель у метрики одна, а рядов несколько/)).toBeVisible();
});

const savedTarget = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('pulse_widget_prefs') ?? '{}')?.['cdek-revenue']?.target ?? null);

/**
 * У колонки ОДИН договор: на графике выбор действует сразу, на карточке «Обзора» — после
 * «Сохранить». Раньше цель его нарушала — писалась в prefs прямо из поля и молча уезжала на
 * карточку, пока фильтры рядом ждали кнопку. Владелец на этом и споткнулся: «почему нет кнопки
 * сохранить? я добавил фильтры и добавил target значение».
 */
test('цель ждёт «Сохранить», как и фильтры', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'десктоп');
  await boot(page);
  const save = page.getByRole('button', { name: 'Сохранить' });

  // Нечего сохранять — кнопки нет.
  await expect(save).toHaveCount(0);

  await page.getByRole('button', { name: 'Добавить цель' }).click();
  await page.getByRole('spinbutton', { name: 'Цель за день' }).fill('3000');

  // На графике цель уже видна, но на карточку ещё НЕ уехала.
  await expect(goalLabels(page)).toHaveCount(1);
  await expect(save).toBeVisible();
  await expect.poll(() => savedTarget(page)).toBe(null);

  await save.click();
  // Ключ — id виджета «Обзора», а не свой собственный: два механизма целей развели бы одну и ту
  // же настройку по двум местам, и карточка перестала бы совпадать с разворотом.
  await expect.poll(() => savedTarget(page)).toBe(3000);
  await expect(save).toHaveCount(0);
});

test('снятая цель тоже уходит через «Сохранить», а не остаётся нулём', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'десктоп');
  await boot(page);
  await page.getByRole('button', { name: 'Добавить цель' }).click();
  await page.getByRole('spinbutton', { name: 'Цель за день' }).fill('3000');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect.poll(() => savedTarget(page)).toBe(3000);

  await page.getByRole('button', { name: 'Убрать цель' }).click();
  await expect(goalLabels(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await expect.poll(() => savedTarget(page)).toBe(null);
});

/**
 * Полноэкранный режим полотна (владелец: «кнопка toggle чтобы скрыть все фильтры и прочее… также
 * как у Steep»). Колонка уходит ИЗ ПОТОКА, а не прячется прозрачностью — иначе полотно осталось бы
 * обрезанным по прежней сетке. Кнопка называет ПРАВУЮ ПАНЕЛЬ, а не фильтры: колонка держит ещё
 * сравнение, цели и разбивку, а «Скрыть панель» уже занято сворачиванием сайдбара.
 */
test('колонка сворачивается, полотно занимает её место, выбор запоминается', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'десктоп');
  await boot(page);
  const surface = page.locator('main .bg-card').first();
  const wide = await surface.boundingBox();

  await page.getByRole('button', { name: 'Скрыть правую панель' }).click();
  // Узел остаётся в разметке, но на десктопе снят с потока (lg:hidden): ниже lg колонка нужна —
  // она стоит под графиком, ширины у него не отнимает, и прятать её значило бы отнять сравнение.
  await expect(page.locator('[data-cdek-filter-rail]')).toBeHidden();
  await expect.poll(async () => Math.round((await surface.boundingBox())?.width ?? 0)).toBeGreaterThan(
    Math.round(wide?.width ?? 0),
  );

  // Выбор — свойство рабочего места, а не метрики: он переживает переход на соседнюю страницу.
  await page.goto('/metrics/cdek-orders');
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  await expect(page.locator('[data-cdek-filter-rail]')).toBeHidden();

  await page.getByRole('button', { name: 'Показать правую панель' }).click();
  await expect(page.locator('[data-cdek-filter-rail]')).toBeVisible();
});
