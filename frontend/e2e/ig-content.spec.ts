import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { selectPill } from './helpers';

/**
 * Instagram Контент 2.0 (desktop) — URL-воспроизводимая таблица публикаций + вторичные разборы за
 * табом + детальная модалка + bulk-путь кампании. Проверяет вертикаль lib/igContentFilters через
 * настоящий UI: поиск/формат/сортировка сериализуются в URL и композируются с ?campaign=/?more=,
 * переживают reload; активный фильтр кампании даёт убрать membership прямо из таблицы. Стейт живёт в
 * замыкании мока (как настоящая БД) — тот же приём, что e2e/content-filters.spec.ts.
 */

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

// Six recent posts (inside the default 30-day window) — ≥5 so the median honesty gate activates.
const IG_POSTS = [
  { id: 'p1', timestamp: iso(1 * DAY), media_type: 'IMAGE', reach: 1000, views: 1200, like_count: 40, comments_count: 5, saved: 8, shares: 3, total_interactions: 56, caption: 'launch alpha #promo' },
  { id: 'p2', timestamp: iso(2 * DAY), media_type: 'VIDEO', media_product_type: 'FEED', reach: 3000, views: 5000, like_count: 120, comments_count: 12, saved: 20, shares: 10, total_interactions: 162, caption: 'launch beta clip' },
  { id: 'p3', timestamp: iso(3 * DAY), media_type: 'CAROUSEL_ALBUM', reach: 2000, views: 2100, like_count: 80, comments_count: 8, saved: 15, shares: 6, total_interactions: 109, caption: 'gallery carousel #promo' },
  { id: 'p4', timestamp: iso(4 * DAY), media_type: 'VIDEO', media_product_type: 'REELS', reach: 4000, views: 12000, like_count: 200, comments_count: 20, saved: 40, shares: 25, total_interactions: 285, caption: 'reel drop', ig_reels_avg_watch_time: 8200, ig_reels_video_view_total_time: 3_600_000 },
  { id: 'p5', timestamp: iso(6 * DAY), media_type: 'IMAGE', reach: 500, views: 520, like_count: 10, comments_count: 1, saved: 2, shares: 0, total_interactions: 13, caption: 'quiet photo' },
  { id: 'p6', timestamp: iso(8 * DAY), media_type: 'IMAGE', reach: 1500, views: 1550, like_count: 60, comments_count: 4, saved: 9, shares: 4, total_interactions: 77, caption: 'midweek update #promo' },
];

