import { test, expect } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';
import { AxeBuilder } from '@axe-core/playwright';
import { bootDemo, detailOverlayOpener } from './helpers';

/**
 * Accessibility gate. Two layers:
 *  1. axe-core scans (WCAG 2.x A/AA rules) over the deterministic demo routes and the two stateful
 *     surfaces (detail overlay, Home edit mode). Fails on serious/critical violations; the full
 *     violation list is attached to the report for triage. The color-contrast rule is intentionally
 *     excluded — palette work is the separate «Color contrast audit» roadmap card.
 *  2. Keyboard smoke for the core widget flow: focus card → Enter opens the detail dialog → Tab is
 *     trapped inside → Escape closes → focus returns to the card (APG dialog contract).
 */

async function expectNoSeriousViolations(page: Page, testInfo: TestInfo, label: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .disableRules(['color-contrast'])
    .analyze();
  await testInfo.attach(`axe-${label}-${testInfo.project.name}`, {
    body: JSON.stringify(results.violations, null, 2),
    contentType: 'application/json',
  });
  const serious = results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.slice(0, 5).map((n) => n.target.join(' ')),
    }));
  expect(serious, `axe serious/critical violations on ${label}: ${JSON.stringify(serious, null, 2)}`).toEqual([]);
}

const ROUTES = [
  { path: '/', name: 'overview' },
  { path: '/analytics', name: 'analytics' },
  { path: '/posts', name: 'posts' },
  { path: '/home', name: 'home' },
];

for (const route of ROUTES) {
  test(`axe: no serious violations — ${route.name}`, async ({ page }, testInfo) => {
    await bootDemo(page, route.path);
    await expectNoSeriousViolations(page, testInfo, route.name);
  });
}

test('axe: no serious violations — detail overlay open', async ({ page }, testInfo) => {
  await bootDemo(page, '/');
  await detailOverlayOpener(page).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expectNoSeriousViolations(page, testInfo, 'detail-overlay');
});

test('axe: no serious violations — Home edit mode', async ({ page }, testInfo) => {
  await bootDemo(page, '/home');
  const toggle = page.locator('button.edit-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expectNoSeriousViolations(page, testInfo, 'home-edit');
});

test('keyboard: Enter opens widget detail, Escape closes, focus returns to the opener', async ({ page }) => {
  await bootDemo(page, '/');
  // The semantic keyboard path to the detail overlay is the header's labelled expand button
  // (the whole-card click is a mouse-only convenience — no nested-interactive card button).
  const opener = detailOverlayOpener(page);
  await opener.focus();
  await expect(opener).toBeFocused();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // The dialog's focus trap must hand focus back to the opener (WCAG 2.4.3).
  await expect(opener).toBeFocused();
});

test('keyboard: Tab stays inside the open detail dialog (focus trap)', async ({ page }) => {
  await bootDemo(page, '/');
  const opener = detailOverlayOpener(page);
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    const inside = await dialog.evaluate((d) => d.contains(document.activeElement));
    expect(inside, `Tab #${i + 1} escaped the dialog focus trap`).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('keyboard: widget ⋯-menu opens with Enter and closes with Escape', async ({ page }) => {
  await bootDemo(page, '/');
  const menuButton = page.locator('button[aria-label^="Меню виджета"]').first();
  await menuButton.focus();
  await page.keyboard.press('Enter');
  await expect(menuButton).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  // Escape must hand focus back to the trigger (the focused menu item unmounted).
  await expect(menuButton).toBeFocused();
});

test('keyboard: ⌘K palette is a live combobox and restores focus on close', async ({ page }) => {
  await bootDemo(page, '/');
  // Park focus somewhere identifiable first — the palette's focus trap must restore it on close.
  const opener = page.getByRole('button', { name: /^Развернуть виджет/ }).first();
  await opener.focus();
  await page.keyboard.press('ControlOrMeta+k');
  const combo = page.getByRole('combobox', { name: 'Поиск' });
  await expect(combo).toBeFocused();
  // ↑/↓ drive a VIRTUAL selection — it must be exposed via aria-activedescendant on the input.
  const before = await combo.getAttribute('aria-activedescendant');
  await page.keyboard.press('ArrowDown');
  const after = await combo.getAttribute('aria-activedescendant');
  expect(after).not.toBe(before);
  expect(after).toBeTruthy();
  await expect(page.locator(`#${after}`)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(combo).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('axe: no serious violations — command palette open', async ({ page }, testInfo) => {
  await bootDemo(page, '/');
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Поиск' })).toBeVisible();
  await expectNoSeriousViolations(page, testInfo, 'palette');
});

test('keyboard: widget edit dialog traps Tab and restores focus to the ⋯ trigger', async ({ page }) => {
  await bootDemo(page, '/');
  const menuButton = page.locator('button[aria-label^="Меню виджета"]').first();
  await menuButton.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Изменить' }).first().click();
  const dialog = page.getByRole('dialog', { name: /^Настройка виджета/ });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab');
    const inside = await dialog.evaluate((d) => d.contains(document.activeElement));
    expect(inside, `Tab #${i + 1} escaped the edit dialog focus trap`).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  // The «Изменить» item refocused the ⋯ trigger before opening, so the dialog's trap captured it
  // as opener and must restore it on close.
  await expect(menuButton).toBeFocused();
});
