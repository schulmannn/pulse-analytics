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

    // The Telegram «Показатели» composite splits into five source-honest cards (desktop); ig-reach
    // stays one IG card. Every widget still keeps its own platform/channel identity.
    const identities = page.locator('[data-source-identity]');
    await expect(identities).toHaveCount(6);
    await expect(identities.filter({ hasText: 'Telegram · @demo_channel' })).toHaveCount(5);
    await expect(identities.filter({ hasText: 'Instagram · @demo_channel' })).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Показатели', exact: true })).toHaveCount(0);

    // Config-driven Home cards use the same story anatomy as Overview: the half-width views card
    // has its KPI on the left and an axis-free area sparkline on the right. The old generic renderer
    // stacked a full report chart (with x/y axes) below the number, which made Home look unrelated.
    const viewsCard = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Просмотры', exact: true }),
    });
    await expect(viewsCard).toHaveCount(1);
    await expect(viewsCard.locator('[data-widget-story-card]')).toBeVisible();
    await expect(viewsCard.locator('svg[data-chart-kind="sparkline"]')).toBeVisible();
    await expect(viewsCard.locator('svg[data-chart-kind="line"]')).toHaveCount(0);
    const storyGeometry = await viewsCard.locator('[data-chart-card-body]').evaluate((body) => {
      const headline = body.querySelector('[data-chart-card-headline]');
      const plot = body.querySelector('[data-chart-card-plot]');
      if (!headline || !plot) return null;
      const headlineRect = headline.getBoundingClientRect();
      const plotRect = plot.getBoundingClientRect();
      return {
        plotAfterHeadline: plotRect.left >= headlineRect.right,
        plotWidth: plotRect.width,
        headlineWidth: headlineRect.width,
      };
    });
    expect(storyGeometry).not.toBeNull();
    expect(storyGeometry!.plotAfterHeadline).toBe(true);
    expect(storyGeometry!.plotWidth).toBeGreaterThan(storyGeometry!.headlineWidth);

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

  test('edit mode: board steps inward (calm desktop motion), dock, no nested page-card, no grey divider', async ({ page }, testInfo) => {
    await seedBoard(page);
    await bootDemo(page, '/home', { theme: 'dark' });

    const board = page.locator('.home-board-canvas');
    const sidebar = page.getByRole('complementary', { name: 'Боковая панель' });
    await board.waitFor({ state: 'visible', timeout: 15_000 });
    const restWidth = (await board.boundingBox())!.width;
    const sidebarWidth = (await sidebar.boundingBox())!.width;

    // The narrowing is a real max-width transition (animation contract locked by the computed
    // property, not by a sleep) — не мгновенный перескок ширины.
    const transition = await board.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { prop: cs.transitionProperty, dur: cs.transitionDuration };
    });
    expect(transition.prop).toContain('max-width');
    expect(transition.dur).not.toBe('0s');

    const edit = page.locator('button.edit-toggle');
    await edit.click();
    await expect(edit).toHaveAttribute('aria-pressed', 'true');
    // The mode is announced to assistive tech via an sr-only status — no visible «Редактирование»
    // row / border-b divider between the top cards anymore (владелец: серая линия лишняя).
    await expect(page.getByText('Редактирование', { exact: true })).toHaveCount(0);
    await expect(page.locator('.home-board-canvas p[role="status"]')).toHaveText('Режим редактирования доски');
    await expect(page.locator('.add-widget-trigger')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Добавить виджет', exact: true })).toHaveCount(0);

    // The whole grid steps calmly inward ~52px per side (≈104px total) — a noticeable, quiet move.
    await expect.poll(async () => Math.round(restWidth - (await board.boundingBox())!.width)).toBeGreaterThanOrEqual(90);
    const editWidth = (await board.boundingBox())!.width;
    expect(restWidth - editWidth).toBeLessThanOrEqual(120);
    // The sidebar never moves; the board stays centred (no decorative frame around it).
    expect(Math.abs((await sidebar.boundingBox())!.width - sidebarWidth)).toBeLessThanOrEqual(1);
    await expect(page.locator('[data-source-identity]')).toHaveCount(6);
    const hScroll = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(hScroll).toBeLessThanOrEqual(1);

    const shot = testInfo.outputPath('home-edit-dark.png');
    await page.screenshot({ path: shot, fullPage: true });
    await testInfo.attach('home-edit-dark', { path: shot, contentType: 'image/png' });

    // «Готово» reverts the grid exactly to its resting width (interruptible, symmetric).
    await edit.click();
    await expect(edit).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(async () => Math.round(Math.abs((await board.boundingBox())!.width - restWidth))).toBeLessThanOrEqual(1);
  });

  test('edit mode narrowing is instant under reduced motion (no width tween)', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await seedBoard(page);
    await bootDemo(page, '/home', { theme: 'dark' });

    const board = page.locator('.home-board-canvas');
    await board.waitFor({ state: 'visible', timeout: 15_000 });
    // The global reduced-motion cap collapses the transition duration to ~0 — the endpoint (inward
    // step) still applies, just without the tween.
    const dur = await board.evaluate((el) => getComputedStyle(el).transitionDuration);
    expect(parseFloat(dur), `reduced-motion transition was ${dur}`).toBeLessThanOrEqual(0.001);

    const restWidth = (await board.boundingBox())!.width;
    await page.locator('button.edit-toggle').click();
    await expect(page.locator('button.edit-toggle')).toHaveAttribute('aria-pressed', 'true');
    // Narrows immediately (no need to wait out a tween) and by the same amount.
    const editWidth = (await board.boundingBox())!.width;
    expect(restWidth - editWidth).toBeGreaterThanOrEqual(90);
    expect(restWidth - editWidth).toBeLessThanOrEqual(120);
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
    // A fresh desktop board seeds the split KPI cards, not the legacy composite: the five split keys
    // lead the board (no `kpi` token), and the availability-aware IG widget is still included.
    expect(keys[0]).toBe('custom:home-kpi-tg-views');
    expect(keys.filter((k) => k === 'kpi')).toHaveLength(0);
    expect(keys.some((k) => k.startsWith('ig-'))).toBe(true);
    await expect(page.getByRole('heading', { name: 'Показатели', exact: true })).toHaveCount(0);

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
