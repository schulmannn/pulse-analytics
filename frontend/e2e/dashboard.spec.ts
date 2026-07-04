import { test, expect } from '@playwright/test';
import { bootDemo, overflowingCards } from './helpers';

// Routes that render the FULL widget set deterministically (independent of per-user pins): the
// Overview feed, Analytics breakdowns and Posts. /home is per-user pin-dependent, so it is exercised
// only by the edit-mode interaction test, not the layout invariants here.
const ROUTES = [
  { path: '/', name: 'overview' },
  { path: '/analytics', name: 'analytics' },
  { path: '/posts', name: 'posts' },
];

for (const route of ROUTES) {
  test(`no inner scrollbars — ${route.name}`, async ({ page }) => {
    await bootDemo(page, route.path);
    const overflowing = await overflowingCards(page);
    expect(overflowing, `card bodies with an inner scrollbar on ${route.path}: ${JSON.stringify(overflowing)}`).toEqual([]);
  });

  test(`no horizontal page scroll — ${route.name}`, async ({ page }) => {
    await bootDemo(page, route.path);
    const hScroll = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(hScroll, `page scrolls horizontally by ${hScroll}px on ${route.path}`).toBeLessThanOrEqual(1);
  });

  test(`no runaway card height — ${route.name}`, async ({ page }) => {
    await bootDemo(page, route.path);
    // A tile whose height exceeds 4× the viewport signals the measure→height→content feedback loop
    // (a chart chasing its own height) that the fixed-tile + overflow-hidden model prevents.
    const tall = await page.evaluate(() => {
      const vh = window.innerHeight;
      return [...document.querySelectorAll('section')]
        .filter((s) => s.querySelector('h3') && s.getBoundingClientRect().height > vh * 4)
        .map((s) => ({ widget: (s.querySelector('h3')?.textContent || '?').trim(), h: Math.round(s.getBoundingClientRect().height) }));
    });
    expect(tall, `runaway-height cards on ${route.path}: ${JSON.stringify(tall)}`).toEqual([]);
  });

  test(`visual snapshot — ${route.name}`, async ({ page }, testInfo) => {
    await bootDemo(page, route.path);
    const shot = await page.screenshot({ fullPage: true });
    await testInfo.attach(`${route.name}-${testInfo.project.name}`, { body: shot, contentType: 'image/png' });
  });
}
