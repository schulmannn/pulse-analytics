import { expect, test, type Page } from '@playwright/test';

/**
 * Морф не имеет права выпускать столбцы за viewBox.
 *
 * Регресс #501: нулевая линия пошла за данными, а морф твинил ПИКСЕЛЬНЫЕ высоты прошлого масштаба
 * и рисовал их вокруг новой линии. На коде из прода эта проба даёт over=18px и скачок линии в 35px
 * за кадр; после лечения — 0 и плавное скольжение.
 *
 * `sawFlight` — не только защита от холостого прогона: на старом коде линия ПРЫГАЛА, то есть
 * промежуточного положения не существовало вовсе, и эта же проверка ловит именно телепорт.
 *
 * Гейт сделан ДЕТЕРМИНИРУЕМЫМ: морф растянут до 3с через `--motion-morph`, и тест ОТДЕЛЬНО
 * проверяет, что перелёт действительно застали. Иначе на медленном раннере проба сняла бы только
 * конечное состояние и зеленела бы вхолостую — ровно тот сорт гейта, который уже однажды пропустил
 * баг в прод.
 */
const DAY = 86_400_000;
const row = (key: string, revenue: number, prev_revenue: number) => ({
  key, title: key, article: null, sku: null, revenue, orders: 10, items: 10, prev_revenue, prev_orders: 10,
});
// Каналы — смешанный размах (линия у нижней трети), товары — всё в минус (линия у верха).
const CHANNELS = [row('own', 1_240_000, 1_200_000), row('yandex_market', 930_000, 1_050_000), row('wildberries', 300_000, 240_000)];
const PRODUCTS = [row('p1', 90_000, 350_000), row('p2', 40_000, 130_000), row('p3', 12_000, 21_000), row('p4', 5_000, 8_000)];

async function boot(page: Page) {
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const json = (s: number, b: unknown) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
    if (p === '/api/auth/me') return json(200, { uid: 11, email: 'c@t.local', role: 'user', avatar: null });
    if (p === '/api/channels') return json(200, { enabled: true, channels: [{ id: 5, username: null, title: 'Склад', status: 'active', source: 'cdek' }], selected: 5 });
    if (p === '/api/prefs') return json(200, route.request().method() === 'GET' ? {} : { ok: true });
    if (p === '/api/cdek/status') return json(200, { channel_id: 5, title: 'Склад', warehouse_code: '1', tz: 'Europe/Moscow', last_import: null });
    const window = { days: 30, from: '2026-07-01', to: '2026-07-30', all: false };
    if (p === '/api/cdek/summary') return json(200, { window, previous_window: { from: '2026-06-01', to: '2026-06-30' }, include: 'revenue', current: { revenue: 2_470_000, orders: 30, items: 30, avg_check: 82333, orders_all: 30, orders_cancelled: 0, orders_returned: 0, cancel_share: 0 }, previous: { revenue: 2_490_000, orders: 30, items: 30, avg_check: 83000, orders_all: 30, orders_cancelled: 0, orders_returned: 0, cancel_share: 0 }, bounds: { first_day: '2025-07-31', last_day: '2026-07-30', orders: 900 } });
    if (p === '/api/cdek/series') {
      const pts = Array.from({ length: 30 }, (_, i) => ({ day: new Date(Date.parse('2026-07-01') + i * DAY).toISOString().slice(0, 10), revenue: 80_000, orders: 1, items: 1 }));
      return json(200, { window, grain: 'day', include: 'revenue', current: pts, previous: pts });
    }
    if (p === '/api/cdek/breakdown') {
      const dim = url.searchParams.get('dim');
      const rows = dim === 'channel' ? CHANNELS : dim === 'product' ? PRODUCTS : [];
      return json(200, { window, dim, include: 'revenue', rows, other: null, total: { revenue: 1, orders: 1, items: 1, prev_revenue: 1, prev_orders: 1, groups: rows.length }, truncated: false });
    }
    return json(404, { error: 'not_stubbed' });
  });
  await page.addInitScript(() => { localStorage.setItem('pulse_channel', '5'); localStorage.setItem('pulse_theme', 'light'); });
  await page.goto('/cdek');
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  await page.waitForTimeout(1500);
}

