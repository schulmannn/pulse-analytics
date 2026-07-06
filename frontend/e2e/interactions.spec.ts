import { test, expect, type Page } from '@playwright/test';
import { bootDemo } from './helpers';

test('detail open + back (metric drilldown)', async ({ page }) => {
  await bootDemo(page, '/');
  // A drillable KPI hero exposes an aria-label «Разбор: …»; clicking it opens the metric detail page.
  const drill = page.getByRole('button', { name: /^Разбор:/ }).first();
  await drill.waitFor({ state: 'visible', timeout: 15_000 });
  await drill.click();
  await expect(page).toHaveURL(/\/metrics\//);
  // the detail page renders its own content (a card / heading)
  await page.locator('section h3, h1, h2').first().waitFor({ timeout: 10_000 });
  await page.goBack();
  await expect(page).not.toHaveURL(/\/metrics\//);
});

test('whole-card click opens the detail overlay', async ({ page }) => {
  await bootDemo(page, '/');
  // Click the card's own chrome (its title text — not a button/chart), which opens the detail overlay.
  await page.locator('section:has(h3)').first().locator('h3').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  // …and it closes on Escape, leaving the card intact.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('detail overlay is URL-stated and closes on browser Back', async ({ page }) => {
  await bootDemo(page, '/');
  await page.locator('section:has(h3)').first().locator('h3').first().click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveURL(/[?&]detail=/); // open pushed a shareable URL state
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0); // Back closes it
  await expect(page).not.toHaveURL(/[?&]detail=/);
});

test('chart hover: tooltip readout appears, moves and clears (single-svg hit-test)', async ({ page }) => {
  // The full breakdown charts (with the hover readout) live on /analytics now — the TG dashboard is
  // focused pages, so Обзор is a Sparkline-only summary. Previously this hit /' and relied on the
  // scroll-feed pre-mounting the Аналитика block below the short Overview.
  await bootDemo(page, '/analytics');
  // A series chart (LineChart exposes a named role=img svg). The svg itself is the hit surface —
  // hover derives the point index from the pointer x, no per-point rects.
  const chart = page.locator('svg[aria-label^="График:"]').first();
  await chart.waitFor({ state: 'visible', timeout: 15_000 });
  // mouse.move targets raw viewport coordinates and never auto-scrolls — bring the chart into
  // the viewport first, then read its box.
  await chart.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300); // settle the hover-clearing scroll listener
  const box = await chart.boundingBox();
  if (!box) throw new Error('chart svg has no box');
  const tooltip = page.locator('[data-chart-tooltip]');

  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await expect(tooltip.first()).toBeVisible();
  const early = (await tooltip.first().textContent()) ?? '';

  // A different x zone snaps to a different point — the readout follows (content may repeat on
  // flat series, so assert it stays visible rather than diffing text).
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.5);
  await expect(tooltip.first()).toBeVisible();
  expect(early.length).toBeGreaterThan(0);

  // Leaving the chart clears the readout (container mouseleave). The top-left corner is app
  // chrome on every viewport — guaranteed chart-free.
  await page.mouse.move(5, 5);
  await expect(tooltip).toHaveCount(0);
});

