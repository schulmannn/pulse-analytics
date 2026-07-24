import { test, expect } from '@playwright/test';
import { bootDemo, detailOverlayOpener } from './helpers';

/**
 * Mobile navigation & reachability (card «Mobile dashboard navigation»). Two things get gated here at
 * phone widths (360/390/430):
 *  1. Touch targets — each widget's menu button and the period pills are ≥32px, and the
 *     page never scrolls horizontally. (Inline text links / ⓘ keep their text size by design — their
 *     tap area is the text, and the same action has a full-size path in the detail overlay.)
 *  2. Sheets — the card detail opens as a full-height edge-to-edge sheet, the source switcher opens as
 *     a dismissable bottom sheet, and the detail deep-link (?detail=) survives Back + reload without
 *     losing the current source or the widget's period.
 * Guards against the desktop-only tiny affordances the card calls out.
 */
const WIDTHS = [360, 390, 430];
const MIN = 32;

for (const w of WIDTHS) {
  test(`mobile ${w}: primary controls ≥32px + no horizontal scroll`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: 820 });
    await bootDemo(page, '/');
    const res = await page.evaluate((min) => {
      const hScroll = document.documentElement.scrollWidth - document.documentElement.clientWidth;
      const tooSmall: string[] = [];
      const check = (sel: string, name: (e: Element) => string) => {
        for (const el of Array.from(document.querySelectorAll(sel))) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.height < min - 0.5 || r.width < min - 0.5) tooSmall.push(`${name(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
        }
      };
      check('button[aria-label^="Меню виджета"]', (e) => (e.getAttribute('aria-label') || '').slice(0, 24));
      check('[role="group"][aria-label^="Период"] button', (e) => `период ${(e.textContent || '').trim()}`);
      return { hScroll, tooSmall };
    }, MIN);
    expect(res.hScroll, `horizontal scroll ${res.hScroll}px at ${w}px`).toBeLessThanOrEqual(1);
    expect(res.tooSmall, `sub-32px primary controls at ${w}px: ${JSON.stringify(res.tooSmall)}`).toEqual([]);
  });
}

// ── Card detail = full-height, edge-to-edge sheet on mobile ─────────────────────────────────────
for (const w of WIDTHS) {
  test(`mobile ${w}: card detail opens as a full-height edge-to-edge sheet`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: 820 });
    // Deep-link straight to a widget's detail: the URL-driven open has no shared-element FLIP, so the
    // panel is laid out at its final size from frame one and we can measure the settled box.
    await bootDemo(page, '/?detail=overview-hero');
    await expect(page.getByRole('dialog', { name: /^График/ })).toBeVisible();
    const box = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"][aria-label^="График"]');
      if (!d) return null;
      // The panel is the dialog's non-backdrop child (the backdrop carries aria-hidden).
      const card = Array.from(d.children).find((el) => el.getAttribute('aria-hidden') !== 'true');
      if (!card) return null;
      const r = card.getBoundingClientRect();
      return {
        left: r.left,
        width: r.width,
        height: r.height,
        vw: window.innerWidth,
        vh: window.innerHeight,
        hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    expect(box, 'detail panel present').not.toBeNull();
    // Edge-to-edge + full-height: hugs the left edge, spans the whole viewport (no 16px paper gutter).
    expect(box!.left, `panel left ${box!.left}`).toBeLessThanOrEqual(1);
    expect(Math.abs(box!.width - box!.vw), `panel width ${box!.width} vs vw ${box!.vw}`).toBeLessThanOrEqual(1);
    expect(Math.abs(box!.height - box!.vh), `panel height ${box!.height} vs vh ${box!.vh}`).toBeLessThanOrEqual(1);
    expect(box!.hScroll, `horizontal scroll ${box!.hScroll}px`).toBeLessThanOrEqual(1);
  });
}

// ── Detail deep-link survives Back + reload; the active source is preserved throughout ──────────
test('mobile 390: detail deep-links, Back closes it, reload reopens, source survives', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await bootDemo(page, '/');

  const sourceLabelBefore = await page.getByRole('button', { name: /^Источник/ }).getAttribute('aria-label');

  // Open a widget's detail from its header ↗ button → the URL gains ?detail= (a pushed history entry).
  await detailOverlayOpener(page).click();
  await expect(page).toHaveURL(/[?&]detail=/);
  await expect(page.getByRole('dialog', { name: /^График/ })).toBeVisible();

  // Browser Back closes the overlay (steep) and returns to the dashboard — not a route change away.
  await page.goBack();
  await expect(page).not.toHaveURL(/[?&]detail=/);
  await expect(page.getByRole('dialog', { name: /^График/ })).toHaveCount(0);
  await expect(page.locator('main')).toBeVisible();

  // Forward back onto the ?detail= URL, then a hard reload — the sheet must reopen from the URL alone.
  await page.goForward();
  await expect(page).toHaveURL(/[?&]detail=/);
  await page.reload();
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  await expect(page.getByRole('dialog', { name: /^График/ })).toBeVisible();

  // The active source (channel) is unchanged across the whole dance.
  expect(await page.getByRole('button', { name: /^Источник/ }).getAttribute('aria-label')).toBe(sourceLabelBefore);
});

// ── The shared page period survives opening + closing a detail overlay ─────────────────────────
test('mobile 390: page period survives a detail open/close round-trip', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await bootDemo(page, '/');

  const group = page.locator('[role="group"][aria-label="Период страницы"]').first();
  await expect(group).toBeVisible();
  const allPill = group.getByRole('button', { name: 'Всё' });
  await allPill.click();
  await expect(allPill).toHaveAttribute('aria-pressed', 'true');

  await detailOverlayOpener(page).click();
  await expect(page.getByRole('dialog', { name: /^График/ })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog', { name: /^График/ })).toHaveCount(0);

  // The section never unmounted → the shared period stays exactly where the user left it.
  await expect(allPill).toHaveAttribute('aria-pressed', 'true');
});

// ── Source switcher = a dismissable bottom sheet on mobile (dialog, backdrop + Escape close) ─────
test('mobile 390: source switcher opens as a dismissable bottom sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await bootDemo(page, '/');

  const trigger = page.getByRole('button', { name: /^Источник/ });
  await trigger.click();
  const sheet = page.getByRole('dialog', { name: /^Источник/ });
  await expect(sheet).toBeVisible();
  // It is pinned to the bottom edge and lists the Telegram source group.
  await expect(sheet.locator('[role="group"][aria-label="Telegram"]')).toBeVisible();
  // Let the .sheet-in slide-up settle: getBoundingClientRect includes the in-flight translateY, so
  // measuring mid-animation reads a bottom below the fold. 300ms animation → wait a touch longer.
  await page.waitForTimeout(450);
  const metrics = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"][aria-label^="Источник"]') as HTMLElement | null;
    const panel = d
      ? (Array.from(d.children).find((el) => el.getAttribute('aria-hidden') !== 'true') as HTMLElement | undefined)
      : undefined;
    const dr = d?.getBoundingClientRect();
    const pr = panel?.getBoundingClientRect();
    return {
      hScroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      // Compare panel↔container (both in viewport coords) — immune to the mobile layout-vs-visual
      // viewport gap that makes window.innerHeight unreliable under device emulation.
      bottomGap: dr && pr ? Math.round(dr.bottom - pr.bottom) : null,
      topGap: dr && pr ? Math.round(pr.top - dr.top) : null,
    };
  });
  expect(metrics.hScroll, `horizontal scroll ${metrics.hScroll}px`).toBeLessThanOrEqual(1);
  expect(metrics.bottomGap, 'sheet flush to the bottom edge').toBe(0);
  expect(metrics.topGap, 'bottom sheet leaves backdrop above it').toBeGreaterThan(8);

  // Escape dismisses it.
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  // Reopen, then a backdrop tap (top of the screen, above the bottom sheet) also dismisses it.
  await trigger.click();
  await expect(sheet).toBeVisible();
  await page.mouse.click(195, 30);
  await expect(sheet).toHaveCount(0);
});