test('морф не выпускает столбцы за viewBox', async ({ page }, info) => {
  test.skip(info.project.name !== 'desktop-1440', 'десктоп');
  await boot(page);
  const card = page.locator('section[data-widget-size]').filter({ has: page.getByRole('heading', { name: 'Что изменило выручку' }) });
  await card.scrollIntoViewIfNeeded();
  const svg = card.locator('svg[role="img"]').first();
  await expect(svg).toBeVisible();

  // Пробник вешается ДО клика: снимает геометрию каждый кадр всего перелёта.
  const worst = await page.evaluate(async () => {
    const section = [...document.querySelectorAll('section[data-widget-size]')].find((s) =>
      s.querySelector('h2, h3')?.textContent?.includes('Что изменило выручку'),
    );
    if (!section) return null;
    const el = section.querySelector('svg[role="img"]') as SVGSVGElement | null;
    if (!el) return null;
    const btn = [...section.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Товары');
    if (!btn) return null;
    const frames: { over: number; under: number; mid: number }[] = [];
    const vb = () => Number(el.getAttribute('viewBox')?.split(' ')[3] ?? 0);
    const sample = () => {
      const H = vb();
      const line = el.querySelector('line');
      if (!line) throw new Error('нет нулевой линии — проба смотрит не туда');
      let over = 0, under = 0;
      let seen = 0;
      for (const path of el.querySelectorAll('path')) {
        const b = (path as SVGGraphicsElement).getBBox();
        if (b.height === 0) continue;
        seen++;
        over = Math.max(over, -b.y);
        under = Math.max(under, b.y + b.height - H);
      }
      if (seen === 0) throw new Error('кадр без столбцов — проба зеленела бы вхолостую');
      frames.push({ over, under, mid: Number(line.getAttribute('y1')) });
    };
    // Растягиваем перелёт: 3с ловятся любым раннером, а математике длительность безразлична.
    document.documentElement.style.setProperty('--motion-morph', '3000ms');
    sample();
    (btn as HTMLButtonElement).click();
    await new Promise<void>((done) => {
      const t0 = performance.now();
      const tick = () => { sample(); if (performance.now() - t0 < 1500) requestAnimationFrame(tick); else done(); };
      requestAnimationFrame(tick);
    });
    const mids = frames.map((f) => f.mid);
    let biggestMidJump = 0;
    for (let i = 1; i < mids.length; i++) biggestMidJump = Math.max(biggestMidJump, Math.abs(mids[i] - mids[i - 1]));
    // Промежуточное положение линии: строго между началом и концом, а не «уже приехали».
    const lo = Math.min(mids[0], mids[mids.length - 1]);
    const hi = Math.max(mids[0], mids[mids.length - 1]);
    const sawFlight = hi - lo > 2 && mids.some((m) => m > lo + 1 && m < hi - 1);
    return {
      sawFlight,
      frames: frames.length,
      over: Math.max(...frames.map((f) => f.over)),
      under: Math.max(...frames.map((f) => f.under)),
      midFrom: mids[0], midTo: mids[mids.length - 1], biggestMidJump,
    };
  });

  console.log('PROBE ' + JSON.stringify(worst));
  expect(worst).not.toBeNull();
  // Сначала — что перелёт вообще застали: линия должна быть ПОЙМАНА в промежуточном положении.
  // Без этой проверки «ноль переполнений» ничего не значил бы.
  expect(worst!.frames).toBeGreaterThan(10);
  expect(worst!.sawFlight).toBe(true);
  // И только теперь — сам инвариант.
  expect(worst!.over).toBeLessThanOrEqual(1);
  expect(worst!.under).toBeLessThanOrEqual(1);
});
