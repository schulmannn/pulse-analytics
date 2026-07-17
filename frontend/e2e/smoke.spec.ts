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
  const contextCard = page.getByRole('heading', { name: 'Главное изменение', exact: true }).locator('..').locator('..');
  const contextBefore = await contextCard.innerText();

  // The sole top-bar control re-windows every card on the page.
  await pagePeriod.getByRole('button', { name: '7д' }).click();
  await expect(pagePeriod.getByRole('button', { name: '7д' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Просмотры · 7 дн.')).toBeVisible();
  await expect.poll(() => contextCard.innerText()).not.toBe(contextBefore);
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
  expect(openSearch.y).toBeCloseTo(openToggle.y, 0);
  expect(openSearch.x).toBeGreaterThan(openToggle.x + 20);

  const expandDuration = await sidebar.evaluate((element) =>
    Math.max(...getComputedStyle(element).transitionDuration.split(',').map((part) => Number.parseFloat(part))),
  );
  expect(expandDuration).toBeGreaterThanOrEqual(0.29);

  await toggle.click();
  await expect(sidebar).toHaveAttribute('data-rail', 'true');
  await expect.poll(async () => (await sidebar.boundingBox())?.width ?? 0).toBeCloseTo(64, 0);
  await expect(homeCopy).toHaveCSS('opacity', '0');

  const [railSidebar, railMain, railGlyph, railToggle, railSearch] = await Promise.all([
    requireBox(sidebar),
    requireBox(main),
    requireBox(homeGlyph),
    requireBox(page.getByRole('button', { name: 'Показать панель' })),
    requireBox(search),
  ]);
  expect(railSidebar.width).toBeCloseTo(64, 0);
  expect(railMain.x - railSidebar.width).toBeCloseTo(canvasInset, 0);
  expect(openMain.x - railMain.x).toBeCloseTo(openSidebar.width - railSidebar.width, 0);
  expect(Math.abs((railGlyph.x + railGlyph.width / 2) - (openGlyph.x + openGlyph.width / 2))).toBeLessThanOrEqual(1);
  expect(railSearch.x).toBeCloseTo(railToggle.x, 0);
  expect(railSearch.y).toBeGreaterThan(railToggle.y + 20);

  const collapseDuration = await sidebar.evaluate((element) =>
    Math.max(...getComputedStyle(element).transitionDuration.split(',').map((part) => Number.parseFloat(part))),
  );
  expect(collapseDuration).toBeGreaterThanOrEqual(0.23);
  expect(collapseDuration).toBeLessThan(expandDuration);

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
  expect((await requireBox(sidebar)).width).toBeCloseTo(64, 0);
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
});
