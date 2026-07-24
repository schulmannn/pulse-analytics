import { expect, test, type Page } from '@playwright/test';
import { selectPill } from './helpers';

/**
 * Упоминания — desktop URL-воспроизводимая периодная поверхность + сохранение мобильной ветки.
 *
 * Мок `/api/history/mentions` СКОУПИТ ответ по ?days= и ?source= (как сервер), поэтому смена периода
 * и фильтра источника реально меняет каждый агрегат/строку — это и проверяем. Desktop-таблица и
 * header chips скрыты на мобильном (430px), где остаётся прежняя карточная лента со своими
 * историческими per-widget period pills.
 */

const M = [
  { channel_id: '111', msg_id: 1, title: 'SMM', username: 'smm', link: 'https://t.me/smm/1', snippet: 'бренд один', views: 300, ago: 1 },
  { channel_id: '111', msg_id: 2, title: 'SMM', username: 'smm', link: 'https://t.me/smm/2', snippet: 'бренд два', views: 200, ago: 3 },
  { channel_id: '222', msg_id: 3, title: 'Blog', username: 'blog', link: 'https://t.me/blog/3', snippet: 'обзор канала', views: 500, ago: 5 },
  { channel_id: '222', msg_id: 4, title: 'Blog', username: 'blog', link: 'https://t.me/blog/4', snippet: 'ещё обзор', views: 100, ago: 20 },
  { channel_id: '111', msg_id: 5, title: 'SMM', username: 'smm', link: 'https://t.me/smm/5', snippet: 'прошлый период', views: 400, ago: 40 },
  { channel_id: '333', msg_id: 6, title: 'Old', username: 'old', link: 'https://t.me/old/6', snippet: 'архив вне окна', views: 999, ago: 200 },
];

const DAY = 86_400_000;
const isoDay = (ago: number) => new Date(Date.now() - ago * DAY).toISOString().slice(0, 10);

