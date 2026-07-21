import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * IG feed period morph — the /instagram «Охват» hero must FLOW from one period shape into the next
 * (the same MorphingSeries contract the TG metric explorer + overview sparkline already pin), not
 * fall back into a full-page skeleton while the re-keyed ig-insights query loads.
 *
 * Regression: useIgInsights re-keys on every period change; without placeholderData the whole IG
 * shell swapped to <InstagramSkeleton /> (ig.loading), unmounting the chart — the morph engine
 * shipped in #309–#312 could never run on the IG feed. The delayed /api/ig/insights route below
 * reproduces the real network pause that made the skeleton visible in prod.
 */
test('instagram reach chart flows between periods without a skeleton swap', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop-only period-morph budget');
  await bootDemo(page, '/instagram');

  // Delay ONLY the period-triggered insights refetch (registered after bootDemo, so it takes
  // precedence; fallback() hands the request to the instant demo fixture underneath). 300ms is
  // enough for React Query to surface isPending — exactly the window where the old shell died.
  await page.route(/\/api\/ig\/insights/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fallback();
  });

  const reachCard = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Охват', exact: true }),
  });
  const chart = reachCard.locator('svg[data-chart-kind="line"]').first();
  await chart.waitFor({ state: 'visible', timeout: 15_000 });
  const primarySeries = chart.locator('[data-chart-series="primary"]');
  const morphGroup = chart.locator('g[data-chart-motion="morph"]').first();
  await expect(morphGroup).toHaveAttribute('data-chart-morph-state', 'idle');
  const morphNode = await morphGroup.elementHandle();
  if (!morphNode) throw new Error('reach morph group has no element handle');
  const oldPath = await primarySeries.getAttribute('d');
  if (!oldPath) throw new Error('reach path is empty before period change');

  // The IG feed defaults to 30д. Switch to 90д — the one preset with a COLD ig-insights cache:
  // «Неделя аккаунта» pre-fetches the 7/14-day keys at boot, so a 30→7 swap is always cache-warm
  // and never reproduced the skeleton regression. 30→90 forces the delayed refetch above.
  // Sample every browser frame so a fast polling client cannot miss the running state.
  const pagePeriod = page.getByRole('group', { name: 'Период', exact: true });
  await expect(pagePeriod.getByRole('button', { name: '30д' })).toHaveAttribute('aria-pressed', 'true');
  await chart.evaluate((svg) => {
    const state = window as unknown as {
      __igMorphFrames: Array<{ primary: string; state: string | null }>;
      __igMorphDone: boolean;
    };
    state.__igMorphFrames = [];
    state.__igMorphDone = false;
    const startedAt = performance.now();
    let sawRunning = false;
    const sample = () => {
      const group = svg.querySelector('g[data-chart-motion="morph"]');
      const primary = svg.querySelector('[data-chart-series="primary"]');
      const current = group?.getAttribute('data-chart-morph-state') ?? null;
      sawRunning = sawRunning || current === 'running';
      state.__igMorphFrames.push({
        primary: primary?.getAttribute('d') ?? '',
        state: current,
      });
      // Settle-aware horizon: sample until the morph that started has come back to idle (или 4с
      // cap — на нагруженном раннере 1500мс морф стартует с запозданием, и жёсткое окно резало
      // его mid-flight). Регрессионный кейс (морф не стартовал) закрывает cap.
      if (performance.now() - startedAt < 4000 && !(sawRunning && current === 'idle')) {
        requestAnimationFrame(sample);
      } else {
        state.__igMorphDone = true;
      }
    };
    requestAnimationFrame(sample);
  });
  await pagePeriod.getByRole('button', { name: '90д', exact: true }).click();
  // Ждём остановки сэмплера (settle либо cap), затем судим по собранным кадрам — так и зелёный,
  // и регрессионный прогон падают ИНФОРМАТИВНО (morphEvidence), а не generic-таймаутом.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __igMorphDone: boolean }).__igMorphDone), {
      timeout: 6_000,
    })
    .toBe(true);
  const frames = await page.evaluate(() => (window as unknown as {
    __igMorphFrames: Array<{ primary: string; state: string | null }>;
  }).__igMorphFrames);
  const finalPath = await primarySeries.getAttribute('d');
  // The load-bearing regression assertion: the SAME morph group element survived the period
  // change — the shell never swapped the view for the loading skeleton mid-refetch.
  const sameMorphNode = await morphGroup.evaluate((element, previousElement) => element === previousElement, morphNode);
  const morphEvidence = JSON.stringify({
    sameMorphNode,
    states: [...new Set(frames.map((frame) => frame.state))],
    distinctPaths: new Set(frames.map((frame) => frame.primary)).size,
    pathChanged: finalPath !== oldPath,
  });

  expect(sameMorphNode, morphEvidence).toBe(true);
  expect(frames.some((frame) => frame.state === 'running'), morphEvidence).toBe(true);
  expect(frames.at(-1)?.state).toBe('idle');
  expect(finalPath).not.toBe(oldPath);
  // Real interpolation happened: at least one sampled shape is neither the start nor the end.
  expect(frames.some((frame) => frame.primary.length > 0 && frame.primary !== oldPath && frame.primary !== finalPath), morphEvidence).toBe(true);
  expect(frames.at(-1)?.primary).toBe(finalPath);
  await expect(morphGroup).toHaveAttribute('data-chart-morph-state', 'idle');
});
