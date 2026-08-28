import { chromium } from '@playwright/test';

const DAY = 86_400_000;
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
// Окно 90 дней: сервер отдаёт НЕДЕЛЬНЫЕ корзины. Дневная выручка ровно 9 000 ₽ — цель 10 000 ₽
// не достигается НИ РАЗУ. Прежний счёт рапортовал «достигнута всегда».
const WIN = { days: 90, from: '2026-06-03', to: '2026-08-31', all: false };
const PREV = { from: '2026-03-05', to: '2026-06-02' };
const weekly = (fromIso, toIso) => {
  const out = [];
  const start = Date.parse(`${fromIso}T00:00:00Z`);
  const end = Date.parse(`${toIso}T00:00:00Z`);
  const monday = start - ((new Date(start).getUTCDay() + 6) % 7) * DAY;
  for (let ms = monday; ms <= end; ms += 7 * DAY) {
    const bStart = Math.max(ms, start);
    const bEnd = Math.min(ms + 6 * DAY, end);
    const days = Math.round((bEnd - bStart) / DAY) + 1;
    out.push({ day: new Date(ms).toISOString().slice(0, 10), revenue: 9000 * days, orders: 3 * days, items: 3 * days });
  }
  return out;
};
await p.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
  const url = new URL(route.request().url());
  const path = url.pathname;
  const json = (s, x) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(x) });
  if (path === '/api/auth/me') return json(200, { uid: 11, email: 'c@t.local', role: 'user', avatar: null });
  if (path === '/api/channels') return json(200, { enabled: true, channels: [{ id: 5, username: null, title: 'Склад', status: 'active', source: 'cdek' }], selected: 5 });
  if (path === '/api/prefs') return json(200, route.request().method() === 'GET' ? {} : { ok: true });
  if (path === '/api/cdek/status') return json(200, { channel_id: 5, title: 'Склад', warehouse_code: '1', tz: 'Europe/Moscow', last_import: null });
  if (path === '/api/cdek/summary') return json(200, { window: WIN, previous_window: PREV, include: 'revenue', current: { revenue: 810000, orders: 270, items: 270, avg_check: 3000, orders_all: 270, orders_cancelled: 0, orders_returned: 0, cancel_share: 0 }, previous: { revenue: 700000, orders: 240, items: 240, avg_check: 2900, orders_all: 240, orders_cancelled: 0, orders_returned: 0, cancel_share: 0 }, bounds: { first_day: '2025-01-01', last_day: '2026-08-31', orders: 5000 } });
  if (path === '/api/cdek/series') {
    return json(200, { window: WIN, grain: 'week', include: 'revenue', current: weekly(WIN.from, WIN.to), previous: weekly(PREV.from, PREV.to) });
  }
  if (path === '/api/cdek/breakdown') return json(200, { window: WIN, dim: url.searchParams.get('dim'), include: 'revenue', rows: [], other: null, total: { revenue: 1, orders: 1, items: 1, prev_revenue: 1, prev_orders: 1, groups: 0 }, truncated: false });
  return json(404, { error: 'not_stubbed' });
});
await p.addInitScript(() => {
  localStorage.setItem('pulse_channel', '5');
  localStorage.setItem('pulse_theme', 'dark');
  localStorage.setItem('pulse_widget_prefs', JSON.stringify({ 'cdek-revenue': { target: 10000 } }));
});
await p.goto('http://127.0.0.1:5177/metrics/cdek-revenue?p=90d', { waitUntil: 'domcontentloaded' });
await p.locator('main').waitFor({ state: 'visible', timeout: 40000 });
await p.waitForTimeout(2400);

const line = await p.evaluate(() => {
  const hint = [...document.querySelectorAll('aside p')].map((e) => e.textContent.trim()).find((t) => t.includes('Достигнута'));
  const goal = [...document.querySelectorAll('main svg text')].map((t) => t.textContent.trim()).filter((t) => t.startsWith('цель'));
  const legend = [...document.querySelectorAll('main *')].some((e) => e.textContent.trim() === 'Пред. период' && e.children.length === 0);
  return { hint, goal, legendHasGhost: legend };
});
console.log('ЛИНИЯ  ' + JSON.stringify(line));

await p.getByRole('button', { name: 'Столбцы' }).click();
await p.waitForTimeout(1400);
const bars = await p.evaluate(() => {
  const svg = [...document.querySelectorAll('main svg')].sort((a, b) => b.getBoundingClientRect().width - a.getBoundingClientRect().width)[0];
  const ghost = svg.querySelectorAll('[data-chart-series="comparison"]').length;
  const legend = [...document.querySelectorAll('main *')].some((e) => e.textContent.trim() === 'Пред. период' && e.children.length === 0);
  return { ghostMarks: ghost, legendHasGhost: legend };
});
console.log('СТОЛБЦЫ ' + JSON.stringify(bars));
await b.close();