function scoped(days: number, source: string) {
  const inCur = (ago: number) => (days === 0 ? true : ago <= days - 1);
  const inPrev = (ago: number) => days !== 0 && ago >= days && ago <= 2 * days - 1;
  const curAll = M.filter((r) => inCur(r.ago)); // before source filter → source_options
  const cur = curAll.filter((r) => !source || r.channel_id === source);
  const prev = M.filter((r) => inPrev(r.ago) && (!source || r.channel_id === source));

  const daily = (rows: typeof M) => {
    const by = new Map<string, { day: string; mentions: number; views: number; channels: number }>();
    for (const r of rows) {
      const d = isoDay(r.ago);
      const e = by.get(d) ?? { day: d, mentions: 0, views: 0, channels: 0 };
      e.mentions += 1;
      e.views += r.views;
      by.set(d, e);
    }
    return [...by.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  };
  const sum = (rows: typeof M) => rows.reduce((s, r) => s + r.views, 0);
  const uniq = (rows: typeof M) => new Set(rows.map((r) => r.channel_id)).size;

  const optMap = new Map<string, { channel_id: string; title: string; username: string; count: number; views: number }>();
  for (const r of curAll) {
    const e = optMap.get(r.channel_id) ?? { channel_id: r.channel_id, title: r.title, username: r.username, count: 0, views: 0 };
    e.count += 1;
    e.views += r.views;
    optMap.set(r.channel_id, e);
  }

  return {
    enabled: true,
    available: true,
    total: cur.length,
    unique_channels: uniq(cur),
    total_views: sum(cur),
    by_day: {},
    top_channels: [...optMap.values()],
    recent: [...cur].sort((a, b) => a.ago - b.ago).map((r) => ({ ...r, date: new Date(Date.now() - r.ago * DAY).toISOString() })),
    daily: daily(cur),
    previous: days === 0 ? null : { total: prev.length, unique_channels: uniq(prev), total_views: sum(prev) },
    previous_daily: daily(prev),
    source_options: [...optMap.values()].sort((a, b) => b.count - a.count),
    source_summary: { total: curAll.length, unique_channels: uniq(curAll), total_views: sum(curAll) },
    scope: {
      days,
      source: source || null,
      limit: 100,
      current_from: days ? isoDay(days - 1) : null,
      current_to: isoDay(0),
      previous_from: days ? isoDay(2 * days - 1) : null,
      previous_to: days ? isoDay(days) : null,
      daily_days: days || 365,
    },
    archive_total: M.length,
    latest_seen: new Date(Date.now() - DAY).toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function boot(
  page: Page,
  options: { configured?: boolean; canEdit?: boolean; liveError?: string | null } = {},
) {
  let settings = {
    configured: options.configured ?? true,
    rules: {
      include_terms: options.configured === false ? [] : ['demo'],
      exclude_terms: [] as string[],
      exclude_sources: [] as string[],
      match_mode: 'contains' as 'contains' | 'word',
    },
    revision: options.configured === false ? 0 : 1,
    updated_at: options.configured === false ? null : new Date().toISOString(),
    can_edit: options.canEdit ?? true,
    own_source: { username: 'demo', tg_channel_id: '1001' },
  };
  let liveRequests = 0;
  let savedBody: unknown = null;
  const scopedChannelHeaders: string[] = [];

  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/api/auth/me') return json(200, { uid: 11, email: 'e2e@test.local', role: 'user', avatar: null });
    if (path === '/api/channels') {
      return json(200, {
        enabled: true,
        // central → живой поиск доступен (кнопка «Найти новые»).
        channels: [{ id: 1, username: 'demo', title: 'Demo', status: 'active', source: 'central', ig_connected: false }],
        selected: 1,
      });
    }
    if (path === '/api/history/mentions') {
      const days = Number(url.searchParams.get('days') || 0);
      const source = url.searchParams.get('source') || '';
      return json(200, scoped(days, source));
    }
    if (path === '/api/tg/mention-settings') {
      scopedChannelHeaders.push(req.headers()['x-channel-id'] || '');
      if (req.method() === 'PUT') {
        savedBody = req.postDataJSON();
        const rules = savedBody as typeof settings.rules;
        settings = {
          ...settings,
          configured: true,
          rules,
          revision: settings.revision + 1,
          updated_at: new Date().toISOString(),
        };
      }
      return json(200, settings);
    }
    if (path === '/api/tg/mtproto/mentions') {
      scopedChannelHeaders.push(req.headers()['x-channel-id'] || '');
      liveRequests += 1;
      if (options.liveError) return json(409, { available: false, error: options.liveError });
      return json(200, { available: true, total: M.length, recent: [] });
    }
    if (path === '/api/prefs') return json(200, req.method() === 'GET' ? {} : { ok: true });
    return json(404, { error: 'not_mocked' });
  });

  await page.addInitScript(() => {
    localStorage.setItem('pulse_token', 'e2e-token');
    localStorage.setItem('pulse_token_exp', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('pulse_channel', '1');
    localStorage.setItem('pulse_theme', 'dark');
  });

  return {
    liveRequests: () => liveRequests,
    savedBody: () => savedBody,
    scopedChannelHeaders,
  };
}

test.describe('Упоминания — desktop периодная поверхность', () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile-430', 'desktop-таблица/период скрыты на мобильном');
  });

  test('период и источник скоупят агрегаты и таблицу через URL и переживают reload', async ({ page }) => {
    await boot(page);
    await page.goto('/mentions');

    const rows = page.locator('table tbody tr');
    await expect(rows).toHaveCount(4); // дефолт 30д: rows ago 1,3,5,20

    // KPI присутствует и подписан честно.
    await expect(page.getByText('Потенциальные просмотры', { exact: true })).toBeVisible();
    await expect(page.getByText(/без дедупликации аудитории/)).toBeVisible();

    // Период 7д → ?period=7, окно сужается (ago 1,3,5).
    await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '7д' }).click();
    await expect(page).toHaveURL(/period=7/);
    await expect(rows).toHaveCount(3);

    // Обратно 30д — дефолт, URL чистый.
    await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '30д' }).click();
    await expect(page).not.toHaveURL(/period=/);
    await expect(rows).toHaveCount(4);

    // Фильтр источника → ?source=111, агрегаты по одному каналу (rows ago 1,3).
    await selectPill(page.getByTestId('mentions-source-filter'), { value: '111' });
    await expect(page).toHaveURL(/source=111/);
    await expect(rows).toHaveCount(2);
    await expect(page.getByTestId('mentions-result-count')).toHaveText(/2 упом/);

    // Поиск композируется с источником, клиентский по тексту.
    await page.getByLabel('Поиск по упоминаниям').fill('один');
    await expect(page).toHaveURL(/q=/);
    await expect(rows).toHaveCount(1);
    await page.getByRole('button', { name: 'Сбросить фильтры' }).click();
    await expect(page).not.toHaveURL(/source=|q=/);

    // Deep-link воспроизводит состояние.
    await page.goto('/mentions?period=7&source=222');
    await expect(page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '7д' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('mentions-source-filter')).toHaveAttribute('data-value', '222');
    await expect(rows).toHaveCount(1); // 222 в 7д = ago 5
    await expect(page.getByText('@blog · 33% упоминаний', { exact: true })).toBeVisible();
    await expect(page.getByText('50% у выбранного канала', { exact: true })).toBeVisible();

    // Живой поиск не стирает архив: кнопка есть для настроенного канала, таблица остаётся.
    await page.getByRole('button', { name: 'Найти новые' }).click();
    await expect(rows).toHaveCount(1);
  });

  test('правила настраиваются для выбранного канала, а поиск не стартует сам', async ({ page }) => {
    const state = await boot(page, { configured: false });
    await page.goto('/mentions');

    await expect(page.getByRole('button', { name: 'Найти новые' })).toHaveCount(0);
    expect(state.liveRequests()).toBe(0);

    await page.getByRole('button', { name: 'Настроить поиск' }).click();
    const dialog = page.getByRole('dialog', { name: 'Правила упоминаний' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Что искать').fill('notem\nнотем\nnōtem');
    await dialog.getByLabel('Исключить по тексту').fill('вакансия\nпромокод');
    await dialog.getByLabel('Исключить каналы').fill('@noise_channel\n123456789');
    await dialog.getByRole('button', { name: 'Целое слово' }).click();
    await dialog.getByRole('button', { name: 'Сохранить правила' }).click();
    await expect(dialog).toBeHidden();

    expect(state.savedBody()).toEqual({
      include_terms: ['notem', 'нотем', 'nōtem'],
      exclude_terms: ['вакансия', 'промокод'],
      exclude_sources: ['@noise_channel', '123456789'],
      match_mode: 'word',
    });
    expect(state.liveRequests()).toBe(0);
    await expect(page.getByRole('button', { name: 'Найти новые' })).toBeVisible();

    await page.getByRole('button', { name: 'Найти новые' }).click();
    await expect.poll(() => state.liveRequests()).toBe(1);
    expect(state.scopedChannelHeaders.every((value) => value === '1')).toBe(true);
  });

  test('viewer видит правила, но не может менять их или запускать поиск', async ({ page }) => {
    const state = await boot(page, { configured: true, canEdit: false });
    await page.goto('/mentions');

    await expect(page.getByRole('button', { name: 'Найти новые' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Правила поиска' }).click();
    const dialog = page.getByRole('dialog', { name: 'Правила упоминаний' });
    await expect(dialog.getByText(/доступ к просмотру/)).toBeVisible();
    await expect(dialog.getByLabel('Что искать')).toHaveAttribute('readonly', '');
    await expect(dialog.getByRole('button', { name: 'Сохранить правила' })).toHaveCount(0);
    expect(state.liveRequests()).toBe(0);
  });

  test('график по дням открывается отдельной страницей и сохраняет период с источником', async ({ page }) => {
    await boot(page);
    await page.goto('/mentions?period=7&source=111');

    await page.getByRole('heading', { name: 'Упоминания по дням', exact: true }).click();
    await expect(page).toHaveURL(/\/metrics\/mentions-timeline\?/);
    await expect(page).toHaveURL(/source=111/);
    await expect(page).toHaveURL(/p=7d/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Упоминания по дням' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Тип графика' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'База сравнения' })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Окно' })).toBeVisible();
    await expect(page.getByText('Telegram · @demo', { exact: true })).toBeVisible();

    const back = page.locator('main').getByRole('link', { name: /Упоминания$/ }).first();
    await expect(back).toHaveAttribute('href', /\/mentions\?period=7&source=111/);
  });

  test('полный рейтинг источников не схлопывается выбранным source и не показывает ложные контролы', async ({ page }) => {
    await boot(page);
    await page.goto('/metrics/mentions-sources?source=111&p=30d');

    await expect(page.getByRole('heading', { level: 1, name: 'Кто упоминает' })).toBeVisible();
    await expect(page.getByText('@smm', { exact: true })).toBeVisible();
    await expect(page.getByText('@blog', { exact: true })).toBeVisible();
    await expect(page.getByRole('group', { name: 'Тип графика' })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'База сравнения' })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Окно' })).toBeVisible();
    await expect(page.locator('main').getByRole('link', { name: /Упоминания$/ }).first()).toHaveAttribute(
      'href',
      /\/mentions\?source=111/,
    );
  });

  test('старый detail-deep-link канонизируется в metric route без оверлея', async ({ page }) => {
    await boot(page);
    await page.goto('/mentions?detail=mentions-timeline');

    await expect(page).toHaveURL(/\/metrics\/mentions-timeline$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Упоминания по дням' })).toBeVisible();
  });
});

test.describe('Упоминания — мобильная ветка сохранена', () => {
  test('на 430px остаётся старая карточная лента, desktop-контролов нет', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-430', 'проверка мобильной ветки');
    await boot(page);
    await page.goto('/mentions');

    // Старая мобильная поверхность: KPI «Суммарный охват» + кнопка «Обновить».
    await expect(page.getByText('Суммарный охват')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Обновить' })).toBeVisible();

    // Мобильная карточка больше не дублирует период: окно принадлежит выделенной metric-page.
    // Плотная desktop-таблица и её фильтр здесь также отсутствуют.
    await expect(page.getByRole('group', { name: 'Период' })).toHaveCount(0);
    await expect(page.locator('table')).toHaveCount(0);
    await expect(page.getByTestId('mentions-source-filter')).toHaveCount(0);
  });

  test('мобильная карточка динамики открывает ту же полноэкранную страницу', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-430', 'проверка мобильной ветки');
    await boot(page);
    await page.goto('/mentions');

    await page.getByRole('heading', { name: 'Упоминаний по дням', exact: true }).click();
    await expect(page).toHaveURL(/\/metrics\/mentions-timeline$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: 'Упоминания по дням' })).toBeVisible();
  });
});
