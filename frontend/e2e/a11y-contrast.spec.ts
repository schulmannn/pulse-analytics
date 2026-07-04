import { test, expect } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { bootDemo } from './helpers';

/**
 * Color-contrast gate (the rule the main a11y suite intentionally excludes) — WCAG 1.4.3 text
 * contrast, scanned per THEME since light and dark are two separate token palettes in index.css.
 * axe checks rendered text only; non-text contrast (chart strokes, hairlines) is reviewed at the
 * token level in scripts/contrast-tokens (same shipment) since no automated rule covers it.
 */

const ROUTES = [
  { path: '/', name: 'overview' },
  { path: '/analytics', name: 'analytics' },
  { path: '/posts', name: 'posts' },
  { path: '/home', name: 'home' },
];

const THEMES = ['light', 'dark'] as const;

async function expectNoContrastViolations(
  page: import('@playwright/test').Page,
  testInfo: import('@playwright/test').TestInfo,
  label: string,
): Promise<void> {
  const results = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
  await testInfo.attach(`contrast-${label}-${testInfo.project.name}`, {
    body: JSON.stringify(results.violations, null, 2),
    contentType: 'application/json',
  });
  const hits = results.violations.flatMap((v) =>
    v.nodes.slice(0, 12).map((n) => ({
      target: n.target.join(' '),
      summary: n.failureSummary?.split('\n').slice(1, 2).join('') ?? '',
    })),
  );
  expect(hits, `color-contrast failures on ${label}: ${JSON.stringify(hits, null, 2)}`).toEqual([]);
}

for (const theme of THEMES) {
  for (const route of ROUTES) {
    test(`contrast (${theme}): ${route.name}`, async ({ page }, testInfo) => {
      await bootDemo(page, route.path, { theme });
      await expectNoContrastViolations(page, testInfo, `${theme}-${route.name}`);
    });
  }

  test(`contrast (${theme}): detail overlay`, async ({ page }, testInfo) => {
    await bootDemo(page, '/', { theme });
    await page.getByRole('button', { name: /^Развернуть виджет/ }).first().click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectNoContrastViolations(page, testInfo, `${theme}-detail`);
  });

  test(`contrast (${theme}): home edit mode`, async ({ page }, testInfo) => {
    await bootDemo(page, '/home', { theme });
    const toggle = page.locator('button.edit-toggle');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expectNoContrastViolations(page, testInfo, `${theme}-home-edit`);
  });

  test(`contrast (${theme}): command palette`, async ({ page }, testInfo) => {
    await bootDemo(page, '/', { theme });
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('dialog', { name: 'Поиск' })).toBeVisible();
    await expectNoContrastViolations(page, testInfo, `${theme}-palette`);
  });

  // The widget settings dialog is where disabled controls + their reasons live.
  test(`contrast (${theme}): widget editor`, async ({ page }, testInfo) => {
    await bootDemo(page, '/', { theme });
    const menuButton = page.locator('button[aria-label^="Меню виджета"]').first();
    await menuButton.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Изменить' }).first().click();
    await expect(page.getByRole('dialog', { name: /^Настройка виджета/ })).toBeVisible();
    await expectNoContrastViolations(page, testInfo, `${theme}-editor`);
  });
}
