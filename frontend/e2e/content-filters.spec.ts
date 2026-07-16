import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { selectPill } from './helpers';

/**
 * Контент (desktop) — URL-воспроизводимые фильтры + bulk-remove из кампании.
 *
 * Проверяет вертикаль lib/contentFilters end-to-end через настоящий UI: период/поиск/формат/
 * сортировка сериализуются в URL, композируются с ?campaign=, переживают reload, а активный фильтр
 * кампании позволяет убрать membership прямо из таблицы (пост при этом не удаляется). Стейт живёт в
 * замыкании мока, как настоящая БД (тот же приём, что e2e/campaigns.spec.ts).
 */

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const TG_POSTS = [
  { id: 101, date: iso(2 * DAY), views: 1000, reactions: 10, forwards: 5, replies: 2, media_type: 'photo', caption: 'launch alpha' },
  { id: 102, date: iso(3 * DAY), views: 3000, reactions: 30, forwards: 12, replies: 4, media_type: 'video', caption: 'launch beta' },
  { id: 103, date: iso(4 * DAY), views: 2000, reactions: 20, forwards: 8, replies: 3, media_type: 'photo', album_size: 3, caption: 'gallery carousel' },
  { id: 104, date: iso(5 * DAY), views: 500, reactions: 5, forwards: 1, replies: 0, media_type: null, caption: 'plain note' },
  { id: 105, date: iso(40 * DAY), views: 4000, reactions: 40, forwards: 20, replies: 8, media_type: 'photo', caption: 'old post' },
];

async function boot(page: Page, seedCampaignMembers: number[] = []) {
  // Одна кампания, пред-заполненная membership'ами (для сценария bulk-remove).
  const memberships = new Set(seedCampaignMembers.map(String));
  const campaignRow = () => ({
    id: 1, workspace_id: 1, name: 'Запуск', description: '', color: null, status: 'active',
    start_date: null, end_date: null, created_by: 11, created_at: iso(DAY), updated_at: iso(0),
    my_role: 'owner', post_count: memberships.size,
  });
  const enrich = (ref: string) => {
    const p = TG_POSTS.find((x) => String(x.id) === ref);
    return {
      network: 'tg', channel_id: 1, post_ref: ref, published_at: p?.date ?? null,
      media_type: p?.media_type ?? null, caption: p?.caption ?? null, added_at: iso(0),
      channel_title: 'Тестовый канал', channel_username: 'testchan', accessible: true,
      tg_views: p?.views ?? null, tg_reactions: p?.reactions ?? null, tg_forwards: p?.forwards ?? null, tg_replies: p?.replies ?? null,
      ig_reach: null, ig_views: null, ig_likes: null, ig_comments: null, ig_saved: null, ig_shares: null,
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
        channels: [{ id: 1, username: 'testchan', title: 'Тестовый канал', status: 'active', source: 'collector', ig_connected: false }],
        selected: 1,
      });
    }
    if (path === '/api/tg/full') {
      return json(200, {
        channel: { title: 'Тестовый канал', username: 'testchan', memberCount: 1200 },
        views_summary: null, posts: TG_POSTS, mtproto_available: true, source: 'db',
      });
    }
    if (path === '/api/tg/mtproto/graphs') return json(200, {});
    if (path.startsWith('/api/tg/mtproto/post_stats/')) {
      const now = Date.now();
      return json(200, {
        available: true,
        views_graph: {
          x: [now - 72 * 3_600_000, now - 48 * 3_600_000, now - 24 * 3_600_000, now],
          series: [{ name: 'Просмотры', values: [420, 1_260, 2_240, 3_000] }],
        },
      });
    }
    if (path === '/api/prefs') return json(200, method === 'GET' ? {} : { ok: true });
    if (path === '/api/campaigns' && method === 'GET') return json(200, { campaigns: [campaignRow()] });
    if (path === '/api/campaigns/1/posts' && method === 'GET') {
      return json(200, { posts: [...memberships].map(enrich), inaccessible_count: 0 });
    }
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

