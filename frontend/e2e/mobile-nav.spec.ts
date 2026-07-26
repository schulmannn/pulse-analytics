import { test, expect } from '@playwright/test';
import { bootDemo, openDetailOverlay } from './helpers';

/**
 * Mobile navigation & reachability (card «Mobile dashboard navigation»). Two things get gated here at
 * phone widths (360/390/430):
 *  1. Touch targets — shared buttons/selects/menus, tabs, widget chrome and editor swatches are
 *     ≥44px, and the
 *     page never scrolls horizontally. (Inline text links / ⓘ keep their text size by design — their
 *     tap area is the text, and the same action has a full-size path in the detail overlay.)
 *  2. Sheets — the card detail opens as a full-height edge-to-edge sheet, the source switcher opens as
 *     a dismissable bottom sheet, and the detail deep-link (?detail=) survives Back + reload without
 *     losing the current source or the widget's period.
 * Guards against the desktop-only tiny affordances the card calls out.
 */
const WIDTHS = [360, 390, 430];
const MIN = 44;
const PHONE_ROUTES = [
  { path: '/', label: 'overview' },
  { path: '/instagram/content', label: 'instagram content' },
  { path: '/mentions', label: 'mentions' },
  { path: '/connect', label: 'connect' },
] as const;

/** Обмер один на оба теста ниже: горизонтальный скролл и размер основных контролов гейтятся вместе. */
async function measureMobileChrome(page: import('@playwright/test').Page, w: number, path = '/') {
  await page.setViewportSize({ width: w, height: 820 });
  await bootDemo(page, path);
  return page.evaluate((min) => {
    const hScroll = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const tooSmall: string[] = [];
    const controls = document.querySelectorAll(
      '[data-mobile-touch-target], button[aria-label^="Меню виджета"], [role="group"][aria-label^="Период"] button',
    );
    for (const el of Array.from(controls)) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < min - 0.5 || r.width < min - 0.5) {
        const name =
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.textContent?.trim().slice(0, 28) ||
          el.tagName.toLowerCase();
        tooSmall.push(`${name} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return { hScroll, tooSmall };
  }, MIN);
}

async function visibleTouchTargetFailures(
  page: import('@playwright/test').Page,
  scope = 'body',
): Promise<string[]> {
  return page.locator(scope).evaluate((root, min) => {
    const failures: string[] = [];
    for (const el of Array.from(root.querySelectorAll('[data-mobile-touch-target]'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < min - 0.5 || r.width < min - 0.5) {
        const name =
          el.getAttribute('aria-label') ||
          el.getAttribute('title') ||
          el.textContent?.trim().slice(0, 28) ||
          el.tagName.toLowerCase();
        failures.push(`${name} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return failures;
  }, MIN);
}

// Route matrix: the phone gate covers the default overview plus each distinct mobile surface that
// owns plain controls. This prevents a green root-only check from hiding compact actions deeper in
// Instagram, Mentions and Connect.
for (const w of WIDTHS) {
  for (const route of PHONE_ROUTES) {
    test(`mobile ${w}: ${route.label} has no overflow and primary controls ≥44px`, async ({ page }) => {
      const res = await measureMobileChrome(page, w, route.path);
      expect(res.hScroll, `horizontal scroll ${res.hScroll}px at ${w}px on ${route.path}`).toBeLessThanOrEqual(1);
      expect(
        res.tooSmall,
        `sub-44px primary controls at ${w}px on ${route.path}: ${JSON.stringify(res.tooSmall)}`,
      ).toEqual([]);
    });
  }
}

test('mobile 390: dialog, editor, post and pinned-point actions keep 44px targets', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await bootDemo(page, '/');

  const account = page.getByRole('button', { name: 'Аккаунт' });
  await account.click();
  await expect(page.getByRole('menu')).toBeVisible();
  expect(await visibleTouchTargetFailures(page, '[role="menu"]')).toEqual([]);
  await page.keyboard.press('Escape');

  // The common widget editor exposes Button, Select and the shared colour-swatch primitive.
  const menuButton = page.locator('button[aria-label^="Меню виджета"]').first();
  await menuButton.click();
  await page.getByRole('menuitem', { name: 'Изменить' }).first().click();
  const editor = page.getByRole('dialog', { name: /^Настройка виджета/ });
  await expect(editor).toBeVisible();
  expect(await visibleTouchTargetFailures(page, '[role="dialog"]')).toEqual([]);
  await editor.getByRole('button', { name: 'Закрыть', exact: true }).click();

  // The catalog used to render its own × in addition to DialogContent's ×. There must be one.
  await page.locator('button.edit-toggle').click();
  await page.locator('button.add-widget-trigger').click();
  await page.getByRole('button', { name: /Метрика из каталога/ }).click();
  const catalog = page.getByRole('dialog', { name: 'Добавить метрику' });
  await expect(catalog).toBeVisible();
  await expect(catalog.getByRole('button', { name: 'Закрыть', exact: true })).toHaveCount(1);
  expect(await visibleTouchTargetFailures(page, '[role="dialog"]')).toEqual([]);
  await catalog.getByRole('button', { name: 'Закрыть', exact: true }).click();

  await bootDemo(page, '/metrics/views');
  expect(await visibleTouchTargetFailures(page, '[data-metric-toolbar]')).toEqual([]);
  const metricCard = page.locator('[data-metric-chart-card]');
  await metricCard.getByRole('button', { name: 'Тип графика: Линия' }).click();
  const line = metricCard.locator('svg[data-chart-kind="line"][data-chart-expanded]').first();
  await line.waitFor({ state: 'visible', timeout: 10_000 });
  const lineBox = await line.boundingBox();
  if (!lineBox) throw new Error('line chart has no box');
  await page.mouse.click(lineBox.x + lineBox.width * 0.5, lineBox.y + lineBox.height * 0.55);
  const pinned = page.locator('[data-pinned-day="detail"]');
  await expect(pinned).toBeVisible();
  expect(await visibleTouchTargetFailures(page, '[data-pinned-day="detail"]')).toEqual([]);
  await pinned.getByRole('button', { name: 'Снять выделение точки' }).click();

  const topPost = page.locator('[data-metric-top-posts] [data-top-post-row] button').first();
  await topPost.scrollIntoViewIfNeeded();
  await topPost.click();
  const postDialog = page.getByRole('dialog', { name: /^Детали поста/ });
  await expect(postDialog).toBeVisible();
  await expect(postDialog.getByRole('button', { name: 'Закрыть', exact: true })).toHaveCount(1);
  expect(await visibleTouchTargetFailures(page, '[role="dialog"][aria-label^="Детали поста"]')).toEqual([]);
});

