import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

test('settings keeps one readable content column at every shell breakpoint', async ({ page }) => {
  await bootDemo(page, '/settings');
  await expect(page.getByRole('heading', { name: 'Профиль', exact: true })).toBeVisible();

  const metrics = await page.evaluate(() => {
    const visible = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) return false;
      return Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    };
    const rect = (element: Element | null) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { width: box.width, bottom: box.bottom };
    };
    const dashboard = document.querySelector<HTMLElement>('[data-dashboard-scroll]');
    const region = document.querySelector('main section[aria-labelledby^="settings-"]');
    const rail = document.querySelector('aside nav[aria-label="Разделы настроек"]');
    const selector = document.querySelector('button[aria-label^="Выбрать раздел настроек"]');
    const railItems = rail
      ? Array.from(rail.querySelectorAll('button, a')).filter(visible)
      : [];

    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dashboardOverflow: dashboard ? dashboard.scrollWidth - dashboard.clientWidth : 0,
      visibleH1: Array.from(document.querySelectorAll('h1')).filter(visible).length,
      region: rect(region),
      rail: rect(rail),
      railVisible: visible(rail),
      selectorVisible: visible(selector),
      lastRailBottom: rect(railItems.at(-1) ?? null)?.bottom ?? null,
      activeRailItems: rail
        ? rail.querySelectorAll('[aria-current="page"]').length
        : 0,
    };
  });

  expect(metrics.documentOverflow).toBeLessThanOrEqual(1);
  expect(metrics.dashboardOverflow).toBeLessThanOrEqual(1);
  expect(metrics.visibleH1).toBe(1);

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();
  if (!viewport) return;

  if (viewport.width >= 1280) {
    expect(metrics.railVisible).toBe(true);
    expect(metrics.selectorVisible).toBe(false);
    expect(metrics.rail?.width).toBeGreaterThanOrEqual(219);
    expect(metrics.rail?.width).toBeLessThanOrEqual(221);
    expect(metrics.region?.width).toBeLessThanOrEqual(761);
    expect(metrics.lastRailBottom).not.toBeNull();
    expect(metrics.lastRailBottom ?? viewport.height + 1).toBeLessThanOrEqual(viewport.height);
    expect(metrics.activeRailItems).toBe(1);
  } else {
    expect(metrics.railVisible).toBe(false);
    expect(metrics.selectorVisible).toBe(true);
  }
});

test('settings billing stacks plans before the expanded shell makes them cramped', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one CI worker owns the 900px regression');

  await page.setViewportSize({ width: 900, height: 900 });
  await page.addInitScript(() => localStorage.setItem('pulse_sidebar', 'open'));
  await bootDemo(page, '/settings?section=billing');

  const cards = await page.locator('[data-settings-plan-card]').evaluateAll((elements) =>
    elements.map((element) => {
      const box = element.getBoundingClientRect();
      return { width: box.width, top: box.top };
    }),
  );

  expect(cards).toHaveLength(3);
  expect(cards.every((card) => card.width >= 300)).toBe(true);
  expect(new Set(cards.map((card) => Math.round(card.top))).size).toBe(3);

  const overflow = await page.evaluate(() => {
    const dashboard = document.querySelector<HTMLElement>('[data-dashboard-scroll]');
    return {
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dashboard: dashboard ? dashboard.scrollWidth - dashboard.clientWidth : 0,
    };
  });
  expect(overflow.document).toBeLessThanOrEqual(1);
  expect(overflow.dashboard).toBeLessThanOrEqual(1);
});
