import { test, expect } from '@playwright/test';
import { bootDemo, overflowingCards } from './helpers';

// Routes that render the FULL widget set deterministically (independent of per-user pins): the whole
// focused TG feed — Overview, Analytics breakdowns, Posts, Mentions — plus the Reports index. This is
// the CONTENT-DENSITY contract gate (DESIGN_TOKENS «Content density»): every widget body must fit its
// fixed tile with no inner scroll/clip, so the whole feed reads at one predictable density. /home is
// per-user pin-dependent, so it is exercised only by the edit-mode interaction test, not here.
const ROUTES = [
  { path: '/', name: 'overview' },
  { path: '/analytics', name: 'analytics' },
  { path: '/posts', name: 'posts' },
  { path: '/mentions', name: 'mentions' },
  { path: '/reports', name: 'reports' },
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

// «Главная» is per-user, but the DEFAULT desktop board is deterministic: seed it via the
// empty-state action and hold it to the same density contract — the clipped-chart bug (a chart
// sized to the whole card body instead of its band) lived exactly on these hero-led cards.
test('no inner scrollbars — home (seeded defaults)', async ({ page }) => {
  test.skip((page.viewportSize()?.width ?? 0) < 768, 'desktop-only: autoseed exists only on the desktop empty board');
  await bootDemo(page, '/home');
  await page.getByRole('button', { name: 'Собрать по умолчанию' }).click();
  await page.locator('section h3').first().waitFor({ state: 'visible' });
  await page.waitForTimeout(800);
  const overflowing = await overflowingCards(page);
  expect(overflowing, `card bodies with an inner scrollbar on seeded /home: ${JSON.stringify(overflowing)}`).toEqual([]);
});

test('chart x-axis labels stay sparse and unrotated on compact charts', async ({ page }) => {
  await bootDemo(page, '/analytics');
  const audit = await page.evaluate(() => {
    const labels = [...document.querySelectorAll<HTMLElement | SVGTextElement>('[data-chart-axis-label]')]
      .filter((el) => {
        const text = (el.textContent || '').trim();
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return text && rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
      });

    const rotated = labels
      .filter((el) => (el.getAttribute('transform') || '').toLowerCase().includes('rotate'))
      .map((el) => (el.textContent || '').trim());

    const groups = new Map<Element, Array<{ text: string; rect: DOMRect }>>();
    for (const el of labels) {
      const owner = el.closest('svg') ?? el.parentElement;
      if (!owner) continue;
      const group = groups.get(owner) ?? [];
      group.push({ text: (el.textContent || '').trim(), rect: el.getBoundingClientRect() });
      groups.set(owner, group);
    }

    const overlaps: Array<{ a: string; b: string }> = [];
    for (const group of groups.values()) {
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const a = group[i];
          const b = group[j];
          const yOverlap = Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top);
          const xOverlap = Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left);
          const sameRow = yOverlap > Math.min(a.rect.height, b.rect.height) * 0.5;
          if (sameRow && xOverlap > 1) overlaps.push({ a: a.text, b: b.text });
        }
      }
    }

    return { count: labels.length, rotated, overlaps };
  });

  expect(audit.count).toBeGreaterThan(0);
  expect(audit.rotated, `rotated labels: ${JSON.stringify(audit.rotated)}`).toEqual([]);
  expect(audit.overlaps, `overlapping x-axis labels: ${JSON.stringify(audit.overlaps)}`).toEqual([]);
});
