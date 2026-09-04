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

/**
 * ДЛИННОЕ ОКНО. Сервер сам укрупняет его (свыше 31 дня — недели), и прежний счёт сравнивал дневную
 * цель с НЕДЕЛЬНОЙ суммой, называя недели днями: при выручке 9 000 ₽ в день и цели 10 000 ₽ подпись
 * рапортовала «достигнута в 13 из 13 дней», хотя правда — ноль. Один клик по пилюле окна переворачивал
 * вердикт. Здесь закреплены следствия одной правки: счёт по среднему дню, честная единица,
 * приведённая к корзине линия цели и не пропадающее сравнение.
 */
async function bootWeekly(page: Page) {
  const WIN = { days: 90, from: '2026-06-03', to: '2026-08-31', all: false };
  const PREV = { from: '2026-03-05', to: '2026-06-02' };
  const weekly = (fromIso: string, toIso: string) => {
    const out: Array<{ day: string; revenue: number; orders: number; items: number }> = [];
    const start = Date.parse(`${fromIso}T00:00:00Z`);
    const end = Date.parse(`${toIso}T00:00:00Z`);
    const monday = start - ((new Date(start).getUTCDay() + 6) % 7) * DAY;
    for (let ms = monday; ms <= end; ms += 7 * DAY) {
      const days = Math.round((Math.min(ms + 6 * DAY, end) - Math.max(ms, start)) / DAY) + 1;
      // Ровно 9 000 ₽ в день: цель 10 000 не достигается НИ РАЗУ, сколько бы дней ни было в корзине.
      out.push({ day: new Date(ms).toISOString().slice(0, 10), revenue: 9000 * days, orders: 3 * days, items: 3 * days });
    }
    return out;
  };
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (s: number, b: unknown) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
    if (path === '/api/auth/me') return json(200, { uid: 11, email: 'c@t.local', role: 'user', avatar: null });
    if (path === '/api/channels') return json(200, { enabled: true, channels: [{ id: 5, username: null, title: 'Склад', status: 'active', source: 'cdek' }], selected: 5 });
    if (path === '/api/prefs') return json(200, route.request().method() === 'GET' ? {} : { ok: true });
    if (path === '/api/cdek/status') return json(200, { channel_id: 5, title: 'Склад', warehouse_code: '1', tz: 'Europe/Moscow', last_import: null });
    if (path === '/api/cdek/summary')
      return json(200, { window: WIN, previous_window: PREV, include: 'revenue', current: { revenue: 810_000, orders: 270, items: 270, avg_check: 3000, orders_all: 270, orders_cancelled: 0, orders_returned: 0, cancel_share: 0 }, previous: { revenue: 700_000, orders: 240, items: 240, avg_check: 2900, orders_all: 240, orders_cancelled: 0, orders_returned: 0, cancel_share: 0 }, bounds: { first_day: '2025-01-01', last_day: '2026-08-31', orders: 5000 } });
    if (path === '/api/cdek/series')
      return json(200, { window: WIN, grain: 'week', include: 'revenue', current: weekly(WIN.from, WIN.to), previous: weekly(PREV.from, PREV.to) });
    if (path === '/api/cdek/breakdown')
      return json(200, { window: WIN, dim: url.searchParams.get('dim'), include: 'revenue', rows: [], other: null, total: { revenue: 1, orders: 1, items: 1, prev_revenue: 1, prev_orders: 1, groups: 0 }, truncated: false });
    return json(404, { error: 'not_stubbed' });
  });
  await page.addInitScript(() => {
    localStorage.setItem('pulse_channel', '5');
    localStorage.setItem('pulse_theme', 'light');
    localStorage.setItem('pulse_widget_prefs', JSON.stringify({ 'cdek-revenue': { target: 10_000 } }));
  });
  await page.goto('/metrics/cdek-revenue?p=90d');
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  await page.waitForTimeout(1500);
}

test('на недельных корзинах цель считается по среднему дню и называет недели неделями', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'десктоп');
  await bootWeekly(page);
  // Правда: 9 000 < 10 000 каждый день. Прежний счёт говорил «13 из 13 дней».
  // Краевые корзины исключены — окно 3 июня…31 августа даёт 12 полных недель из 14 корзин.
  await expect(page.getByText(/Достигнута в 0 из 12 недель/)).toBeVisible();
  await expect(page.getByText(/по среднему дню/)).toBeVisible();
});

test('линия цели приведена к корзине: дневная цель рисуется недельной', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'десктоп');
  await bootWeekly(page);
  // 10 000 ₽ в день = 70 000 ₽ за неделю. Линия на 10k среди недельных величин лежала бы у самого
  // низа полотна и читалась как «цель давно взята».
  await expect(goalLabels(page)).toHaveText([/цель 70k/]);
});

test('на укрупнённом окне сравнение остаётся и на столбцах', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'десктоп');
  // Сетки текущего и прошлого окна строятся каждая от своего понедельника, и число корзин
  // расходится: BarChart тогда молча снимал призрак вместе со строкой легенды — ровно та жалоба
  // «на столбцах не видно сравнения», ради которой всё и чинилось.
  await bootWeekly(page);
  await page.getByRole('button', { name: 'Столбцы' }).click();
  await expect(page.locator('main svg [data-chart-series="comparison"]').first()).toBeVisible();
});

/**
 * НА УЗКОМ ЭКРАНЕ ПАНЕЛЬ НЕ ПРЯЧЕТСЯ. Настройка одна на все источники и переживает перезагрузку:
 * свернув колонку на рабочем столе, человек открывал ту же страницу на ноутбуке в половину экрана —
 * и панели не было, а кнопки возврата там нет по построению. Вместе с колонкой исчезали итог окна,
 * база сравнения, разбивка и «О метрике», и выйти можно было только через чистку хранилища.
 */
test('свёрнутая панель остаётся видимой на узком экране', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'меняем ширину внутри теста');
  await page.addInitScript(() => localStorage.setItem('pulse_metric_rail_hidden', '1'));
  await boot(page);

  // Широкий экран: свёрнута — это и просили.
  await expect(page.locator('[data-cdek-filter-rail]')).toBeHidden();

  // Узкий: панель обязана вернуться сама, потому что вернуть её там нечем.
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(page.locator('[data-cdek-filter-rail]')).toBeVisible();
});
