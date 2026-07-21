import { expect, test, type Page } from '@playwright/test';
import { selectPill } from './helpers';

/**
 * Кампании — desktop-сценарий целиком:
 * создать кампанию → выбрать посты галочками → добавить → открыть кампанию →
 * проверить сводку → отфильтровать «Контент» по кампании → убрать membership →
 * архивировать кампанию.
 *
 * Демо-режим здесь НЕ используется: client.ts блокирует в нём все записи, поэтому
 * поднимаем «авторизованную» сессию (pulse_token) и мокируем ВЕСЬ /api/* одним
 * stateful-роутом — кампании живут в замыкании теста, как настоящая БД.
 */

const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

const TG_POSTS = [
  { id: 101, date: iso(4 * DAY), views: 1000, reactions: 10, forwards: 5, replies: 2, media_type: 'photo', caption: 'Запуск: пост 1' },
  { id: 102, date: iso(3 * DAY), views: 2000, reactions: 20, forwards: 8, replies: 3, media_type: 'video', caption: 'Запуск: пост 2' },
  { id: 103, date: iso(2 * DAY), views: 6000, reactions: 60, forwards: 20, replies: 9, media_type: 'photo', caption: 'Обычный пост вне кампании' },
];

interface MockMembership {
  network: string;
  channel_id: number;
  post_ref: string;
  published_at: string | null;
  media_type: string | null;
  caption: string | null;
  added_at: string;
}
interface MockCampaign {
  id: number;
  name: string;
  description: string;
  color: string | null;
  status: string;
  start_date: string | null;
  end_date: string | null;
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

async function bootCampaigns(page: Page) {
  const campaigns: MockCampaign[] = [];
  const memberships = new Map<number, MockMembership[]>();
  let nextId = 1;

  const campaignRow = (c: MockCampaign) => ({
    ...c,
    workspace_id: 1,
    created_by: 11,
    created_at: iso(DAY),
    updated_at: new Date().toISOString(),
    my_role: 'owner',
    post_count: (memberships.get(c.id) ?? []).length,
  });
  const enrich = (m: MockMembership) => {
    const post = TG_POSTS.find((p) => String(p.id) === m.post_ref);
    return {
      ...m,
      channel_title: 'Тестовый канал',
      channel_username: 'testchan',
      accessible: true,
      tg_views: post?.views ?? null,
      tg_reactions: post?.reactions ?? null,
      tg_forwards: post?.forwards ?? null,
      tg_replies: post?.replies ?? null,
      ig_reach: null, ig_views: null, ig_likes: null, ig_comments: null, ig_saved: null, ig_shares: null,
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
        channels: [{ id: 1, username: 'testchan', title: 'Тестовый канал', status: 'active', source: 'collector', ig_connected: false }],
        selected: 1,
      });
    }
    if (path === '/api/tg/full') {
      return json(200, {
        channel: { title: 'Тестовый канал', username: 'testchan', memberCount: 1200 },
        views_summary: null,
        posts: TG_POSTS,
        mtproto_available: true,
        source: 'db',
      });
    }
    if (path === '/api/tg/mtproto/graphs') return json(200, {});
    if (path === '/api/prefs') return json(200, method === 'GET' ? {} : { ok: true });

    // ── Кампании: stateful CRUD ──
    if (path === '/api/campaigns' && method === 'GET') return json(200, { campaigns: campaigns.map(campaignRow) });
    if (path === '/api/campaigns' && method === 'POST') {
      const body = req.postDataJSON() as Partial<MockCampaign> & { name: string };
      if (campaigns.some((c) => c.name.toLowerCase() === body.name.toLowerCase())) {
        return json(409, { error: 'Кампания с таким названием уже есть' });
      }
      const c: MockCampaign = {
        id: nextId++,
        name: body.name,
        description: body.description ?? '',
        color: body.color ?? null,
        status: body.status ?? 'active',
        start_date: body.start_date ?? null,
        end_date: body.end_date ?? null,
      };
      campaigns.push(c);
      memberships.set(c.id, []);
      return json(200, { campaign: campaignRow(c) });
    }