test.describe('Контент — URL-фильтры (desktop)', () => {
  test.beforeEach(({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-таблица и её фильтры скрыты на мобильном');
  });

  test('период/поиск/формат/сортировка сериализуются в URL, композируются и переживают reload', async ({ page }, testInfo) => {
    await boot(page);
    await page.goto('/posts');
    const rows = page.locator('table tbody tr');
    await expect(rows).toHaveCount(4); // дефолт 30д исключает пост 40-дневной давности
    await testInfo.attach('content-dark-desktop', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    await rows.first().getByRole('button').click();
    const detail = page.getByRole('dialog', { name: 'Детали поста' });
    await expect(detail).toBeVisible();
    await testInfo.attach('content-post-detail-dark-desktop', {
      body: await page.screenshot({ fullPage: true }),
      contentType: 'image/png',
    });
    await detail.getByRole('button', { name: 'Закрыть' }).click();

    // Чистый дефолт не засоряет URL.
    await expect(page).not.toHaveURL(/period=|[?&]q=|format=|sort=|order=/);

    // Период → ?period=all показывает и старый пост; ?period= пишется в URL.
    await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: 'Всё' }).click();
    await expect(page).toHaveURL(/period=all/);
    await expect(rows).toHaveCount(5);
    await page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '30д' }).click();
    await expect(page).not.toHaveURL(/period=/); // дефолт снова чистый

    // Поиск → ?q=, регистронезависимо по подписи.
    await page.getByLabel('Поиск по публикациям').fill('launch');
    await expect(page).toHaveURL(/q=launch/);
    await expect(rows).toHaveCount(2);

    // Controlled URL input must retain the space while a multi-word phrase is being entered.
    await page.getByLabel('Поиск по публикациям').fill('launch beta');
    await expect(page).toHaveURL(/q=launch(?:\+|%20)beta/);
    await expect(page.getByLabel('Поиск по публикациям')).toHaveValue('launch beta');
    await expect(rows).toHaveCount(1);
    await page.getByLabel('Поиск по публикациям').fill('nothing matches');
    await expect(page.getByText('Ничего не найдено по выбранным фильтрам.')).toBeVisible();
    await page.getByLabel('Поиск по публикациям').fill('launch');

    // Формат композируется с поиском (оба параметра в URL).
    await selectPill(page.getByTestId('format-filter'), { value: 'video' });
    await expect(page).toHaveURL(/q=launch/);
    await expect(page).toHaveURL(/format=video/);
    await expect(rows).toHaveCount(1);

    // Сброс формата, проверка альбома (album_size>1 — свой формат, не «фото»).
    await page.getByLabel('Поиск по публикациям').fill('');
    await selectPill(page.getByTestId('format-filter'), { value: 'album' });
    await expect(page).toHaveURL(/format=album/);
    await expect(rows).toHaveCount(1);
    await selectPill(page.getByTestId('format-filter'), { value: 'all' });
    await expect(page).not.toHaveURL(/format=/);

    // Сортировка по дате: первый клик — sort=date (order=desc это дефолт → в URL НЕ пишется),
    // повторный клик разворачивает в order=asc.
    await page.getByRole('button', { name: /Дата/ }).click();
    await expect(page).toHaveURL(/sort=date/);
    await expect(page).not.toHaveURL(/order=/);
    await page.getByRole('button', { name: /Дата/ }).click();
    await expect(page).toHaveURL(/order=asc/);

    // Полный deep-link воспроизводит состояние после reload.
    await page.goto('/posts?period=7&q=launch&format=video&sort=erv&order=asc');
    await expect(page.getByLabel('Поиск по публикациям')).toHaveValue('launch');
    await expect(page.getByTestId('format-filter')).toHaveAttribute('data-value', 'video');
    await expect(page.getByRole('group', { name: 'Период' }).getByRole('button', { name: '7д' })).toHaveAttribute('aria-pressed', 'true');
    await expect(rows).toHaveCount(1);

    // CSV is the exact current table result, not the broader pre-filter period scope.
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Экспорт показанных публикаций в CSV' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/^telegram-content-тестовый-канал-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/u);
    const downloadPath = await download.path();
    if (!downloadPath) throw new Error('Telegram content CSV has no local download path');
    const csv = await readFile(downloadPath, 'utf8');
    expect(csv).toContain('launch beta');
    expect(csv).not.toContain('launch alpha');
    expect(csv).not.toContain('old post');
  });

  test('активный фильтр кампании позволяет убрать membership из таблицы (пост не удаляется)', async ({ page }) => {
    await boot(page, [101, 102]);
    await page.goto('/posts?campaign=1');
    const rows = page.locator('table tbody tr');
    await expect(rows).toHaveCount(2); // только membership'ы кампании из этого источника
    await expect(page.getByText(/2 из 2 публ\. кампании/)).toBeVisible();

    // Выбрать все видимые → убрать из кампании.
    await page.getByLabel('Выбрать все видимые публикации').check();
    await expect(page.getByText('Выбрано: 2')).toBeVisible();
    await page.getByTestId('remove-from-campaign').click();

    // Membership'ы ушли → пустое честное состояние, но публикации целы (снятие ?campaign= вернёт все).
    await expect(page.getByText('В этой кампании нет публикаций из текущего источника')).toBeVisible();
    await selectPill(page.getByTestId('campaign-filter'), { label: 'Все' });
    await expect(page).not.toHaveURL(/campaign=/);
    await expect(rows).toHaveCount(4);
  });
});