async function boot(page: Page, seedCampaignMembers: string[] = []) {
  const memberships = new Set(seedCampaignMembers);
  const campaignRow = () => ({
    id: 1, workspace_id: 1, name: 'Запуск', description: '', color: null, status: 'active',
    start_date: null, end_date: null, created_by: 11, created_at: iso(DAY), updated_at: iso(0),
    my_role: 'owner', post_count: memberships.size,
  });
  const enrich = (ref: string) => {
    const p = IG_POSTS.find((x) => x.id === ref);
    return {
      network: 'ig', channel_id: 1, post_ref: ref, published_at: p?.timestamp ?? null,
      media_type: p?.media_type ?? null, caption: p?.caption ?? null, added_at: iso(0),
      channel_title: 'IG аккаунт', channel_username: 'igacct', accessible: true,
      tg_views: null, tg_reactions: null, tg_forwards: null, tg_replies: null,
      ig_reach: p?.reach ?? null, ig_views: p?.views ?? null, ig_likes: p?.like_count ?? null,
      ig_comments: p?.comments_count ?? null, ig_saved: p?.saved ?? null, ig_shares: p?.shares ?? null,
    };
  };

  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (path === '/api/auth/me') return json(200, { uid: 11, email: 'e2e@test.local', role: 'user', avatar: null });
    if (path === '/api/channels') {
      return json(200, {
        enabled: true,
        channels: [{ id: 1, username: 'igacct', title: 'IG аккаунт', status: 'active', source: 'ig', ig_connected: true }],
        selected: 1,
      });
    }
    if (path === '/api/prefs') return json(200, method === 'GET' ? {} : { ok: true });

    // IG data cluster.
    if (path === '/api/ig/profile') return json(200, { mock: false, username: 'igacct', name: 'IG аккаунт', followers_count: 12000, synced_at: Date.now() });
    if (path === '/api/ig/insights') return json(200, { mock: false, data: [] });
    if (path === '/api/ig/posts') return json(200, { mock: false, data: IG_POSTS });
    if (path === '/api/ig/breakdowns') return json(200, { mock: false, data: [] });
    if (path === '/api/ig/online') return json(200, { mock: false, data: [] });
    if (path === '/api/ig/stories') return json(200, { mock: false, data: [] });
    if (path === '/api/ig/tags') return json(200, { mock: false, data: [] });
    if (path === '/api/ig/history') return json(200, { enabled: true, rows: [] });
    if (path === '/api/ig/oauth/status') return json(200, { connected: true });

    // Campaigns.
    if (path === '/api/campaigns' && method === 'GET') return json(200, { campaigns: [campaignRow()] });
    if (path === '/api/campaigns/1/posts' && method === 'GET') return json(200, { posts: [...memberships].map(enrich), inaccessible_count: 0 });
    if (path === '/api/campaigns/1/posts' && method === 'DELETE') {
      const items = (req.postDataJSON() as { items: { post_ref: string }[] }).items;
      let removed = 0;
      for (const it of items) if (memberships.delete(it.post_ref)) removed += 1;
      return json(200, { removed });
    }
    if (path === '/api/campaigns/1' && method === 'GET') return json(200, { campaign: campaignRow() });
    return json(404, { error: 'not_mocked' });
  });

  await page.addInitScript(() => {
    localStorage.setItem('pulse_token', 'e2e-token');
    localStorage.setItem('pulse_token_exp', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('pulse_channel', '1');
    localStorage.setItem('pulse_theme', 'dark');
  });
}

