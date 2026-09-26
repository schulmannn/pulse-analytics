import { expect, test, type Page } from '@playwright/test';

/**
 * Архив Instagram «как у TG» (OD-13): «Всё» и «Свой период» читают АРХИВ ig_daily без 90-дневного
 * потолка, а пресеты 7/30/90 остаются живыми агрегатами Graph.
 *
 * Стенд без pulse_demo: весь IG-кластер отвечает роутами. /api/ig/history отдаёт 540 дней архива с
 * одной дырой (день без сбора) и границы; живые инсайты нарочно отдают ДРУГИЕ числа (охват по 1000
 * в день и дедуп-агрегат 99 999), чтобы спутать архивное окно с живым было невозможно.
 *
 * Проверяется: точные суммы архива на «Всё» и на своём периоде годичной давности (дыра не стала
 * нулём), подпись «сумма по дням», честная подсказка покрытия в слоте «нет базы», один общий запрос
 * архива ?days=0, отсутствие живых инсайтов на архивном окне и отсутствие горизонтального скролла.
 */

test.use({ timezoneId: 'UTC' });

const DAY_MS = 86_400_000;
const T0 = Date.now();
const dayKey = (offset: number) => new Date(T0 + offset * DAY_MS).toISOString().slice(0, 10);
const N = 540;
const GAP = -300;   // день без сбора внутри своего периода

/** 540 дней архива: охват 1, взаимодействия 1 в день; день GAP отсутствует целиком. */
const ROWS = Array.from({ length: N }, (_, i) => i - N)
  .filter((offset) => offset !== GAP)
  .map((offset) => ({
    day: dayKey(offset),
    reach: 1,
    views: 2,
    total_interactions: 1,
    likes: 1,
    follows: 1,
    unfollows: 0,
    accounts_engaged: 7,
  }));
const BOUNDS = { first_day: dayKey(-N), last_day: dayKey(-1) };

function insightsFor(days: number) {
  const points = Math.min(days, 90);
  const reach = Array.from({ length: points }, (_, i) => ({ value: 1000, end_time: new Date(T0 + (i - points) * DAY_MS).toISOString() }));
  const agg = (name: string, cur: number) => ({
    name,
    period: 'day',
    values: [{ value: cur, end_time: new Date(T0 - points * DAY_MS).toISOString() }, { value: cur, end_time: new Date(T0).toISOString() }],
    total_value: { value: cur },
  });
  return {
    data: [
      { name: 'reach', period: 'day', values: reach },
      agg('views', 77_777),
      agg('total_interactions', 55_555),
      agg('reach_window', 99_999),
      agg('follows', 10),
      agg('unfollows', 5),
    ],
  };
}

async function bootIgArchive(page: Page, period: { days: number; range: { from: number; to: number } | null }) {
  const historyHits: string[] = [];
  const insightsHits: number[] = [];
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/auth/me') return json({ uid: 42, email: 'owner@pulse.local', role: 'user', avatar: null });
    if (url.pathname === '/api/channels' && request.method() === 'GET') {
      return json({
        enabled: true,
        channels: [{ id: 9, username: 'bynotem', title: 'bynotem', status: 'active', source: 'ig', ig_connected: true }],
      });
    }
    if (url.pathname === '/api/ig/oauth/status') {
      return json({
        server_ready: true, env_fallback: false, connected: true, channel_id: 9,
        username: 'bynotem', ig_user_id: 'igid123', connected_at: '2026-07-03T10:00:00',
        token_expires_at: new Date(T0 + 45 * DAY_MS).toISOString(), token_state: 'ok',
      });
    }
    if (url.pathname === '/api/ig/profile') {
      return json({ username: 'bynotem', name: 'notem', followers_count: 20_500, follows_count: 300, media_count: 420, synced_at: T0 });
    }
    if (url.pathname === '/api/ig/insights') {
      const days = Number(url.searchParams.get('days') ?? 30);
      insightsHits.push(days);
      return json(insightsFor(days));
    }
    if (url.pathname === '/api/ig/history') {
      historyHits.push(url.search);
      return json({
        enabled: true,
        rows: ROWS,
        bounds: BOUNDS,
        coverage: { measured_days: ROWS.length },
        window: BOUNDS && { from: BOUNDS.first_day, to: BOUNDS.last_day },
        backfill: { status: 'running', horizon_day: BOUNDS.first_day, cursor_day: dayKey(-N - 1), reason: null },
      });
    }
    if (url.pathname === '/api/ig/posts') return json({ data: [] });
    if (url.pathname.startsWith('/api/ig/')) return json({ data: [] });
    if (url.pathname === '/api/tg/qr/status') return json({ connected: false, server_ready: false });
    if (url.pathname === '/api/prefs') return json({});
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not_stubbed"}' });
  });
  await page.addInitScript((stored) => {
    localStorage.setItem('pulse_channel', '9');
    localStorage.setItem('pulse_theme', 'dark');
    localStorage.setItem('pulse_page_period', JSON.stringify(stored));
  }, period);
  await page.goto('/instagram');
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  return { historyHits, insightsHits };
}

