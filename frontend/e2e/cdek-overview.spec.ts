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

async function bootOverview(page: Page, opts: { all?: boolean; savedFilters?: string; sparse?: boolean } = {}) {
  const { all = false } = opts;
  const from = Date.now() - 30 * DAY;
  /** Каждый `include`, с которым уходил запрос окна — по нему видно, что фильтр реально доехал. */
  const includes: string[] = [];
  /** Каждое значение `products` — по нему видно, что выбор товаров доехал до запроса. */
  const productParams: string[] = [];
  /** То же для каналов продаж. */
  const channelParams: string[] = [];
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

    if (path === '/api/cdek/summary' || path === '/api/cdek/series') {
      includes.push(url.searchParams.get('include') ?? '');
      productParams.push(url.searchParams.get('products') ?? '');
      channelParams.push(url.searchParams.get('sales_channels') ?? '');
    }
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
      // Дни ряда обязаны лежать ВНУТРИ объявленного окна: фронт достраивает календарную сетку по
      // его границам (densifyCdekDays), и ряд «мимо окна» превратился бы в тридцать честных нулей.
      // Прежний стаб брал дни от Date.now(), а окно объявлял июльским — расхождение никак себя не
      // проявляло, пока сетку не строили.
      const winStart = all ? from : Date.parse('2026-07-01');
      const sparse = opts.sparse ? series(30, winStart).filter((_, i) => i % 6 !== 5) : series(30, winStart);
      return json(200, { window, grain: 'day', include: 'revenue', current: sparse, previous: all ? [] : series(30, winStart - 30 * DAY) });
    }
    if (path === '/api/cdek/breakdown') {
      const dim = url.searchParams.get('dim');
      const rows = dim === 'status' ? STATUSES : dim === 'product' ? PRODUCTS : CHANNELS;
      return json(200, { window, dim, include: dim === 'status' ? 'all' : 'revenue', rows, other: null, total: fold(rows), truncated: false });
    }
    return json(404, { error: 'not_stubbed' });
  });

  await page.addInitScript((filters) => {
    localStorage.setItem('pulse_channel', '5');
    localStorage.setItem('pulse_theme', 'dark');
    if (filters) localStorage.setItem('pulse_saved_filters', filters);
  }, opts.savedFilters ?? '');
  await page.goto('/cdek');
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  await page.waitForTimeout(900);
  return { includes, productParams, channelParams };
}

test.beforeEach(({ page: _page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'СДЭК — desktop-first поверхность');
});

/** Карточка ищется по своему заголовку — тот же приём, что у card-tint-default. */
const card = (page: Page, title: string | RegExp) =>
  page.locator('section[data-widget-size]').filter({ has: page.getByRole('heading', { name: title }) });

test('на карточке выручки нет постоянной приписки про отмены', async ({ page }) => {
  // Приписка «без отмен и складских движений» висела в каждом кадре и была шумом (владелец).
  // Смысл никуда не делся: статусы выбираются в развороте, и там же карточка говорит, что именно
  // посчитала, если выбор ушёл от канона. Здесь проверяется, что лицо карточки чистое.
  await bootOverview(page);
  const widget = card(page, 'Выручка');
  await expect(widget).not.toContainText('без отмен');
  await expect(widget.locator('[data-cdek-status-filter]')).toHaveCount(0);
  // Крупное число сжимается ОТ 10 000 (правило владельца, см. lib/metricNumber): 3 076 319 ₽
  // печатается как «3.1M ₽», а не полными цифрами — иначе оно съедало полкарточки. Раньше здесь
  // проверялась ровно ПОЛНАЯ форма, то есть тест закреплял то, на что владелец и пожаловался.
  // Hero идёт через цифровой морф (NumberFlow): рядом с числом в DOM лежит барабан цифр, поэтому
  // проверка идёт по подстроке, а не по строке целиком.
  await expect(widget).toContainText('3.1');
  await expect(widget).not.toContainText('3 076 319');
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
  // Строки источника и описания сняты по решению владельца («не несут инфы»): источник назван в
  // сайдбаре, а «сумма проданного за окно» повторяла заголовок.
  await expect(page.getByText('Складские движения в неё не входят')).toHaveCount(0);
});