    const m = path.match(/^\/api\/campaigns\/(\d+)(\/posts|\/summary)?$/);
    if (m) {
      const id = Number(m[1]);
      const campaign = campaigns.find((c) => c.id === id);
      if (!campaign) return json(404, { error: 'Кампания не найдена' });
      const rows = memberships.get(id) ?? [];

      if (m[2] === '/posts' && method === 'GET') return json(200, { posts: rows.map(enrich), inaccessible_count: 0 });
      if (m[2] === '/posts' && method === 'POST') {
        const items = (req.postDataJSON() as { items: MockMembership[] }).items;
        let added = 0;
        for (const it of items) {
          if (rows.some((r) => r.network === it.network && r.channel_id === it.channel_id && r.post_ref === it.post_ref)) continue;
          const post = TG_POSTS.find((p) => String(p.id) === it.post_ref);
          rows.push({
            network: it.network, channel_id: it.channel_id, post_ref: it.post_ref,
            published_at: post?.date ?? null, media_type: post?.media_type ?? null,
            caption: post?.caption ?? null, added_at: new Date().toISOString(),
          });
          added += 1;
        }
        return json(200, { added, skipped: items.length - added, invalid: [] });
      }
      if (m[2] === '/posts' && method === 'DELETE') {
        const items = (req.postDataJSON() as { items: MockMembership[] }).items;
        const before = rows.length;
        const keep = rows.filter(
          (r) => !items.some((it) => it.network === r.network && it.channel_id === r.channel_id && it.post_ref === r.post_ref),
        );
        memberships.set(id, keep);
        return json(200, { removed: before - keep.length });
      }
      if (m[2] === '/summary') {
        const enriched = rows.map(enrich);
        const views = enriched.map((r) => r.tg_views).filter((v): v is number => v != null);
        const med = median(views);
        const scored = enriched
          .filter((r) => r.tg_views != null)
          .map((r) => ({ network: 'tg', channel_id: 1, post_ref: r.post_ref, caption: r.caption, published_at: r.published_at, value: r.tg_views!, ratio: med ? Math.round((r.tg_views! / med) * 10) / 10 : null }))
          .sort((a, b) => b.value - a.value);
        const days = new Map<string, { day: string; posts: number; tg_views: number }>();
        for (const r of enriched) {
          if (!r.published_at) continue;
          const day = r.published_at.slice(0, 10);
          const t = days.get(day) ?? { day, posts: 0, tg_views: 0 };
          t.posts += 1;
          t.tg_views += r.tg_views ?? 0;
          days.set(day, t);
        }
        return json(200, {
          summary: {
            campaign: campaignRow(campaign),
            posts_total: rows.length,
            inaccessible_posts: 0,
            undated_posts: 0,
            period: { from: campaign.start_date, to: campaign.end_date },
            tg: {
              posts: rows.length,
              views: views.reduce((a, b) => a + b, 0),
              avg: views.length ? Math.round(views.reduce((a, b) => a + b, 0) / views.length) : null,
              median: med, reactions: 30, forwards: 13, replies: 5,
              best: scored[0] ?? null,
              worst: scored.length > 1 ? scored[scored.length - 1] : null,
            },
            ig: { posts: 0 },
            by_source: rows.length
              ? [{ network: 'tg', channel_id: 1, title: 'Тестовый канал', username: 'testchan', posts: rows.length, tg_views: views.reduce((a, b) => a + b, 0) }]
              : [],
            by_format: rows.length ? [{ network: 'tg', media_type: 'photo', posts: rows.length, tg_views: views.reduce((a, b) => a + b, 0) }] : [],
            timeline: [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
            comparison: { available: false, reason: 'insufficient_data' },
          },
        });
      }
      if (method === 'GET') return json(200, { campaign: campaignRow(campaign) });
      if (method === 'PATCH') {
        Object.assign(campaign, req.postDataJSON() as Partial<MockCampaign>);
        return json(200, { campaign: campaignRow(campaign) });
      }
      if (method === 'DELETE') {
        campaigns.splice(campaigns.indexOf(campaign), 1);
        memberships.delete(id);
        return json(200, { ok: true });
      }
    }

    return json(404, { error: 'not_mocked' });
  });

  await page.addInitScript(() => {
    localStorage.setItem('pulse_token', 'e2e-token');
    localStorage.setItem('pulse_token_exp', String(Date.now() + 60 * 60 * 1000));
    localStorage.setItem('pulse_channel', '1');
    localStorage.setItem('pulse_theme', 'dark');
  });

  await page.goto('/posts');
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
}

