import { test, expect, type Page } from '@playwright/test';
import { bootDemo } from './helpers';

// A mixed TG + IG board so every card must show its own source identity; addInitScript stacks
// BEFORE bootDemo's own seed.
const seedBoard = (page: Page) =>
  page.addInitScript(() => {
    localStorage.setItem('pulse_home_blocks', JSON.stringify({ keys: ['kpi', 'ig-reach'] }));
  });
const seedEmpty = (page: Page) =>
  page.addInitScript(() => {
    localStorage.setItem('pulse_home_blocks', JSON.stringify({ keys: [] }));
  });

test.describe('desktop /home workspace (dark, 1440)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'desktop Home workspace');
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test('read board: stable header actions, source badges, no horizontal overflow', async ({ page }, testInfo) => {
    await seedBoard(page);
    await bootDemo(page, '/home', { theme: 'dark' });

    // Both first-screen commands are visible at rest — no need to hover to discover the edit tool.
    const add = page.getByRole('button', { name: 'Добавить виджет', exact: true });
    const edit = page.locator('button.edit-toggle');
    await expect(add).toBeVisible();
    await expect(edit).toBeVisible();
    await expect(edit).toHaveAttribute('aria-pressed', 'false');
    await expect(page.getByRole('button', { name: 'Добавить виджет', exact: true })).toHaveCount(1);

    // Every widget keeps its own platform/channel identity (TG + IG).
    const identities = page.locator('[data-source-identity]');
    await expect(identities).toHaveCount(2);
    await expect(identities.filter({ hasText: 'Telegram · @demo_channel' })).toHaveCount(1);
    await expect(identities.filter({ hasText: 'Instagram · @demo_channel' })).toHaveCount(1);

    const hScroll = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(hScroll).toBeLessThanOrEqual(1);

    const shot = testInfo.outputPath('home-read-dark.png');
    await page.screenshot({ path: shot, fullPage: true });
    await testInfo.attach('home-read-dark', { path: shot, contentType: 'image/png' });
  });

  test('header «Добавить виджет» opens the catalog directly, without entering edit mode', async ({ page }) => {
    await seedBoard(page);
    await bootDemo(page, '/home', { theme: 'dark' });

    const edit = page.locator('button.edit-toggle');
    const add = page.getByRole('button', { name: 'Добавить виджет', exact: true });
    await expect(edit).toHaveAttribute('aria-pressed', 'false');

    await add.click();
    await expect(page.getByRole('dialog', { name: 'Каталог метрик' })).toBeVisible();
    // The direct add path never flips the board into edit mode.
    await expect(edit).toHaveAttribute('aria-pressed', 'false');

    // Escape closes the catalog and restores focus to the opener (focus-trap contract).
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Каталог метрик' })).toHaveCount(0);
    await expect(add).toBeFocused();
  });

  test('edit mode: full-width board, reorder/remove hint + dock, no nested page-card', async ({ page }, testInfo) => {
    await seedBoard(page);
    await bootDemo(page, '/home', { theme: 'dark' });

    const board = page.locator('.home-board-canvas');
    const sidebar = page.getByRole('complementary', { name: 'Боковая панель' });
    await board.waitFor({ state: 'visible', timeout: 15_000 });
    const restWidth = (await board.boundingBox())!.width;
    const sidebarWidth = (await sidebar.boundingBox())!.width;

    const edit = page.locator('button.edit-toggle');
    await edit.click();
    await expect(edit).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText('Редактирование', { exact: true })).toBeVisible();
    await expect(page.locator('.add-widget-trigger')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Добавить виджет', exact: true })).toHaveCount(0);

    const editWidth = (await board.boundingBox())!.width;
    expect(Math.abs(editWidth - restWidth)).toBeLessThanOrEqual(1);
    expect(Math.abs((await sidebar.boundingBox())!.width - sidebarWidth)).toBeLessThanOrEqual(1);
    await expect(page.locator('[data-source-identity]')).toHaveCount(2);
    const hScroll = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(hScroll).toBeLessThanOrEqual(1);

    const shot = testInfo.outputPath('home-edit-dark.png');
    await page.screenshot({ path: shot, fullPage: true });
    await testInfo.attach('home-edit-dark', { path: shot, contentType: 'image/png' });
  });

  test('empty state: unframed surface, catalog CTA, availability-aware defaults', async ({ page }, testInfo) => {
    await seedEmpty(page);
    await bootDemo(page, '/home', { theme: 'dark' });

    await expect(page.getByRole('heading', { name: 'На Главной пока пусто' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Добавить виджет', exact: true })).toHaveCount(1);
    // Desktop empty state is NOT wrapped in a decorative bg-card — it's a plain working surface.
    await expect(page.locator('.bg-card.rounded-xl').filter({ hasText: 'На Главной пока пусто' })).toHaveCount(0);

    const shot = testInfo.outputPath('home-empty-dark.png');
    await page.screenshot({ path: shot, fullPage: true });
    await testInfo.attach('home-empty-dark', { path: shot, contentType: 'image/png' });

    // Primary CTA opens the catalog directly (both header + empty-state buttons share the name).
    await page.getByRole('button', { name: 'Добавить виджет', exact: true }).first().click();
    await expect(page.getByRole('dialog', { name: 'Каталог метрик' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Каталог метрик' })).toHaveCount(0);

    // «Собрать по умолчанию» seeds a board; the demo channel has a connected IG source, so a
    // relevant IG widget is included (the TG-only exclusion path is covered by the unit test).
    await page.getByRole('button', { name: 'Собрать по умолчанию' }).click();
    // The empty state gives way to a populated board.
    await expect(page.getByRole('heading', { name: 'На Главной пока пусто' })).toHaveCount(0);
    await expect(page.locator('.home-board-canvas [data-source-identity]').first()).toBeVisible();
    const keys = await page.evaluate(
      () => JSON.parse(localStorage.getItem('pulse_home_blocks') || '{}').keys as string[],
    );
    expect(keys[0]).toBe('kpi');
    expect(keys.some((k) => k.startsWith('ig-'))).toBe(true);

    const layout = await page.locator('.home-board-canvas section').evaluateAll((sections) =>
      sections.map((section) => {
        const rect = section.getBoundingClientRect();
        return {
          title: section.querySelector('h3')?.textContent?.trim() ?? '',
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
        };
      }),
    );
    const byTitle = (title: string) => layout.find((item) => item.title === title)!;
    const week = byTitle('Неделя канала');
    const growth = byTitle('Рост подписчиков');
    const instagram = byTitle('IG · Охват по дням');
    const topPosts = byTitle('Топ постов');
    expect(Math.abs(week.width - growth.width)).toBeLessThanOrEqual(2);
    expect(week.top).toBe(growth.top);
    expect(week.left).toBeLessThan(growth.left);
    expect(instagram.top).toBeLessThan(topPosts.top);
    expect(instagram.width).toBeGreaterThan(week.width * 1.8);

    await page.waitForTimeout(300);
    const defaultShot = testInfo.outputPath('home-default-dark.png');
    await page.screenshot({ path: defaultShot, fullPage: true });
    await testInfo.attach('home-default-dark', { path: defaultShot, contentType: 'image/png' });
  });

  test('empty-state Overview link keeps the selected network', async ({ page }) => {
    await seedEmpty(page);
    await page.addInitScript(() => localStorage.setItem('pulse_network', 'ig'));
    await bootDemo(page, '/home', { theme: 'dark' });

    await expect(page.getByRole('link', { name: 'Открыть Обзор' })).toHaveAttribute('href', '/instagram');
  });
});

test.describe('mobile /home invariant (430)', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'mobile-430', 'mobile Home invariant');
    await page.setViewportSize({ width: 430, height: 932 });
  });

  test('keeps the compact edit chip + framed empty card, no desktop toolbar', async ({ page }) => {
    await seedEmpty(page);
    await bootDemo(page, '/home');

    // The desktop-only header «Добавить виджет» is hidden < md — only the empty-card primary remains.
    await expect(page.getByRole('button', { name: 'Добавить виджет', exact: true })).toHaveCount(1);

    // The empty state stays the framed card (its verbatim mobile branch).
    const card = page.locator('.rounded-xl.border.bg-card').filter({ hasText: 'На Главной пока пусто' });
    await expect(card).toBeVisible();

    // The edit chip is still the compact icon control (narrower than its reserved slot).
    const slot = page.locator('.edit-toggle-slot');
    const toggle = page.locator('button.edit-toggle');
    const s = await slot.boundingBox();
    const t = await toggle.boundingBox();
    expect(s && t).toBeTruthy();
    expect(t!.width).toBeLessThan(s!.width - 40);

    const hScroll = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(hScroll).toBeLessThanOrEqual(1);

    // The postponed mobile surface also keeps its historical default composition.
    await page.getByRole('button', { name: 'Собрать по умолчанию' }).click();
    const keys = await page.evaluate(
      () => JSON.parse(localStorage.getItem('pulse_home_blocks') || '{}').keys as string[],
    );
    expect(keys).toEqual(['week', 'kpi', 'growth', 'ig-reach', 'top-posts']);
  });
});
