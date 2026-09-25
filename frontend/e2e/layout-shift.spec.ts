import { test, expect } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * CLS budget for the core app routes (card «Skeleton-to-content layout shift budget»). Skeletons /
 * loading rows must reserve the final content's footprint so nothing jumps when data resolves. Each
 * test records cumulative layout-shift via PerformanceObserver from the first paint and asserts it
 * stays under BUDGET across every breakpoint.
 *
 * Google's "good" CLS threshold is 0.1; the app measures well under it — most routes ~0, /overview
 * the highest (~0.04) from its content-height insight/grid.
 * The gate is a REGRESSION guard: a skeleton that stops matching its content (a return-null→content
 * pop-in, a mis-sized loading block) blows past 0.1 and fails here.
 */
const BUDGET = 0.1;
const ROUTES = ['/', '/analytics', '/posts', '/mentions', '/reports', '/home'];

for (const route of ROUTES) {
  test(`CLS budget — ${route}`, async ({ page }) => {
    // Install the layout-shift observer BEFORE any app script runs (bootDemo's init scripts + goto
    // register after this), so it captures shifts from the very first paint.
    await page.addInitScript(() => {
      (window as { __cls?: number }).__cls = 0;
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const s = e as PerformanceEntry & { value: number; hadRecentInput: boolean };
          if (!s.hadRecentInput) (window as { __cls?: number }).__cls! += s.value;
        }
      }).observe({ type: 'layout-shift', buffered: true } as PerformanceObserverInit);
    });
    await bootDemo(page, route);
    // Let async data + ResizeObserver-driven chart heights settle — any late shift still counts.
    await page.waitForTimeout(2000);
    const cls = await page.evaluate(() => (window as { __cls?: number }).__cls ?? 0);
    expect(cls, `CLS on ${route} was ${cls.toFixed(4)} (budget ${BUDGET})`).toBeLessThan(BUDGET);
  });
}