test.describe('Кампании (desktop)', () => {
  test('создание → выбор постов → добавление → сводка → фильтр контента → удаление membership → архив', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-сценарий (bulk-таблица скрыта на мобильном)');
    await bootCampaigns(page);

    // ── Вкладка «Кампании»: рабочий список, empty state, создание через диалог ──
    await page.getByRole('tab', { name: 'Кампании' }).click();
    await expect(page.getByText('Кампаний пока нет')).toBeVisible();
    await page.getByRole('button', { name: 'Новая кампания' }).click();
    await page.getByPlaceholder('Запуск продукта').fill('Запуск продукта');
    await page.getByRole('button', { name: 'Создать' }).click();

    // Создание ведёт на страницу кампании (пока пустую).
    await expect(page.getByTestId('campaign-name')).toHaveText('Запуск продукта');
    await expect(page.getByText('В кампании пока нет публикаций')).toBeVisible();

    // ── Bulk-выбор публикаций в «Контенте» и добавление в кампанию ──
    await page.getByRole('link', { name: /К списку публикаций/ }).click();
    await expect(page.getByRole('tab', { name: 'Публикации' })).toBeVisible();
    const checkboxes = page.getByTestId('post-select');
    await expect(checkboxes).toHaveCount(3);
    await checkboxes.nth(0).check();
    await checkboxes.nth(1).check();
    await expect(page.getByText('Выбрано: 2')).toBeVisible();
    await page.getByTestId('add-to-campaign').click();
    await page.getByRole('button', { name: 'Добавить', exact: true }).click();
    await expect(page.getByTestId('add-to-campaign-result')).toContainText('Добавлено: 2');
    await page.getByRole('button', { name: 'Готово' }).click();

    // Идемпотентность видна пользователю: повторное добавление того же поста → «уже были».
    await checkboxes.nth(0).check();
    await page.getByTestId('add-to-campaign').click();
    await page.getByRole('button', { name: 'Добавить', exact: true }).click();
    await expect(page.getByTestId('add-to-campaign-result')).toContainText('Уже были в кампании: 1');
    await page.getByRole('button', { name: 'Готово' }).click();

    // ── Страница кампании: сводка, платформенные KPI, таблица публикаций ──
    await page.getByRole('tab', { name: 'Кампании' }).click();
    const row = page.getByTestId('campaigns-table').getByRole('row').filter({ hasText: 'Запуск продукта' });
    await expect(row).toContainText('2'); // post_count
    await row.click();
    await expect(page.getByTestId('campaign-name')).toHaveText('Запуск продукта');
    await expect(page.getByText('Публикации TG')).toBeVisible();
    await expect(page.getByTestId('campaign-posts-table').locator('tbody tr')).toHaveCount(2);
    // Честный insufficient-state сравнения, а не пустое место.
    await expect(page.getByTestId('campaign-comparison')).toContainText('недоступно');

    // Точный source slice живёт в URL и использует пару network+channel_id.
    const sourceFilter = page.getByTestId('campaign-source-filter');
    await expect(sourceFilter).toBeVisible();
    await sourceFilter.focus();
    await page.keyboard.press('Enter');
    await expect(sourceFilter).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByRole('listbox', { name: 'Фильтр по источнику кампании' })).toBeVisible();
    const selectShot = testInfo.outputPath('campaign-pill-select-dark.png');
    await page.screenshot({ path: selectShot, fullPage: true });
    await testInfo.attach('campaign-pill-select-dark', { path: selectShot, contentType: 'image/png' });
    await page.keyboard.press('ArrowDown');
    // Radix moves the active option in a deferred callback. Wait for that focus transfer before
    // confirming, otherwise Enter can race the callback and re-select «Все источники».
    await expect(page.locator('[role="option"][data-value="tg:1"]')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(sourceFilter).toHaveAttribute('data-value', 'tg:1');
    await expect(page).toHaveURL(/source=tg%3A1/);
    await expect(page.getByTestId('campaign-posts-table').locator('tbody tr')).toHaveCount(2);
    await selectPill(sourceFilter, { value: '' });
    await expect(page).not.toHaveURL(/source=/);
    await sourceFilter.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(sourceFilter).toHaveAttribute('aria-expanded', 'false');
    await expect(sourceFilter).toBeFocused();

    // ── Фильтр «Контента» по кампании (канонический ?campaign= в URL) ──
    await page.getByRole('link', { name: 'Контент' }).first().click();
    await selectPill(page.getByTestId('campaign-filter'), { label: 'Запуск продукта' });
    await expect(page).toHaveURL(/campaign=\d+/);
    await expect(page.getByText(/2 из 2 публ\. кампании/)).toBeVisible();
    const tableRows = page.locator('table tbody tr');
    await expect(tableRows).toHaveCount(2);
    // Дефолтная сортировка — просмотры DESC, чекбоксы nth(0)/nth(1) выбрали посты 103 и 102;
    // за бортом кампании остался 101 — его и не должно быть в отфильтрованном списке.
    await expect(page.getByText('Запуск: пост 1', { exact: true })).toHaveCount(0);
    // Сброс фильтра возвращает полный список.
    await selectPill(page.getByTestId('campaign-filter'), { label: 'Все' });
    await expect(tableRows).toHaveCount(3);

    // Та же каноническая scope в «Аналитика → Форматы»: виджеты считаются только
    // по membership текущего TG-источника. Два выбранных поста дают 80 реакций, 28 репостов и 12 комментариев.
    await page.getByRole('link', { name: 'Аналитика' }).first().click();
    await page.getByRole('tab', { name: 'Форматы' }).click();
    await selectPill(page.getByTestId('campaign-filter'), { label: 'Запуск продукта' });
    await expect(page).toHaveURL(/tab=content.*campaign=\d+|campaign=\d+.*tab=content/);
    await expect(page.getByTestId('analytics-campaign-scope')).toContainText('публикации кампании из этого источника');
    const composition = page.getByRole('heading', { name: 'Состав вовлечённости' }).locator('xpath=ancestor::section[1]');
    await expect(composition).toContainText('Реакции');
    await expect(composition).toContainText('80');
    await expect(composition).toContainText('Репосты');
    await expect(composition).toContainText('28');
    await expect(composition).toContainText('Комментарии');
    await expect(composition).toContainText('12');

    // ── Удаление membership со страницы кампании (публикации не удаляются) ──
    await page.getByRole('link', { name: 'Контент' }).first().click();
    await page.getByRole('tab', { name: 'Кампании' }).click();
    await page.getByTestId('campaigns-table').getByRole('row').filter({ hasText: 'Запуск продукта' }).click();
    // Приложение убирает строку НЕ оптимистично: DELETE → invalidate → фоновый рефетч → рендер.
    // Один toHaveCount(1) на весь этот конвейер флакует под полной параллельной нагрузкой, поэтому
    // ждём детерминированно: сортировка date DESC ставит пост 103 первым — убираем именно его,
    // дожидаемся ответа мутации, затем исчезновения самой строки, и только потом меряем счётчик.
    const postsRows = page.getByTestId('campaign-posts-table').locator('tbody tr');
    const removedRow = postsRows.filter({ hasText: 'Обычный пост вне кампании' });
    await expect(removedRow).toHaveCount(1);
    const removeDone = page.waitForResponse(
      (r) => r.request().method() === 'DELETE' && /\/api\/campaigns\/\d+\/posts$/.test(new URL(r.url()).pathname),
    );
    await removedRow.getByRole('button', { name: 'Убрать' }).click();
    // Подтверждение теперь канонный alert-dialog (был window.confirm → page.on('dialog')).
    await page.getByRole('alertdialog').getByRole('button', { name: 'Убрать' }).click();
    await removeDone;
    await expect(removedRow).toHaveCount(0);
    await expect(postsRows).toHaveCount(1);

    // ── Архивация ──
    await page.getByTestId('campaign-archive-toggle').click();
    await expect(page.getByText('В архиве')).toBeVisible();

    // Публикации целы: в «Контенте» по-прежнему все 3 поста.
    await page.getByRole('link', { name: 'Контент' }).first().click();
    await expect(page.locator('table tbody tr')).toHaveCount(3);
  });
});
