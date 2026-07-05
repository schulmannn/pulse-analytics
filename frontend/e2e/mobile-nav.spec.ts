import { test, expect } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Mobile one-thumb reachability (card «Mobile dashboard navigation»). At narrow widths the PRIMARY
 * dashboard controls — each widget's expand/menu icon buttons and the period filter pills — must be
 * ≥32px touch targets, and the page must never scroll horizontally. (Inline text links / ⓘ keep their
 * text size by design — their tap area is the text, and the same action has a full-size path in the
 * detail overlay.) Guards against the desktop-only tiny affordances the card calls out.
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
      check('button[aria-label^="Развернуть виджет"], button[aria-label^="Меню виджета"]', (e) => (e.getAttribute('aria-label') || '').slice(0, 24));
      check('[role="group"][aria-label="Период виджета"] button', (e) => `период ${(e.textContent || '').trim()}`);
      return { hScroll, tooSmall };
    }, MIN);
    expect(res.hScroll, `horizontal scroll ${res.hScroll}px at ${w}px`).toBeLessThanOrEqual(1);
    expect(res.tooSmall, `sub-32px primary controls at ${w}px: ${JSON.stringify(res.tooSmall)}`).toEqual([]);
  });
}