const reachHeadline = (page: Page) =>
  page
    .locator('section[data-widget-size]')
    .filter({ has: page.getByRole('heading', { name: 'Охват', exact: true }) })
    .first()
    .locator('[data-chart-card-headline]')
    .first();

/** Крупное число карточки плоским текстом: цифры NumberFlow живут в shadow DOM, а ядро числа —
    ровно одной копией в sr-only-спане (контракт KpiNumber); суффикс (k/M) — обычный текст. */
async function kpiText(page: Page): Promise<string> {
  return reachHeadline(page).evaluate((el) => {
    const value = el.querySelector<HTMLElement>('[data-kpi-value]');
    if (!value) return '';
    const core = value.querySelector<HTMLElement>('.sr-only')?.textContent ?? value.textContent ?? '';
    const suffix = [...value.querySelectorAll<HTMLElement>('span')]
      .filter((s) => !s.classList.contains('sr-only') && !s.closest('[aria-hidden="true"]') && s.children.length === 0)
      .map((s) => s.textContent ?? '')
      .filter((t) => /^[kMB]$/.test(t.trim()))
      .join('');
    return `${core}${suffix}`.replace(/\s/g, '');
  });
}

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test('«Всё» — весь архив ig_daily: точная сумма по дням, дыра не ноль, подсказка покрытия', async ({ page }) => {
  const { historyHits, insightsHits } = await bootIgArchive(page, { days: 0, range: null });
  const headline = reachHeadline(page);
  await expect(headline).toContainText('сумма по дням', { timeout: 15_000 });
  // 540 дней минус один пропуск — не 90 дней живого окна (90 000) и не дедуп-агрегат (99 999).
  await expect.poll(() => kpiText(page)).toBe(String(ROWS.length));
  // Покрытие архива — в существующем слоте «нет базы» (подсказка), без новой вёрстки.
  const noBasis = page.locator('[title*="История Instagram догружается — архив пока с"]').first();
  await expect(noBasis).toBeAttached();
  await expect(page.locator('[title*="окно «Всё» — прошлого периода не существует"]').first()).toBeAttached();
  // Один общий архивный запрос на всю доску: ?days=0, а не 400-дневный legacy.
  expect(historyHits.length).toBeGreaterThanOrEqual(1);
  expect(new Set(historyHits)).toEqual(new Set(['?days=0']));
  // Архивное окно живых инсайтов не просит: его числа — суммы архива, квота Graph не тратится
  // (7/14 — «Неделя аккаунта» со своим окном).
  expect(insightsHits.filter((d) => d === 30 || d === 90)).toEqual([]);
  await expectNoHorizontalScroll(page);
});

test('свой период годичной давности — ровно его календарные дни из архива', async ({ page }) => {
  const from = Date.parse(`${dayKey(-400)}T00:00:00Z`);
  const to = Date.parse(`${dayKey(-200)}T23:59:59.999Z`);
  const { insightsHits } = await bootIgArchive(page, { days: 30, range: { from, to } });
  const expected = ROWS.filter((r) => r.day >= dayKey(-400) && r.day <= dayKey(-200)).length;
  expect(expected).toBe(200);   // 201 день окна минус пропуск — пропуск в сумму не входит
  const headline = reachHeadline(page);
  await expect(headline).toContainText('сумма по дням', { timeout: 15_000 });
  await expect.poll(() => kpiText(page)).toBe(String(expected));
  await expect(page.locator('[title*="свой период — парного прошлого окна нет"]').first()).toBeAttached();
  // Хедлайн своего периода больше не живое окно «до сейчас» (раньше — insights?days=90 от длины
  // диапазона): окно инсайтов для него не запрашивается. 7/14 — это «Неделя аккаунта», не окно.
  expect(insightsHits.filter((d) => d === 30 || d === 90)).toEqual([]);
  await expectNoHorizontalScroll(page);
});

test('пресет 30д остаётся живым агрегатом — архив его числа не подменяет', async ({ page }) => {
  const { insightsHits } = await bootIgArchive(page, { days: 30, range: null });
  const headline = reachHeadline(page);
  await expect.poll(() => kpiText(page), { timeout: 15_000 }).toBe('100k');   // fmt.kpi(99 999) — дедуп-агрегат
  await expect(headline).not.toContainText('сумма по дням');
  expect(insightsHits).toContain(30);
  await expectNoHorizontalScroll(page);
});

test('аналитика на «Всё»: охват — сумма по дням, вовлечённые аккаунты — «—», а не ноль', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Таблица сравнения периодов — desktop-поверхность');
  await bootIgArchive(page, { days: 0, range: null });
  await page.goto('/instagram/analytics');
  await expect(page.getByText('Охват · сумма по дням: уникальный охват за такой период Instagram не считает', { exact: false })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Вовлечённые аккаунты за такой период не суммируются', { exact: false })).toBeVisible();
  const engagedRow = page.getByRole('row').filter({ hasText: 'Вовлечено аккаунтов' });
  await expect(engagedRow.getByRole('cell').nth(1)).toHaveText('—');
});
