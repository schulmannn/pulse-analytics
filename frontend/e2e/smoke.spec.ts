import { test, expect, type Locator } from '@playwright/test';
import { bootDemo } from './helpers';

async function requireBox(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('Expected visible element geometry');
  return box;
}

test('dashboard boots and navigates from overview to analytics', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await bootDemo(page, '/');
  await expect(page.locator('main')).toBeVisible();

  const analyticsLink = page.locator('a[href="/analytics"]:visible').first();
  await expect(analyticsLink).toBeVisible();
  await analyticsLink.click();

  await expect(page).toHaveURL(/\/analytics$/);
  await expect(page.locator('main section').first()).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('metric drill opens and browser Back returns to the dashboard', async ({ page }) => {
  await bootDemo(page, '/');

  const drill = page.getByRole('button', { name: /^Разбор:/ }).first();
  await expect(drill).toBeVisible();
  await drill.click();
  await expect(page).toHaveURL(/\/metrics\//);
  await expect(page.locator('main')).toBeVisible();

  await page.goBack();
  await expect(page).not.toHaveURL(/\/metrics\//);
  await expect(page.locator('main')).toBeVisible();
});

test('overview has one authoritative top-bar period and no card-local controls', async ({ page }) => {
  // Reproduce the production bug: old per-card settings disagreed with the 30д page header.
  await page.addInitScript(() => {
    localStorage.setItem(
      'pulse_widget_prefs',
      JSON.stringify({
        'overview-hero': { period: 7 },
        'overview-growth': { period: 90 },
        'overview-top-posts': { period: 7 },
      }),
    );
  });
  await bootDemo(page, '/');

  const pagePeriod = page.getByRole('group', { name: 'Период', exact: true });
  const widgetPeriods = page.getByRole('group', { name: 'Период страницы' });
  await expect(pagePeriod).toHaveCount(1);
  await expect(widgetPeriods).toHaveCount(0);
  await expect(page.getByRole('group', { name: 'Период виджета' })).toHaveCount(0);

  // The page default wins over every stale saved widget override without rendering duplicate UI.
  await expect(pagePeriod.getByRole('button', { name: '30д' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Просмотры · 30 дн.')).toBeVisible();
  const periodIndicator = pagePeriod.locator('[data-segmented-indicator]');
  await expect(periodIndicator).toHaveCount(1);
  const indicatorBefore = await periodIndicator.evaluate((node) => getComputedStyle(node).transform);
  const contextCard = page.getByRole('heading', { name: 'Главное изменение', exact: true }).locator('..').locator('..');
  const contextBefore = await contextCard.innerText();

  // The sole top-bar control re-windows every card on the page.
  await pagePeriod.getByRole('button', { name: '7д' }).click();
  await expect(pagePeriod.getByRole('button', { name: '7д' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => periodIndicator.evaluate((node) => getComputedStyle(node).transform)).not.toBe(indicatorBefore);
  await expect(page.getByText('Просмотры · 7 дн.')).toBeVisible();
  await expect.poll(() => contextCard.innerText()).not.toBe(contextBefore);
});

test('overview sparkline flows from one period shape into the next', async ({ page }, testInfo) => {
  // Desktop-only for a deterministic single-frame budget; the Sparkline morph itself is viewport
  // agnostic (its geometry lives in a fixed 200×32 viewBox). Mirrors the LineChart period-morph
  // contract (interactions.spec) but for the inline sparkline the Overview cards use.
  test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop-only sparkline morph budget');
  await bootDemo(page, '/');

  // The «Просмотры» hero card carries an area sparkline over the page-period views series.
  const heroCard = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Просмотры', exact: true }),
  });
  const chart = heroCard.locator('svg[data-chart-kind="sparkline"]').first();
  await chart.waitFor({ state: 'visible', timeout: 15_000 });
  const primarySeries = chart.locator('[data-chart-series="primary"]');
  const morphGroup = chart.locator('g[data-chart-motion="morph"]').first();
  await expect(morphGroup).toHaveAttribute('data-chart-morph-state', 'idle');
  const morphNode = await morphGroup.elementHandle();
  if (!morphNode) throw new Error('sparkline morph group has no element handle');
  const oldPath = await primarySeries.getAttribute('d');
  if (!oldPath) throw new Error('sparkline path is empty before period change');

  // The Overview defaults to 30д. Sample every browser frame while switching to the shorter 7д
  // window so a fast polling client cannot miss the running state.
  const pagePeriod = page.getByRole('group', { name: 'Период', exact: true });
  await expect(pagePeriod.getByRole('button', { name: '30д' })).toHaveAttribute('aria-pressed', 'true');
  await chart.evaluate((svg) => {
    const state = window as unknown as { __sparkFrames: Array<{ primary: string; state: string | null; at: number }> };
    state.__sparkFrames = [];
    const startedAt = performance.now();
    const sample = () => {
      const group = svg.querySelector('g[data-chart-motion="morph"]');
      const primary = svg.querySelector('[data-chart-series="primary"]');
      state.__sparkFrames.push({
        primary: primary?.getAttribute('d') ?? '',
        state: group?.getAttribute('data-chart-morph-state') ?? null,
        at: performance.now() - startedAt,
      });
      if (performance.now() - startedAt < 1900) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await pagePeriod.getByRole('button', { name: '7д', exact: true }).click();
  await page.waitForTimeout(1950);
  const frames = await page.evaluate(() => (window as unknown as {
    __sparkFrames: Array<{ primary: string; state: string | null; at: number }>;
  }).__sparkFrames);
  const finalPath = await primarySeries.getAttribute('d');
  const sameMorphNode = await morphGroup.evaluate((element, previousElement) => element === previousElement, morphNode);
  const firstRunningIndex = frames.findIndex((frame) => frame.state === 'running');
  const firstIdleAfterRunning = firstRunningIndex >= 0
    ? frames.slice(firstRunningIndex + 1).find((frame) => frame.state === 'idle')
    : undefined;
  const measuredMorphMs = firstRunningIndex >= 0 && firstIdleAfterRunning
    ? firstIdleAfterRunning.at - frames[firstRunningIndex].at
    : -1;
  const morphEvidence = JSON.stringify({
    sameMorphNode,
    states: [...new Set(frames.map((frame) => frame.state))],
    distinctPaths: new Set(frames.map((frame) => frame.primary)).size,
    pathChanged: finalPath !== oldPath,
    measuredMorphMs,
  });

  // Running state occurred; the final shape settled idle and differs from the start; at least one
  // intermediate frame differs from BOTH endpoints (a genuine morph, not a snap); the morph node
  // survived (no keyed remount).
  expect(frames.some((frame) => frame.state === 'running'), morphEvidence).toBe(true);
  // Recharts/shadcn parity: the update is intentionally visible for about 1.5s, never the old
  // front-loaded ~700ms flash. Leave scheduling tolerance for loaded CI runners.
  expect(measuredMorphMs, morphEvidence).toBeGreaterThanOrEqual(1300);
  expect(measuredMorphMs, morphEvidence).toBeLessThanOrEqual(1750);
  expect(frames.at(-1)?.state).toBe('idle');
  expect(finalPath).not.toBe(oldPath);
  expect(frames.some((frame) => frame.primary.length > 0 && frame.primary !== oldPath && frame.primary !== finalPath), morphEvidence).toBe(true);
  expect(frames.at(-1)?.primary).toBe(finalPath);
  expect(sameMorphNode).toBe(true);
  await expect(morphGroup).toHaveAttribute('data-chart-morph-state', 'idle');
});

test('desktop sidebar glides between open and rail without moving the icon axis', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop sidebar motion');
  await page.addInitScript(() => localStorage.setItem('pulse_sidebar', 'open'));
  await bootDemo(page, '/');

  const sidebar = page.getByRole('complementary', { name: 'Боковая панель' });
  const main = page.locator('main');
  const homeGlyph = sidebar.locator('a[href="/home"] svg');
  const homeCopy = sidebar.locator('a[href="/home"] .sidebar-copy');
  const toggle = page.getByRole('button', { name: 'Скрыть панель' });
  const search = page.getByRole('button', { name: 'Поиск' });
  await expect(homeGlyph).toHaveCount(1);
  await expect(sidebar).toHaveAttribute('data-rail', 'false');

  const [openSidebar, openMain, openGlyph, openToggle, openSearch] = await Promise.all([
    requireBox(sidebar),
    requireBox(main),
    requireBox(homeGlyph),
    requireBox(toggle),
    requireBox(search),
  ]);
  expect(openSidebar.width).toBeCloseTo(240, 0);
  const canvasInset = openMain.x - openSidebar.width;
  expect(canvasInset).toBeGreaterThanOrEqual(0);
  // Expanded (Kimi-led): Search holds the left rail axis, the toggle is pinned to the panel's right edge.
  expect(openSearch.x).toBeLessThan(openToggle.x - 20);
  expect(openSearch.y).toBeCloseTo(openToggle.y, 0);
  const rightGap = openSidebar.x + openSidebar.width - (openToggle.x + openToggle.width);
  expect(rightGap).toBeCloseTo(12, 0);

  // Toggle glyph + tooltip: an original morph reveals a directional chevron and a compact hint on
  // hover AND keyboard focus, honestly pointing «hide» while the panel is open. No native title.
  const tooltip = sidebar.getByRole('tooltip');
  const chevron = toggle.locator('.panel-chevron');
  expect(await toggle.getAttribute('title')).toBeNull();
  await expect(toggle.locator('.sidebar-toggle-glyph')).toHaveAttribute('data-direction', 'hide');
  await expect(tooltip).toHaveCSS('opacity', '0');
  await toggle.hover();
  await expect(tooltip).toHaveCSS('opacity', '1');
  await expect(tooltip).toContainText('Скрыть панель');
  await expect(tooltip.locator('kbd')).toHaveText(['Ctrl', 'B']);
  await expect(chevron).toHaveCSS('opacity', '1');
  await search.hover();
  await expect(tooltip).toHaveCSS('opacity', '0');
  // Keyboard Tab creates :focus-visible; advancing to Search closes the same affordance.
  await page.keyboard.press('Tab');
  await expect(toggle).toBeFocused();
  await expect(tooltip).toHaveCSS('opacity', '1');
  await expect(chevron).toHaveCSS('opacity', '1');
  await page.keyboard.press('Tab');
  await expect(search).toBeFocused();
  await expect(tooltip).toHaveCSS('opacity', '0');

  const expandDuration = await sidebar.evaluate((element) =>
    Math.max(...getComputedStyle(element).transitionDuration.split(',').map((part) => Number.parseFloat(part))),
  );
  // One shared ~300ms edge-led beat — no asymmetric collapse/expand pair.
  expect(expandDuration).toBeCloseTo(0.3, 1);

  await toggle.click();
  await expect(sidebar).toHaveAttribute('data-rail', 'true');
  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeCloseTo(64, 0);
  await expect(homeCopy).toHaveCSS('opacity', '0');

  const railToggleBtn = page.getByRole('button', { name: 'Показать панель' });
  const [railSidebar, railMain, railGlyph, railToggle, railSearch] = await Promise.all([
    requireBox(sidebar),
    requireBox(main),
    requireBox(homeGlyph),
    requireBox(railToggleBtn),
    requireBox(search),
  ]);
  expect(railSidebar.width).toBeCloseTo(64, 0);
  expect(railMain.x - railSidebar.width).toBeCloseTo(canvasInset, 0);
  // Main canvas travels exactly the 240→64 delta (176px) and the icon axis never moves.
  expect(openMain.x - railMain.x).toBeCloseTo(176, 0);
  expect(openMain.x - railMain.x).toBeCloseTo(openSidebar.width - railSidebar.width, 0);
  expect(Math.abs((railGlyph.x + railGlyph.width / 2) - (openGlyph.x + openGlyph.width / 2))).toBeLessThanOrEqual(1);
  // Rail: the toggle is back on the icon axis, Search drops below it.
  expect(railSearch.x).toBeCloseTo(railToggle.x, 0);
  expect(railSearch.y).toBeGreaterThan(railToggle.y + 20);
  // Chevron flips to the honest «reveal» direction in the rail.
  await expect(railToggleBtn.locator('.sidebar-toggle-glyph')).toHaveAttribute('data-direction', 'show');
  await railToggleBtn.hover();
  await expect(tooltip).toContainText('Показать панель');
  await expect(tooltip).toHaveCSS('opacity', '1');
  await search.hover();
  await expect(tooltip).toHaveCSS('opacity', '0');

  const collapseDuration = await sidebar.evaluate((element) =>
    Math.max(...getComputedStyle(element).transitionDuration.split(',').map((part) => Number.parseFloat(part))),
  );
  expect(collapseDuration).toBeCloseTo(0.3, 1);
  expect(collapseDuration).toBeCloseTo(expandDuration, 1);

  // Ctrl+B uses the same mode path. A focused input must keep the browser shortcut from toggling.
  await page.keyboard.press('Control+b');
  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeCloseTo(240, 0);
  await page.keyboard.press('Control+b');
  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeCloseTo(64, 0);
  await search.click();
  const combobox = page.getByRole('combobox', { name: 'Поиск' });
  await expect(combobox).toBeFocused();
  await combobox.press('Control+b');
  await page.waitForTimeout(320);
  // Палитра теперь настоящий модальный Radix-диалог: пока она открыта, фон честно aria-hidden,
  // и role-локатор сайдбара слепнет. Геометрию меряем CSS-локатором — контракт тот же
  // (Ctrl+B в фокусе поиска НЕ тогглит панель), меняется только механизм замера.
  const sidebarCss = page.locator('aside[aria-label="Боковая панель"]');
  expect((await requireBox(sidebarCss)).width).toBeCloseTo(64, 0);
  await page.keyboard.press('Escape');

  // Interrupting an expansion must reverse through CSS and settle on the last requested state.
  await page.keyboard.press('Control+b');
  await page.keyboard.press('Control+b');
  await expect(sidebar).toHaveAttribute('data-rail', 'true');
  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeCloseTo(64, 0);
  expect(await page.evaluate(() => localStorage.getItem('pulse_sidebar'))).toBe('rail');
});

test('reduced motion removes sidebar duration and staged copy delay', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop sidebar motion');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => localStorage.setItem('pulse_sidebar', 'open'));
  await bootDemo(page, '/');

  const sidebar = page.getByRole('complementary', { name: 'Боковая панель' });
  const copy = sidebar.locator('a[href="/home"] .sidebar-copy');
  await page.getByRole('button', { name: 'Скрыть панель' }).click();
  await expect(sidebar).toHaveAttribute('data-rail', 'true');
  await page.waitForTimeout(20);
  expect((await requireBox(sidebar)).width).toBeCloseTo(64, 0);
  await expect(copy).toHaveCSS('opacity', '0');

  const timing = await copy.evaluate((element) => ({
    duration: getComputedStyle(element).transitionDuration,
    delay: getComputedStyle(element).transitionDelay,
  }));
  const durations = timing.duration.split(',').map((part) => Number.parseFloat(part));
  const delays = timing.delay.split(',').map((part) => Number.parseFloat(part));
  expect(Math.max(...durations)).toBeLessThan(0.001);
  expect(Math.max(...delays)).toBe(0);

  // The toggle tooltip/glyph reveal is collapsed by the same global net.
  const reducedTiming = await sidebar.getByRole('tooltip').evaluate((element) => ({
    duration: getComputedStyle(element).transitionDuration,
    delay: getComputedStyle(element).transitionDelay,
  }));
  expect(Math.max(...reducedTiming.duration.split(',').map((part) => Number.parseFloat(part)))).toBeLessThan(0.001);
  expect(Math.max(...reducedTiming.delay.split(',').map((part) => Number.parseFloat(part)))).toBe(0);
});