test('фильтр статусов живёт только в развороте и доезжает до запроса', async ({ page }) => {
  // Решение владельца: фильтр доступен ТОЛЬКО когда провалились внутрь графика. На карточке его
  // нет и быть не должно — иначе у неё появилось бы скрытое состояние и число меняло бы смысл
  // без единого видимого контрола.
  const { includes } = await bootOverview(page);
  await expect(page.locator('[data-cdek-status-filter]')).toHaveCount(0);

  const expand = page.getByRole('button', { name: 'Развернуть виджет «Выручка»' });
  await expand.focus();
  await expand.press('Enter');
  await expect(page).toHaveURL(/\/metrics\/cdek-revenue/);

  // Статусы стоят карточкой С ПЕРВОГО КАДРА, потому что фильтруют всегда: канон считает только
  // отгруженное. Прочие оси по-прежнему не нарисованы, пока их не добавили.
  await expect(page.locator('[data-cdek-filter-rail]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Статусы заказов', expanded: false })).toBeVisible();
  // Сам выбор при этом свёрнут: раскрывается ВНУТРИ карточки (как у Steep), а не в поповере.
  await expect(page.locator('[data-cdek-status-filter]')).toHaveCount(0);
  const before = includes.length;

  await page.getByRole('button', { name: 'Статусы заказов', expanded: false }).click();
  await expect(page.locator('[data-cdek-status-filter]')).toBeVisible();

  await page.getByRole('option', { name: 'Отменён' }).click();
  await expect.poll(() => includes.length).toBeGreaterThan(before);
  // Канон — «complete + delivery»; добавив отменённые, получаем явный набор из трёх статусов.
  await expect.poll(() => includes[includes.length - 1]).toBe('status:cancel,complete,delivery');

  // И карточка теперь ГОВОРИТ, что посчитала: молча изменить смысл числа нельзя.
  // Гарантия та же — страница ОБЯЗАНА назвать, что посчитала, — но теперь она выражена пилюлями:
  // каждое выбранное значение стоит в карточке и снимается на месте. Отдельная подпись под ними
  // повторяла бы то, что уже на экране.
  await expect(page.getByRole('button', { name: 'Убрать: Отменён' })).toBeVisible();
});

/**
 * Пустой набор статусов не «ничего не считаем», а тихий возврат к канону — состояние, которого
 * человек не выбирал. Раз его не существует по смыслу, до него нельзя доехать и руками.
 */
test('последний статус снять нельзя ни пилюлей, ни в выборе', async ({ page }) => {
  await bootOverview(page);
  const expand = page.getByRole('button', { name: 'Развернуть виджет «Выручка»' });
  await expand.focus();
  await expand.press('Enter');
  await expect(page).toHaveURL(/\/metrics\/cdek-revenue/);

  // Канон — две пилюли, у каждой свой крестик.
  await expect(page.getByRole('button', { name: 'Убрать: Завершён' })).toBeVisible();
  await page.getByRole('button', { name: 'Убрать: В доставке' }).click();

  // Осталась одна — крестика у неё больше нет.
  await expect(page.getByRole('button', { name: 'Убрать: Завершён' })).toHaveCount(0);
  await expect(page.getByText('Завершён')).toBeVisible();

  // И в раскрытом выборе — тоже: единственный чип стоит без крестика, а в списке вариантов его
  // нет (выбранное живёт чипом, как у Steep), значит снять его нечем.
  await page.getByRole('button', { name: 'Статусы заказов', expanded: false }).click();
  const picker = page.locator('[data-cdek-status-filter]');
  await expect(picker).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Убрать: Завершён' })).toHaveCount(0);
  await expect(picker.getByRole('option', { name: 'Завершён' })).toHaveCount(0);
});

test('фильтр товаров режет метрику и тоже живёт только в развороте', async ({ page }) => {
  const { productParams } = await bootOverview(page);
  await expect(page.locator('[data-cdek-product-filter]')).toHaveCount(0);

  const expand = page.getByRole('button', { name: 'Развернуть виджет «Выручка»' });
  await expand.focus();
  await expand.press('Enter');
  await expect(page).toHaveURL(/\/metrics\/cdek-revenue/);

  await expect(page.locator('[data-cdek-product-filter]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Добавить фильтр' }).click();
  await page.getByRole('menuitem', { name: 'Товары' }).click();
  // Раскрытие ОДНО: карточка фильтра. Своей второй ступени («Товары · все») у списка больше нет —
  // выбор идёт списком, как у Steep.
  await page.getByRole('button', { name: 'Товары', expanded: false }).click();
  const first = page.getByRole('option', { name: PRODUCTS[0].title ?? '' });
  await expect(first).toBeVisible();
  const before = productParams.length;
  await first.click();

  await expect.poll(() => productParams.length).toBeGreaterThan(before);
  await expect.poll(() => productParams[productParams.length - 1]).toBe(PRODUCTS[0].key);
  // Метрика обязана СКАЗАТЬ, что считает не весь ассортимент.
  await expect(page.getByRole('button', { name: `Убрать: ${PRODUCTS[0].title}` })).toBeVisible();
});


/**
 * Сохранённый в развороте выбор ДЕЙСТВУЕТ на карточках «Обзора» (владелец: «чтобы эта настройка
 * распространилась на виджет в уменьшенном виде»). Раньше он намеренно не протекал, и это было
 * зафиксировано в коде комментарием — поэтому проверка нужна: без неё возврат к старому поведению
 * прошёл бы незамеченным.
 *
 * Второе требование того же решения: карточка обязана СКАЗАТЬ, что посчитана нестандартным
 * набором. Молчащее число значило бы не то, что читатель думает.
 */
