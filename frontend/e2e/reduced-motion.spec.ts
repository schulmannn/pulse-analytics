import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * prefers-reduced-motion gate. Every animation in the app is either hand-gated (targeted
 * `animation: none` rules / framer useReducedMotion on the landing) or neutralised by the global
 * safety net in index.css (0.01ms × 1 iteration). The observable invariant: with reduced motion
 * emulated, NOTHING is left running after the page settles — jiggle, shimmer, twinkle included.
 */

async function runningAnimations(page: Page): Promise<Array<{ name: string; state: string }>> {
  return page.evaluate(() =>
    document.getAnimations().map((a) => ({
      name:
        'animationName' in a
          ? String((a as CSSAnimation).animationName)
          : 'transitionProperty' in a
            ? `transition:${String((a as CSSTransition).transitionProperty)}`
            : a.constructor.name,
      state: a.playState,
    })).filter((a) => a.state === 'running'),
  );
}

test('reduced motion: dashboard settles with zero running animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await bootDemo(page, '/');
  const running = await runningAnimations(page);
  expect(running, `still animating under reduced motion: ${JSON.stringify(running)}`).toEqual([]);
});

test('reduced motion: chart marks and tooltip render in their final state', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await bootDemo(page, '/analytics');

  const chart = page.locator('svg[data-chart-kind="line"]').first();
  await chart.waitFor({ state: 'visible', timeout: 15_000 });
  const chartMotion = page.locator('[data-chart-motion]');
  const motionCount = await chartMotion.count();
  expect(motionCount).toBeGreaterThan(0);
  const markStyle = await chartMotion.first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { animationName: style.animationName, opacity: style.opacity, transform: style.transform };
  });
  expect(markStyle.animationName).toBe('none');
  expect(markStyle.opacity).toBe('1');
  expect(markStyle.transform).toBe('none');
  const sweepStyle = await chart.locator('g[data-chart-motion="sweep"]').first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { animationName: style.animationName, clipPath: style.clipPath };
  });
  expect(sweepStyle.animationName).toBe('none');
  expect(sweepStyle.clipPath).toBe('none');

  await chart.scrollIntoViewIfNeeded();
  const box = await chart.boundingBox();
  if (!box) throw new Error('chart svg has no box');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  const tooltip = page.locator('[data-chart-tooltip]');
  await expect(tooltip).toBeVisible();
  const tooltipStyle = await tooltip.evaluate((element) => {
    const style = getComputedStyle(element);
    return { animationName: style.animationName, transitionDuration: style.transitionDuration };
  });
  expect(tooltipStyle.animationName).toBe('none');
  expect(Number.parseFloat(tooltipStyle.transitionDuration)).toBeLessThanOrEqual(0.001);
});

test('reduced motion: home edit mode works and does not jiggle', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await bootDemo(page, '/home');
  const toggle = page.locator('button.edit-toggle');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(500); // let entry animations (if any leaked) start
  const running = await runningAnimations(page);
  expect(running, `edit mode animates under reduced motion: ${JSON.stringify(running)}`).toEqual([]);
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
});

test('reduced motion: public landing renders static (framer gated)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  // Logged-out = an explicit 401 from the me endpoint (offline without the stub the proxy 500s and
  // the app rightly shows the error state, not the landing).
  await page.route('**/api/auth/me', (r) =>
    r.fulfill({ status: 401, contentType: 'application/json', body: '{}' }),
  );
  await page.goto('/');
  await page.locator('main, h1').first().waitFor({ state: 'visible', timeout: 25_000 });
  await page.waitForTimeout(1500); // the autoplay hero would be mid-build by now if ungated
  const running = await runningAnimations(page);
  expect(running, `landing animates under reduced motion: ${JSON.stringify(running)}`).toEqual([]);
});

test('baseline sanity: without the preference the dashboard DOES animate on entry', async ({ page }) => {
  // Guards the gate itself: if getAnimations() were empty for structural reasons (e.g. the demo
  // simply has no animations), the three tests above would pass vacuously. Entry animations run
  // ~350ms — sample DURING boot, before the settle wait.
  await page.route('**/api/auth/me', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ uid: 999, email: 'demo@pulse.local', role: 'user', avatar: null }) }),
  );
  await page.addInitScript(() => {
    localStorage.setItem('pulse_demo', '1');
    localStorage.setItem('pulse_channel', '0');
  });
  await page.goto('/');
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
  const anims = await page.evaluate(() => document.getAnimations().length);
  expect(anims, 'expected entry animations while booting without reduced motion').toBeGreaterThan(0);
});