test.describe('Instagram Контент 2.0 (desktop)', () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-таблица и её фильтры скрыты на мобильном');
  });

  test('поиск/формат/сортировка + вторичный разбор сериализуются в URL, композируются и переживают reload', async ({ page }, testInfo) => {
    await boot(page);
    await page.goto('/instagram/content');
    const rows = page.locator('table tbody tr');
    await expect(rows).toHaveCount(6);
    await expect(page.getByTestId('ig-content-result-count')).toHaveText(/6 публ\./);
    await testInfo.attach('ig-content-dark-desktop', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

    // Чистый дефолт не засоряет URL.
    await expect(page).not.toHaveURL(/[?&]q=|format=|sort=|order=|more=/);

    // Поиск → ?q=, регистронезависимо; фраза с пробелом сохраняется.
    await page.getByLabel('Поиск по публикациям').fill('launch');
    await expect(page).toHaveURL(/q=launch/);
    await expect(rows).toHaveCount(2);
    await page.getByLabel('Поиск по публикациям').fill('');
    await expect(page).not.toHaveURL(/q=/);

    // Формат: Reels — только медиа-продукт REELS (не любое видео).
    await selectPill(page.getByTestId('ig-format-filter'), { value: 'reels' });
    await expect(page).toHaveURL(/format=reels/);
    await expect(rows).toHaveCount(1);
    await selectPill(page.getByTestId('ig-format-filter'), { value: 'video' });
    await expect(rows).toHaveCount(1); // p2 (FEED video), не reel
    await selectPill(page.getByTestId('ig-format-filter'), { value: 'all' });
    await expect(page).not.toHaveURL(/format=/);

    // Сортировка по сохранениям: первый клик sort=saved (desc — дефолт, в URL нет), второй → asc.
    await page.getByRole('button', { name: /Сохранения/ }).click();
    await expect(page).toHaveURL(/sort=saved/);
    await expect(page).not.toHaveURL(/order=/);
    await page.getByRole('button', { name: /Сохранения/ }).click();
    await expect(page).toHaveURL(/order=asc/);

    // Вторичный разбор (?more=) сериализуется; дефолт «Форматы» URL не засоряет.
    await expect(page).not.toHaveURL(/more=/);
    await page.getByRole('tab', { name: 'Хэштеги' }).click();
    await expect(page).toHaveURL(/more=hashtags/);

    // Полный deep-link воспроизводит состояние после reload.
    await page.goto('/instagram/content?q=launch&format=video&sort=views&order=asc&more=reels');
    await expect(page.getByLabel('Поиск по публикациям')).toHaveValue('launch');
    await expect(page.getByTestId('ig-format-filter')).toHaveAttribute('data-value', 'video');
    await expect(rows).toHaveCount(1);
    await expect(page.getByRole('tab', { name: 'Reels' })).toHaveAttribute('aria-selected', 'true');

    // CSV follows the same search/format/sort row set and does not dump every loaded post.
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Экспорт показанных публикаций в CSV' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^instagram-content-igacct-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/u);
    const downloadPath = await download.path();
    if (!downloadPath) throw new Error('Instagram content CSV has no local download path');
    const csv = await readFile(downloadPath, 'utf8');
    expect(csv).toContain('launch beta clip');
    expect(csv).not.toContain('launch alpha');
    expect(csv).not.toContain('reel drop');
  });

  test('shadcn-карточка публикаций: оболочка, вложенный overflow, hooks выбора/открытия', async ({ page }, testInfo) => {
    await boot(page);
    await page.goto('/instagram/content');

    // Самодостаточная карточка-оболочка с шапкой (табы/экспорт) и таблицей внутри.
    const card = page.locator('[data-ig-content-publications]');
    await expect(card).toBeVisible();
    await expect(card.getByRole('button', { name: 'Экспорт показанных публикаций в CSV' })).toBeVisible();
    const table = page.locator('[data-ig-content-table]');
    await expect(card.locator('[data-ig-content-table]')).toHaveCount(1);
    const rows = page.locator('[data-ig-content-row]');
    await expect(rows).toHaveCount(6);
    // Устойчивая иерархия строки: миниатюра + постоянный бейдж формата.
    await expect(rows.first().locator('[data-ig-content-format]')).toBeVisible();

    // Выбор помечает строку (data-hook), но НЕ открывает детальную модалку.
    await rows.first().getByTestId('ig-post-select').click();
    await expect(rows.first()).toHaveAttribute('data-ig-content-selected', '');
    await expect(page.getByRole('dialog', { name: 'Детали публикации' })).toHaveCount(0);

    // Горизонтальный overflow таблицы живёт ВНУТРИ карточки на узком десктопе; страница не едет вбок.
    await page.setViewportSize({ width: 820, height: 900 });
    const contained = await table.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(contained).toBeTruthy();
    const noPageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    );
    expect(noPageOverflow).toBeTruthy();
    await testInfo.attach('ig-content-card-midwidth', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

    // Открытое состояние строки помечается data-hook и раскрывает СОСЕДНИЙ Astryx-инспектор
    // (не модалку). Полная модалка остаётся явным действием из инспектора.
    await rows.first().locator('[data-ig-content-open-trigger]').click();
    await expect(rows.first()).toHaveAttribute('data-ig-content-open', '');
    await expect(page.locator('[data-ig-content-inspector-open]')).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Детали публикации' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Открыть подробнее' }).click();
    await expect(page.getByRole('dialog', { name: 'Детали публикации' })).toBeVisible();
  });

  test('строка раскрывает соседний инспектор; полная модалка — явным действием', async ({ page }, testInfo) => {
    await boot(page);
    await page.goto('/instagram/content');
    await page.locator('table tbody tr').first().locator('[data-ig-content-open-trigger]').click();
    const inspector = page.locator('[data-ig-content-inspector-open]');
    await expect(inspector).toBeVisible();
    await expect(inspector.getByText('Взаимодействия')).toBeVisible();
    await testInfo.attach('ig-content-inspector-dark-desktop', { body: await page.screenshot({ fullPage: true }), contentType: 'image/png' });

    // «Открыть подробнее» поднимает полную модалку поверх инспектора.
    await page.getByRole('button', { name: 'Открыть подробнее' }).click();
    const detail = page.getByRole('dialog', { name: 'Детали публикации' });
    await expect(detail).toBeVisible();
    await expect(detail.getByText('Взаимодействия')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();
    // Инспектор остаётся раскрытым после закрытия модалки.
    await expect(inspector).toBeVisible();
  });

  test('shadcn-таблица: фиксированная плотность, спокойная поверхность и видимость колонок', async ({ page }, testInfo) => {
    await boot(page);
    await page.goto('/instagram/content');
    const card = page.locator('[data-ig-content-publications]');
    const tableShell = page.locator('[data-ig-content-table]');
    const table = page.locator('[data-ig-content-table] table');
    const firstRow = table.locator('tbody tr').first();

    await expect(firstRow).toBeVisible();

    // Поясняющей полосы нет; массовые действия появляются только после реального выбора.
    await expect(page.getByText('Отметьте публикации, чтобы добавить их в кампанию')).toHaveCount(0);
    const addToCampaign = page.getByTestId('add-to-campaign');
    await expect(addToCampaign).toHaveCount(0);
    await firstRow.getByTestId('ig-post-select').click();
    await expect(addToCampaign).toBeVisible();
    await firstRow.getByTestId('ig-post-select').click();
    await expect(addToCampaign).toHaveCount(0);

    // Локальный search input повторяет более мягкую геометрию shadcn, не меняя другие экраны.
    const search = page.getByRole('searchbox', { name: 'Поиск по публикациям' });
    const searchRadius = await search.evaluate((node) => Number.parseFloat(getComputedStyle(node).borderRadius));
    expect(searchRadius).toBeGreaterThanOrEqual(8);

    // В таблице нет вложенного вертикального скролла: страницу прокручивает только dashboard shell.
    await expect.poll(() => tableShell.evaluate((node) => getComputedStyle(node).overflowY)).toBe('hidden');

    // Плотность фиксирована: пользовательского переключателя и технического атрибута больше нет.
    await expect(page.getByRole('radiogroup', { name: 'Плотность строк' })).toHaveCount(0);
    await expect(table).not.toHaveAttribute('data-density', /.+/);

    // Карточка и вложенная таблица используют один почти чёрный background; граница создаёт
    // иерархию без отдельной серой подложки. Неотмеченный checkbox остаётся полупрозрачным.
    const [cardBackground, tableBackground, tableBorderRadius, checkboxBackground] = await Promise.all([
      card.evaluate((node) => getComputedStyle(node).backgroundColor),
      tableShell.evaluate((node) => getComputedStyle(node).backgroundColor),
      tableShell.evaluate((node) => getComputedStyle(node).borderRadius),
      firstRow.getByTestId('ig-post-select').evaluate((node) => getComputedStyle(node).backgroundColor),
    ]);
    expect(tableBackground).toBe(cardBackground);
    expect(tableBorderRadius).not.toBe('0px');
    expect(checkboxBackground).not.toBe('rgb(0, 0, 0)');
    await testInfo.attach('ig-content-shadcn-table', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });

    // Видимость колонок — shadcn DropdownMenu. «Просмотры» видна по умолчанию, скрываем её.
    const columns = page.getByRole('button', { name: 'Колонки' });
    await expect(columns).toBeVisible();
    await expect(page.getByRole('columnheader', { name: /Просмотры/ })).toBeVisible();
    await columns.click();
    await page.getByRole('menuitemcheckbox', { name: 'Просмотры' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('columnheader', { name: /Просмотры/ })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: /Дата/ })).toBeVisible();
    // Скрытие колонки не меняет число строк.
    await expect(page.locator('table tbody tr')).toHaveCount(6);
  });

  test('активный фильтр кампании позволяет убрать membership из таблицы (пост не удаляется)', async ({ page }) => {
    await boot(page, ['p1', 'p2']);
    await page.goto('/instagram/content?campaign=1');
    const rows = page.locator('table tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(page.getByText(/2 из 2 публ\. кампании/)).toBeVisible();

    await page.getByLabel('Выбрать все видимые публикации').check();
    await expect(page.getByText('Выбрано: 2')).toBeVisible();
    await page.getByTestId('remove-from-campaign').click();

    // Membership'ы ушли → пустое честное состояние; публикации целы (снятие ?campaign= вернёт все).
    await expect(page.getByTestId('ig-content-empty')).toBeVisible();
    await selectPill(page.getByTestId('campaign-filter'), { label: 'Все' });
    await expect(page).not.toHaveURL(/campaign=/);
    await expect(rows).toHaveCount(6);
  });
});