/**
 * Сохранённый выбор ДЕЙСТВУЕТ на карточках, но БОЛЬШЕ НЕ ПЕЧАТАЕТСЯ припиской (владелец: «это
 * лишнее»). Проверяется теперь то, что и есть суть: набор доезжает до запроса. Прежняя гарантия
 * «карточка обязана назвать нестандартный набор» снята сознательно — выбор виден в развороте,
 * где он стоит карточками фильтров прямо над графиком.
 */
test('сохранённый фильтр доезжает до карточек «Обзора» и не печатает приписку', async ({ page }) => {
  const { includes } = await bootOverview(page, {
    savedFilters: JSON.stringify({ 'cdek:status:5': ['complete'] }),
  });
  expect(includes.some((v) => v === 'status:complete')).toBe(true);
  await expect(card(page, 'Выручка')).not.toContainText(/только: завершён/i);
  await expect(card(page, 'Выручка')).not.toContainText(/считаются/i);
});

test('канонический набор ходит каноном', async ({ page }) => {
  const { includes } = await bootOverview(page);
  expect(includes.every((v) => v !== 'status:complete')).toBe(true);
  await expect(card(page, 'Выручка')).not.toContainText(/только:/i);
});


test('сохранённый канал продаж режет метрику', async ({ page }) => {
  const { channelParams } = await bootOverview(page, {
    savedFilters: JSON.stringify({ 'cdek:sales-channels:5': ['ozon', 'wildberries'] }),
  });
  expect(channelParams.some((v) => v === 'ozon,wildberries')).toBe(true);
  await expect(card(page, 'Выручка')).not.toContainText(/только каналы/i);
});

test('кольцо каналов фильтр по каналам не сужает — иначе оно покажет ровно себя', async ({ page }) => {
  // Вопрос кольца «на кого мы завязаны» теряет смысл, если оставить в нём только выбранное.
  await bootOverview(page, {
    savedFilters: JSON.stringify({ 'cdek:sales-channels:5': ['ozon'] }),
  });
  const donut = card(page, 'Каналы продаж');
  await expect(donut).toContainText('Wildberries');
});


/**
 * Значение снимается СВОЕЙ пилюлей, не через выбор. Прошлая редакция давала один крестик на всю
 * ось: чтобы убрать один статус из двух, приходилось открывать список — это другая механика, а не
 * другой вид, и без проверки возврат к ней прошёл бы незаметно.
 */
test('пилюля значения снимается на месте и доезжает до запроса', async ({ page }) => {
  const { includes } = await bootOverview(page);
  const expand = page.getByRole('button', { name: 'Развернуть виджет «Выручка»' });
  await expand.focus();
  await expand.press('Enter');
  await expect(page).toHaveURL(/\/metrics\/cdek-revenue/);

  // Карточка статусов стоит сразу — канон «завершён + в доставке», обе пилюли на месте.
  await expect(page.getByRole('button', { name: 'Убрать: Завершён' })).toBeVisible();

  const before = includes.length;
  await page.getByRole('button', { name: 'Убрать: В доставке' }).click();
  await expect(page.getByRole('button', { name: 'Убрать: В доставке' })).toHaveCount(0);
  await expect.poll(() => includes.length).toBeGreaterThan(before);
  await expect.poll(() => includes[includes.length - 1]).toBe('status:complete');
});

/**
 * Карточки «Обзора» строят календарную сетку окна ТАК ЖЕ, как разворот: сервер отдаёт только дни
 * с продажами, и без уплотнения ось врёт о расстояниях между датами, а карточка показывает не ту
 * форму, что разворот того же числа. Проверяется числом столбцов: в окне 30 дней, в ответе 25.
 */
test('карточка достраивает дни без продаж, как и разворот', async ({ page }) => {
  // В разреженном ответе выпадает КАЖДЫЙ ШЕСТОЙ день, включая последний день окна (30 июля).
  // Без календарной сетки ось обрывалась бы на 29-м — и «последняя точка» врала бы о том, чем
  // окно закончилось. Считать столбцы бесполезно: нулевой день рисуется пустым path.
  await bootOverview(page, { sparse: true });
  await expect(card(page, 'Заказы')).toContainText('30 июл.');
});

/**
 * Подписи статусов жили ЧЕТЫРЬМЯ копиями, и в развороте метрики копия потеряла два значения:
 * карточка печатала «Собран», а её же «Развернуть» показывало сырое `assembled` из базы. Любой
 * новый статус в выгрузке добавлял бы такую пару снова.
 */
test('разворот статусов подписывает их по-русски, как и карточка', async ({ page }) => {
  await bootOverview(page);
  const expand = page.getByRole('button', { name: 'Развернуть виджет «Статусы заказов»' });
  await expand.focus();
  await expand.press('Enter');
  await expect(page).toHaveURL(/\/metrics\/cdek-statuses/);
  // Ни одного сырого ключа из базы на экране.
  await expect(page.getByText(/assembled|confirmed/)).toHaveCount(0);
});
