import { expect, test, type Page } from '@playwright/test';
import { selectPill } from './helpers';

/**
 * Смешанная кампания TG+IG на desktop-поверхности `/campaigns/:id` — доказывает НОВОЕ поведение,
 * которого не покрывает одно-платформенный campaigns.spec:
 *  1. Раздельные KPI обеих сетей (методологии не смешиваются).
 *  2. ОДИН full-width таймлайн-эксплорер с сегментным переключателем режима (TG-просмотры /
 *     IG-охват / публикации) — серии не рисуются вместе; переключение подменяет заголовок.
 *  3. Драйверы «Источники + Форматы» 50/50 и крайние посты строкой (не карточка-виджет).
 *  4. Интерактивная таблица: поиск, сортировка (URL), счётчик, чекбоксы, групповое удаление.
 *
 * Бэкенд целиком замокан stateful-роутом; кампания живёт в замыкании теста.
 */

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

interface Row {
  network: 'tg' | 'ig';
  channel_id: number;
  post_ref: string;
  published_at: string;
  media_type: string;
  caption: string;
  tg_views?: number;
  tg_reactions?: number;
  tg_forwards?: number;
  tg_replies?: number;
  ig_reach?: number;
  ig_views?: number;
  ig_likes?: number;
  ig_comments?: number;
  ig_saved?: number;
  ig_shares?: number;
}

const ROWS: Row[] = [
  { network: 'tg', channel_id: 1, post_ref: '201', published_at: iso(4 * DAY), media_type: 'photo', caption: 'TG анонс запуска', tg_views: 1000, tg_reactions: 10, tg_forwards: 5, tg_replies: 2 },
  { network: 'tg', channel_id: 1, post_ref: '202', published_at: iso(3 * DAY), media_type: 'video', caption: 'TG видео о продукте', tg_views: 3000, tg_reactions: 30, tg_forwards: 12, tg_replies: 4 },
  { network: 'ig', channel_id: 2, post_ref: 'ig_a', published_at: iso(3 * DAY), media_type: 'REELS', caption: 'IG reels тизер', ig_reach: 2000, ig_views: 5000, ig_likes: 40, ig_comments: 7, ig_saved: 6, ig_shares: 8 },
  { network: 'ig', channel_id: 2, post_ref: 'ig_b', published_at: iso(2 * DAY), media_type: 'IMAGE', caption: 'IG карточка продукта', ig_reach: 1200, ig_views: 0, ig_likes: 25, ig_comments: 2, ig_saved: 4, ig_shares: 3 },
];

