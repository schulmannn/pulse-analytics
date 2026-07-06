import { test, expect } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Layering scale (DESIGN_TOKENS «Layering»). Overlays pull from one named z-index ladder so nothing
 * ties — before it, a card ⋯-menu shared z-20 with the sticky chrome. This pins the key ordering (a
 * modal out-ranks the fixed app nav, and by the ladder the sticky chrome beneath it) both on paper
 * (computed z-index) and behaviourally (what actually paints on top), so a future raw z-value can't
 * silently re-introduce a tie-fight.
 */
test('overlays follow the layering scale (modal above nav, covers content)', async ({ page }) => {
  await bootDemo(page, '/');

  // Fixed app navigation carries the z-nav token — the sidebar on md+, the bottom nav below md.
  // getComputedStyle reads the used z-index even if this breakpoint's variant is display:none.
  const navZ = await page
    .locator('.z-nav')
    .first()
    .evaluate((el) => Number(getComputedStyle(el).zIndex) || 0);
  expect(navZ, 'z-nav utility should resolve to a real stacking value').toBeGreaterThan(0);

  // Open a widget detail overlay — a body-portaled surface at z-modal.
  await page.getByRole('button', { name: /^Развернуть виджет/ }).first().click();
  const dialog = page.locator('[role="dialog"]').first();
  await expect(dialog).toBeVisible();
  const dialogZ = await dialog.evaluate((el) => Number(getComputedStyle(el).zIndex) || 0);

  // On paper: the modal out-ranks the fixed nav (and thus the sticky chrome under it).
  expect(dialogZ).toBeGreaterThan(navZ);

  // Behaviourally: the element painted at the viewport centre is inside the dialog — the overlay
  // truly covers the app chrome, it isn't just a bigger number a stacking context could trap.
  const coversCenter = await page.evaluate(() => {
    const el = document.elementFromPoint(
      Math.floor(window.innerWidth / 2),
      Math.floor(window.innerHeight / 2),
    );
    return !!el?.closest('[role="dialog"]');
  });
  expect(coversCenter).toBe(true);
});

/**
 * Dismissal contract for the overlay layer (card «Acceptance: … tests for Escape/outside click»).
 * Escape is already gated per-overlay (a11y.spec: ⋯-menu, ⌘K palette); this pins OUTSIDE-CLICK, and
 * re-confirms Escape on the detail modal — the two ways a layered overlay must close. Because the
 * modal scrim sits at z-modal above all app chrome, a click on a top-corner pixel lands on the scrim
 * (not the sidebar/topbar beneath it) and closes the overlay — dismissal and layering in one.
 */
test('detail overlay dismisses on outside-click (scrim) and Escape', async ({ page }) => {
  await bootDemo(page, '/');
  const opener = page.getByRole('button', { name: /^Развернуть виджет/ }).first();

  // Outside-click: open, then click a top-corner pixel — that hits the z-modal scrim (proof it's
  // above the app chrome) whose onClick closes the overlay.
  await opener.click();
  await expect(page.locator('[role="dialog"]')).toBeVisible();
  await page.mouse.click(6, 6);
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);

  // Escape: reopen and dismiss via the keyboard (capture-phase Escape in DetailShell); focus returns
  // to the opener so a keyboard user isn't dropped to <body>.
  await opener.click();
  await expect(page.locator('[role="dialog"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('[role="dialog"]')).toHaveCount(0);
  await expect(opener).toBeFocused();
});