// ── Card detail = full-height, edge-to-edge sheet on mobile ─────────────────────────────────────
for (const w of WIDTHS) {
  test(`mobile ${w}: card detail opens as a full-height edge-to-edge sheet`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: 820 });
    // Deep-link straight to a widget's detail: the URL-driven open has no shared-element FLIP, so the
    // panel is laid out at its final size from frame one and we can measure the settled box.
    // overview-top-posts — карточка, которая ВЛАДЕЕТ обобщённым ?detail=-оверлеем. У
    // overview-hero теперь drillTo=/metrics/views, поэтому его deep-link уводит на
    // метрик-страницу и никакого диалога не открывает — мерить было бы нечего.
    await bootDemo(page, '/?detail=overview-top-posts');
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
    if (!box) throw new Error('detail panel is missing');
    // Edge-to-edge + full-height: hugs the left edge, spans the whole viewport (no 16px paper gutter).
    expect(box.left, `panel left ${box.left}`).toBeLessThanOrEqual(1);
    expect(Math.abs(box.width - box.vw), `panel width ${box.width} vs vw ${box.vw}`).toBeLessThanOrEqual(1);
    expect(Math.abs(box.height - box.vh), `panel height ${box.height} vs vh ${box.vh}`).toBeLessThanOrEqual(1);
    expect(box.hScroll, `horizontal scroll ${box.hScroll}px`).toBeLessThanOrEqual(1);
  });
}

// ── Detail deep-link survives Back + reload; the active source is preserved throughout ──────────
test('mobile 390: detail deep-links, Back closes it, reload reopens, source survives', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 820 });
  await bootDemo(page, '/');

  const sourceLabelBefore = await page.getByRole('button', { name: /^Источник/ }).getAttribute('aria-label');

  // Open a widget's detail from its header ↗ button → the URL gains ?detail= (a pushed history entry).
  await openDetailOverlay(page);
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

  // На мобильной Обзорной период страницы живёт в топбаре с меткой «Период» (пилюли
  // WidgetPeriodPills с меткой «Период страницы» — карточные, и на этой ширине их нет).
  const group = page.getByRole('group', { name: 'Период', exact: true }).first();
  await expect(group).toBeVisible();
  const allPill = group.getByRole('button', { name: 'Всё' });
  await allPill.click();
  await expect(allPill).toHaveAttribute('aria-pressed', 'true');

  await openDetailOverlay(page);
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
  await expect(sheet.getByRole('group', { name: 'Telegram', exact: true })).toBeVisible();
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