const median = (nums: number[]): number | null => {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

async function boot(page: Page) {
  let rows = [...ROWS];
  const campaign = {
    id: 1,
    workspace_id: 1,
    name: 'Мультиканальный запуск',
    description: 'TG + Instagram',
    color: null as string | null,
    status: 'active',
    start_date: null as string | null,
    end_date: null as string | null,
    created_by: 11,
    created_at: iso(DAY),
    updated_at: new Date().toISOString(),
    my_role: 'owner',
  };

  const enrich = (r: Row) => ({
    network: r.network,
    channel_id: r.channel_id,
    post_ref: r.post_ref,
    published_at: r.published_at,
    media_type: r.media_type,
    caption: r.caption,
    added_at: iso(DAY),
    channel_title: r.network === 'tg' ? 'TG канал' : 'IG аккаунт',
    channel_username: r.network === 'tg' ? 'tgchan' : 'igacc',
    accessible: true,
    tg_views: r.tg_views ?? null,
    tg_reactions: r.tg_reactions ?? null,
    tg_forwards: r.tg_forwards ?? null,
    tg_replies: r.tg_replies ?? null,
    ig_reach: r.ig_reach ?? null,
    ig_views: r.ig_views ?? null,
    ig_likes: r.ig_likes ?? null,
    ig_comments: r.ig_comments ?? null,
    ig_saved: r.ig_saved ?? null,
    ig_shares: r.ig_shares ?? null,
  });

  const buildSummary = (network?: 'tg' | 'ig', channelId?: number) => {
    const summaryRows = network && channelId != null
      ? rows.filter((row) => row.network === network && row.channel_id === channelId)
      : rows;
    const tg = summaryRows.filter((r) => r.network === 'tg');
    const ig = summaryRows.filter((r) => r.network === 'ig');
    const tgViews = tg.map((r) => r.tg_views!).filter((v) => v != null);
    const igReach = ig.map((r) => r.ig_reach!).filter((v) => v != null);
    const tgMed = median(tgViews);
    const igMed = median(igReach);
    const bestWorst = (net: 'tg' | 'ig') => {
      const src = net === 'tg' ? tg : ig;
      const val = (r: Row) => (net === 'tg' ? r.tg_views! : r.ig_reach!);
      const med = net === 'tg' ? tgMed : igMed;
      const scored = src
        .map((r) => ({ network: net, channel_id: r.channel_id, post_ref: r.post_ref, caption: r.caption, published_at: r.published_at, value: val(r), ratio: med ? Math.round((val(r) / med) * 10) / 10 : null }))
        .sort((a, b) => b.value - a.value);
      return { best: scored[0] ?? null, worst: scored.length > 1 ? scored.at(-1)! : null };
    };
    const days = new Map<string, { day: string; posts: number; tg_views: number | null; ig_reach: number | null }>();
    for (const r of summaryRows) {
      const day = r.published_at.slice(0, 10);
      const t = days.get(day) ?? { day, posts: 0, tg_views: null, ig_reach: null };
      t.posts += 1;
      if (r.tg_views != null) t.tg_views = (t.tg_views ?? 0) + r.tg_views;
      if (r.ig_reach != null) t.ig_reach = (t.ig_reach ?? 0) + r.ig_reach;
      days.set(day, t);
    }
    const bySource = [];
    if (tg.length) bySource.push({ network: 'tg', channel_id: 1, title: 'TG канал', username: 'tgchan', posts: tg.length, tg_views: tgViews.reduce((a, b) => a + b, 0) });
    if (ig.length) bySource.push({ network: 'ig', channel_id: 2, title: 'IG аккаунт', username: 'igacc', posts: ig.length, ig_reach: igReach.reduce((a, b) => a + b, 0) });
    const byFormat = [];
    if (tg.length) byFormat.push({ network: 'tg', media_type: 'photo', posts: tg.length, tg_views: tgViews.reduce((a, b) => a + b, 0) });
    if (ig.length) byFormat.push({ network: 'ig', media_type: 'REELS', posts: ig.length, ig_reach: igReach.reduce((a, b) => a + b, 0) });
    return {
      campaign,
      posts_total: summaryRows.length,
      inaccessible_posts: 0,
      undated_posts: 0,
      period: { from: null, to: null },
      tg: tg.length
        ? { posts: tg.length, views: tgViews.reduce((a, b) => a + b, 0), avg: Math.round(tgViews.reduce((a, b) => a + b, 0) / tgViews.length), median: tgMed, reactions: 40, forwards: 17, ...bestWorst('tg') }
        : { posts: 0 },
      ig: ig.length
        ? { posts: ig.length, reach: igReach.reduce((a, b) => a + b, 0), median: igMed, views: 5000, likes: 65, saved: 0, ...bestWorst('ig') }
        : { posts: 0 },
      by_source: bySource,
      by_format: byFormat,
      timeline: [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
      comparison: { available: false, reason: 'insufficient_data' },
    };
  };

  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const method = req.method();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/api/auth/me') return json(200, { uid: 11, email: 'e2e@test.local', role: 'user', avatar: null });
    if (path === '/api/channels') {
      return json(200, {
        enabled: true,
        channels: [{ id: 1, username: 'tgchan', title: 'TG канал', status: 'active', source: 'collector', ig_connected: true }],
        selected: 1,
      });
    }
    if (path === '/api/tg/full') return json(200, { channel: { title: 'TG канал', username: 'tgchan', memberCount: 1200 }, views_summary: null, posts: [], mtproto_available: true, source: 'db' });
    if (path === '/api/tg/mtproto/graphs') return json(200, {});
    if (path === '/api/prefs') return json(200, method === 'GET' ? {} : { ok: true });
    if (path === '/api/campaigns' && method === 'GET') return json(200, { campaigns: [{ ...campaign, post_count: rows.length }] });

    const m = path.match(/^\/api\/campaigns\/(\d+)(\/posts|\/summary)?$/);
    if (m) {
      if (Number(m[1]) !== 1) return json(404, { error: 'Кампания не найдена' });
      if (m[2] === '/summary') {
        const network = url.searchParams.get('network');
        const channelId = Number(url.searchParams.get('channel_id'));
        const scopeNetwork = network === 'tg' || network === 'ig' ? network : undefined;
        return json(200, {
          summary: buildSummary(scopeNetwork, scopeNetwork && Number.isInteger(channelId) ? channelId : undefined),
        });
      }
      if (m[2] === '/posts' && method === 'GET') return json(200, { posts: rows.map(enrich), inaccessible_count: 0 });
      if (m[2] === '/posts' && method === 'DELETE') {
        const items = (req.postDataJSON() as { items: { network: string; channel_id: number; post_ref: string }[] }).items;
        const before = rows.length;
        rows = rows.filter((r) => !items.some((it) => it.network === r.network && it.channel_id === r.channel_id && it.post_ref === r.post_ref));
        return json(200, { removed: before - rows.length });
      }
      if (method === 'GET') return json(200, { campaign: { ...campaign, post_count: rows.length } });
    }
    return json(404, { error: 'not_mocked' });
  });

  await page.addInitScript(() => {
    localStorage.setItem('pulse_token', 'e2e-token');
    localStorage.setItem('pulse_token_exp', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('pulse_channel', '1');
    localStorage.setItem('pulse_theme', 'dark');
  });

  await page.goto('/campaigns/1');
  await page.getByTestId('campaign-name').waitFor({ state: 'visible', timeout: 25_000 });
}

test.describe('Смешанная кампания TG+IG', () => {
  test('раздельные KPI · один таймлайн-эксплорер с режимами · интерактивная таблица', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile-430', 'desktop-поверхность (интерактивная таблица скрыта на мобильном)');
    await boot(page);
    await testInfo.attach('campaign-mixed-desktop', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });

    // ── 1. Раздельные KPI обеих сетей ──
    await expect(page.getByText('Публикации TG')).toBeVisible();
    await expect(page.getByText('Публикации IG')).toBeVisible();
    await expect(page.getByText('Сумма охватов', { exact: true })).toBeVisible(); // IG-метрика, не TG

    // ── 2. Один таймлайн-эксплорер: три режима, серии не совмещаются ──
    const tgMode = page.getByTestId('campaign-timeline-mode-tg_views');
    const igMode = page.getByTestId('campaign-timeline-mode-ig_reach');
    const postsMode = page.getByTestId('campaign-timeline-mode-posts');
    await expect(tgMode).toBeVisible();
    await expect(igMode).toBeVisible();
    await expect(postsMode).toBeVisible();
    // По умолчанию активен TG-режим; заголовок графика — TG, IG-охват НЕ отрисован как отдельный график.
    await expect(page.getByText('Просмотры TG · по дате публикации')).toBeVisible();
    await expect(page.getByText('Сумма охватов IG · по дате публикации')).toHaveCount(0);
    // Переключение режима подменяет ОДНУ серию: теперь виден IG-заголовок, а TG-заголовок исчез.
    await igMode.click();
    await expect(igMode).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => new URL(page.url()).searchParams.get('metric')).toBe('ig_reach');
    await expect(page.getByText('Сумма охватов IG · по дате публикации')).toBeVisible();
    await expect(page.getByText('Просмотры TG · по дате публикации')).toHaveCount(0);

    // ── 3. Драйверы 50/50 и крайние посты строкой ──
    await expect(page.getByText('Источники · вклад внутри своей платформы')).toBeVisible();
    await expect(page.getByText('Форматы · по числу публикаций')).toBeVisible();
    await expect(page.getByTestId('campaign-extremes')).toBeVisible();

    // ── 4. Интерактивная таблица: счётчик, поиск, сортировка (URL), чекбоксы, групповое удаление ──
    const tableRows = page.getByTestId('campaign-posts-table').locator('tbody tr');
    const table = page.getByTestId('campaign-posts-table');
    await expect(tableRows).toHaveCount(4);
    await expect(page.getByTestId('campaign-posts-count')).toContainText('4 публ.');
    await expect(table.getByRole('columnheader', { name: 'Основной результат' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Взаимодействия' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Просмотры' })).toHaveCount(0);
    await expect(table.getByRole('columnheader', { name: 'Охват' })).toHaveCount(0);
    await expect(table.getByText('TG просмотры').first()).toBeVisible();
    await expect(table.getByText('IG сумма охватов').first()).toBeVisible();
    await expect(table.getByText('TG реакции + репосты + комментарии').first()).toBeVisible();
    await expect(table.getByText('IG лайки + комментарии + сохранения + репосты').first()).toBeVisible();

    // Поиск сужает до IG reels.
    await page.getByTestId('campaign-posts-search').fill('reels');
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('reels');
    await expect.poll(() => new URL(page.url()).searchParams.get('metric')).toBe('ig_reach');
    await expect(tableRows).toHaveCount(1);
    await expect(page.getByTestId('campaign-posts-count')).toContainText('1 из 4');

    // Источник дополняет тот же URL, не стирая режим графика и поиск.
    await selectPill(page.getByTestId('campaign-source-filter'), { value: 'ig:2' });
    await expect.poll(() => new URL(page.url()).searchParams.get('source')).toBe('ig:2');
    await expect.poll(() => new URL(page.url()).searchParams.get('metric')).toBe('ig_reach');
    await expect.poll(() => new URL(page.url()).searchParams.get('q')).toBe('reels');
    await expect(tableRows).toHaveCount(1);
    await selectPill(page.getByTestId('campaign-source-filter'), { value: '' });
    await expect.poll(() => new URL(page.url()).searchParams.has('source')).toBe(false);
    await page.getByTestId('campaign-posts-search').fill('');
    await expect.poll(() => new URL(page.url()).searchParams.has('q')).toBe(false);

    // Сортировка пишет канонический sort и сохраняет выбранный режим графика.
    await table.getByRole('button', { name: 'Основной результат', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('sort')).toBe('result');
    await expect.poll(() => new URL(page.url()).searchParams.get('metric')).toBe('ig_reach');
    await expect.poll(() => new URL(page.url()).searchParams.has('tq')).toBe(false);
    await expect.poll(() => new URL(page.url()).searchParams.has('tsort')).toBe(false);
    await expect(tableRows).toHaveCount(4);

    // Групповое удаление: выбрать одну TG- и одну IG-строку и убрать только membership.
    await tableRows.filter({ hasText: 'TG видео о продукте' }).getByTestId('campaign-post-select').check();
    await tableRows.filter({ hasText: 'IG reels тизер' }).getByTestId('campaign-post-select').check();
    await expect(page.getByText('Выбрано: 2')).toBeVisible();
    await page.getByTestId('campaign-bulk-remove').click();
    const removeConfirm = page.getByRole('alertdialog');
    await expect(removeConfirm).toBeVisible();
    await expect(removeConfirm.getByText('Убрать 2 публ. из кампании?')).toBeVisible();
    await removeConfirm.getByRole('button', { name: 'Убрать' }).click();
    await expect(tableRows).toHaveCount(2);
  });

  test('рабочая поверхность: плотность · видимость колонок · соседний инспектор · изоляция клика', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name === 'mobile-430', 'desktop-поверхность (интерактивная таблица скрыта на мобильном)');
    await boot(page);
    const table = page.getByTestId('campaign-posts-table');
    const tableRows = table.locator('tbody tr');
    await expect(tableRows).toHaveCount(4);

    // ── Плотность — Astryx SegmentedControl (radiogroup). Дефолт «Обычно» → data-density=balanced. ──
    await expect(table).toHaveAttribute('data-density', 'balanced');
    await page.getByRole('radio', { name: 'Плотно' }).click();
    await expect(table).toHaveAttribute('data-density', 'compact');
    await page.getByRole('radio', { name: 'Свободно' }).click();
    await expect(table).toHaveAttribute('data-density', 'spacious');

    // ── Видимость колонок — Astryx MultiSelector. Скрытие активной метрики сортировки безопасно ──
    // ── возвращает сортировку к «дата, убыв». ──
    await table.getByRole('button', { name: 'Основной результат', exact: true }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('sort')).toBe('result');
    await expect(table.getByRole('columnheader', { name: 'Основной результат' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Колонки' }).click();
    await page.getByRole('option', { name: 'Основной результат' }).click();
    await page.keyboard.press('Escape');
    await expect(table.getByRole('columnheader', { name: 'Основной результат' })).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.has('sort')).toBe(false);
    // Взаимодействия остаётся, идентичность/дата/действия по-прежнему на месте.
    await expect(table.getByRole('columnheader', { name: 'Взаимодействия' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Публикация' })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Дата' })).toBeVisible();
    await expect(tableRows).toHaveCount(4);

    // ── Соседний инспектор: клик по строке раскрывает панель с сетью/источником и метриками. ──
    await tableRows.filter({ hasText: 'TG видео о продукте' }).locator('[data-campaign-post-open-trigger]').click();
    const inspector = page.locator('[data-campaign-inspector-open]');
    await expect(inspector).toBeVisible();
    await expect(inspector.getByText('TG видео о продукте')).toBeVisible();
    await expect(inspector.getByText('TG просмотры')).toBeVisible();
    await expect(inspector.getByText('TG реакции + репосты + комментарии')).toBeVisible();
    const overflowContract = await table.evaluate((element) => ({
      tableOverflowX: getComputedStyle(element.parentElement!).overflowX,
      pageFitsViewport: document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
    }));
    expect(['auto', 'scroll']).toContain(overflowContract.tableOverflowX);
    expect(overflowContract.pageFitsViewport).toBeTruthy();
    await testInfo.attach('campaign-inspector-desktop', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

    // ── Чекбокс не открывает инспектор (клик изолирован от строки). ──
    await inspector.getByRole('button', { name: 'Закрыть' }).click();
    await expect(page.locator('[data-campaign-inspector-open]')).toHaveCount(0);
    await tableRows.filter({ hasText: 'TG анонс запуска' }).getByTestId('campaign-post-select').check();
    await expect(page.getByText('Выбрано: 1')).toBeVisible();
    await expect(page.locator('[data-campaign-inspector-open]')).toHaveCount(0);

    // ── Инспектор закрывается, когда его пост уходит из выборки (фильтр/удаление). ──
    await tableRows.filter({ hasText: 'IG reels тизер' }).locator('[data-campaign-post-open-trigger]').click();
    await expect(page.locator('[data-campaign-inspector-open]')).toBeVisible();
    await page.getByTestId('campaign-posts-search').fill('карточка');
    await expect(tableRows).toHaveCount(1);
    await expect(page.locator('[data-campaign-inspector-open]')).toHaveCount(0);
  });

  test('mobile сохраняет прежние графики и семантику таблицы', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-430', 'контракт только для сохранённой mobile-ветки');
    await boot(page);

    await expect(page.getByTestId('campaign-timeline-mode-tg_views')).toHaveCount(0);
    await expect(page.getByText('Просмотры TG · по дате публикации')).toBeVisible();
    await expect(page.getByText('Сумма охватов IG · по дате публикации')).toBeVisible();

    const table = page.getByTestId('campaign-posts-table');
    for (const header of ['Источник', 'Пост', 'Дата', 'Просмотры', 'Охват', 'Реакции/Лайки', 'Репосты']) {
      await expect(table.getByRole('columnheader', { name: header, exact: true })).toBeVisible();
    }
    await expect(page.getByTestId('campaign-posts-search')).toHaveCount(0);
    await expect(page.getByTestId('campaign-post-select')).toHaveCount(0);
  });
});