test('chart drill guard: a scrub across the chart does not navigate', async ({ page }) => {
  // Seed a drillable line widget (tg.views has a metric page) pinned to Home so its chart's
  // point-click drills to /metrics/views. addInitScript stacks before bootDemo's own seed. A
  // press-drag-release SCRUB (drag-to-read) must NOT drill — the guard bails when the pointer
  // travelled >5px between press and release. (The clean-click DRILL path is covered by the KPI
  // hero test above; asserting it on this chart is fixture-fragile — the story-card hero span
  // overlaps the svg centre — so this test locks only the no-navigation-on-scrub half.)
  await page.addInitScript(() => {
    localStorage.setItem('pulse_home_blocks', JSON.stringify({ keys: ['custom:probe1'] }));
    localStorage.setItem('pulse_widget_configs', JSON.stringify([{ id: 'probe1', metricId: 'tg.views', viz: 'line' }]));
  });
  await bootDemo(page, '/home');
  const chart = page.locator('svg[aria-label^="График:"]').first();
  await chart.waitFor({ state: 'visible', timeout: 15_000 });
  await chart.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const box = await chart.boundingBox();
  if (!box) throw new Error('chart svg has no box');
  const y = box.y + box.height * 0.5;

  await page.mouse.move(box.x + box.width * 0.2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, y, { steps: 8 });
  await page.mouse.up();
  await expect(page).not.toHaveURL(/\/metrics\//);
});

test('edit-mode entry + exit (Home)', async ({ page }) => {
  await bootDemo(page, '/home');
  // The «Изменить»↔«Готово» toggle reflects edit state via aria-pressed — robust whether Home is
  // empty or has pinned widgets (the empty state carries its own «Добавить виджет» button, so that
  // label alone can't distinguish the modes).
  const toggle = page.locator('button.edit-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true'); // entered edit mode
  await expect(page.getByRole('button', { name: /Добавить виджет/ })).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false'); // exited
});

test('edit toggle keeps a stable width across Изменить↔Готово (no reflow)', async ({ page }) => {
  // The chip holds BOTH labels in one grid cell and reserves the wider label's width, so switching
  // «Изменить»→«Готово» must NOT reflow the button (steep edit-mode choreography).
  await bootDemo(page, '/home');
  const toggle = page.locator('button.edit-toggle');
  const before = await toggle.boundingBox();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const after = await toggle.boundingBox();
  expect(before && after).toBeTruthy();
  // Identical width — the label swap is opacity/translate within a fixed cell, not a width jump.
  expect(Math.abs((after!.width) - (before!.width))).toBeLessThan(0.5);
});

test.describe('home edit-mode board inset (steep editable-canvas cue)', () => {
  // Seed one pinned widget so the board grid (#home) renders at rest AND in edit — otherwise an empty
  // Home shows HomeEmptyState (no #home) until edit mode. Same seed shape the drill-guard test uses;
  // addInitScript stacks BEFORE bootDemo's own seed.
  const seedBoard = (page: Page) =>
    page.addInitScript(() => {
      localStorage.setItem('pulse_home_blocks', JSON.stringify({ keys: ['custom:probe1'] }));
      localStorage.setItem('pulse_widget_configs', JSON.stringify([{ id: 'probe1', metricId: 'tg.views', viz: 'line' }]));
    });

  test('board steps in on «Изменить» and reverts on «Готово» (desktop)', async ({ page }) => {
    // The inset is lg-only, so force a desktop viewport regardless of the running project.
    await page.setViewportSize({ width: 1280, height: 900 });
    await seedBoard(page);
    await bootDemo(page, '/home');

    const board = page.locator('.home-board-canvas');
    const toggle = page.locator('button.edit-toggle');
    await board.waitFor({ state: 'visible', timeout: 15_000 });

    const restingWidth = (await board.boundingBox())!.width;

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await page.waitForTimeout(320); // 200ms max-width transition + settle
    const editingWidth = (await board.boundingBox())!.width;
    // ~112px narrower (7rem inset). Assert a clear step-in, not the exact px.
    expect(editingWidth).toBeLessThan(restingWidth - 80);

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await page.waitForTimeout(320);
    const revertedWidth = (await board.boundingBox())!.width;
    expect(Math.abs(revertedWidth - restingWidth)).toBeLessThanOrEqual(1);
  });

  for (const w of [360, 390, 430]) {
    test(`edit mode stays full-bleed with no h-overflow @ ${w}px`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 820 });
      await seedBoard(page);
      await bootDemo(page, '/home');

      const board = page.locator('.home-board-canvas');
      const toggle = page.locator('button.edit-toggle');
      await board.waitFor({ state: 'visible', timeout: 15_000 });
      const before = (await board.boundingBox())!.width;

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await page.waitForTimeout(320);
      // Below lg the lg:max-w-* inset rule never applies — the board keeps its full width…
      const after = (await board.boundingBox())!.width;
      expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
      // …and edit mode introduces no horizontal page scroll.
      const hScroll = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(hScroll, `h-scroll ${hScroll}px in edit mode @ ${w}`).toBeLessThanOrEqual(1);
    });
  }
});
