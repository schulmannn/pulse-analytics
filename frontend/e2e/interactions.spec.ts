import { test, expect, type Page } from '@playwright/test';
import { bootDemo } from './helpers';

const overviewOverlayCard = (page: Page) =>
  page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Лучшие публикации', exact: true }),
  });

test('detail open + back (metric drilldown)', async ({ page }) => {
  await bootDemo(page, '/');
  // A drillable KPI hero exposes an aria-label «Разбор: …»; clicking it opens the metric detail page.
  const drill = page.getByRole('button', { name: /^Разбор:/ }).first();
  await drill.waitFor({ state: 'visible', timeout: 15_000 });
  await drill.click();
  await expect(page).toHaveURL(/\/metrics\//);
  // the detail page renders its own content (a card / heading)
  await page.locator('section h3, h1, h2').first().waitFor({ timeout: 10_000 });
  await page.goBack();
  await expect(page).not.toHaveURL(/\/metrics\//);
});

test('whole-card click opens the detail overlay', async ({ page }) => {
  await bootDemo(page, '/');
  // Pick an overlay-owned card explicitly. The first Overview card drills to /metrics/views and is
  // intentionally a different interaction contract.
  await overviewOverlayCard(page).getByRole('heading', { name: 'Лучшие публикации' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  // …and it closes on Escape, leaving the card intact.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('detail overlay is URL-stated and closes on browser Back', async ({ page }) => {
  await bootDemo(page, '/');
  await overviewOverlayCard(page).getByRole('heading', { name: 'Лучшие публикации' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page).toHaveURL(/[?&]detail=/); // open pushed a shareable URL state
  await page.goBack();
  await expect(page.getByRole('dialog')).toHaveCount(0); // Back closes it
  await expect(page).not.toHaveURL(/[?&]detail=/);
});

test('chart hover: tooltip readout appears, moves and clears (single-svg hit-test)', async ({ page }) => {
  // The full breakdown charts (with the hover readout) live on /analytics now — the TG dashboard is
  // focused pages, so Обзор is a Sparkline-only summary. Previously this hit /' and relied on the
  // scroll-feed pre-mounting the Аналитика block below the short Overview.
  await bootDemo(page, '/analytics');
  // A series chart (LineChart exposes a named role=img svg). The svg itself is the hit surface —
  // hover derives the point index from the pointer x, no per-point rects.
  const chart = page.locator('svg[aria-label^="График:"]').first();
  await chart.waitFor({ state: 'visible', timeout: 15_000 });
  // mouse.move targets raw viewport coordinates and never auto-scrolls — bring the chart into
  // the viewport first, then read its box.
  await chart.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300); // settle the hover-clearing scroll listener
  const box = await chart.boundingBox();
  if (!box) throw new Error('chart svg has no box');
  const tooltip = page.locator('[data-chart-tooltip]');

  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5);
  await expect(tooltip.first()).toBeVisible();
  const early = (await tooltip.first().textContent()) ?? '';

  // A different x zone snaps to a different point — the readout follows (content may repeat on
  // flat series, so assert it stays visible rather than diffing text).
  await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.5);
  await expect(tooltip.first()).toBeVisible();
  expect(early.length).toBeGreaterThan(0);

  // Leaving the chart clears the readout (container mouseleave). The top-left corner is app
  // chrome on every viewport — guaranteed chart-free.
  await page.mouse.move(5, 5);
  await expect(tooltip).toHaveCount(0);
});

test('metric explorer gives the plot desktop space and exposes a hover inspector', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop-only metric explorer contract');
  await bootDemo(page, '/metrics/views', { theme: 'dark' });
  await expect(page.locator('[data-dashboard-topbar]')).toHaveCount(0);
  const mainBox = await page.locator('main').boundingBox();
  if (!mainBox) throw new Error('metric explorer main has no box');
  // The desktop explorer frame intentionally keeps a slim 10px outer inset; it must still start
  // at the viewport edge region rather than inheriting the regular dashboard top bar spacing.
  expect(mainBox.y).toBeLessThanOrEqual(12);
  const chart = page.locator('svg[data-chart-kind="line"][data-chart-expanded]').first();
  await chart.waitFor({ state: 'visible', timeout: 15_000 });
  await expect(chart).toHaveAttribute('data-chart-curve', 'smooth');
  await expect(chart).toHaveAttribute('data-chart-comparison', 'area');
  await expect(chart.locator('[data-chart-series="primary-area"]')).toHaveCount(1);
  await expect(chart.locator('[data-chart-series="comparison-area"]')).toHaveCount(1);
  await chart.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  const box = await chart.boundingBox();
  if (!box) throw new Error('metric explorer chart has no box');
  expect(box.height).toBeGreaterThanOrEqual(540);

  await page.mouse.move(box.x + box.width * 0.58, box.y + box.height * 0.5);
  const tooltip = page.locator('[data-chart-tooltip]');
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveAttribute('data-chart-tooltip-appearance', 'comparison');
  expect(await tooltip.locator('[data-chart-tooltip-row]').count()).toBeGreaterThanOrEqual(2);
  await expect(page.locator('[data-chart-crosshair]')).toHaveCount(1);
  await testInfo.attach('metric-explorer-dark-hover', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });

  await page.getByRole('button', { name: 'Тип графика: Столбцы' }).click();
  const bars = page.locator('svg[data-chart-kind="bar"][data-chart-expanded]').first();
  await expect(bars).toHaveAttribute('data-chart-comparison', 'stacked');
  expect(await bars.locator('path[data-chart-series="current"]').count()).toBeGreaterThan(1);
  expect(await bars.locator('path[data-chart-series="comparison"]').count()).toBeGreaterThan(1);
  const barBox = await bars.boundingBox();
  if (!barBox) throw new Error('metric explorer bar chart has no box');
  await page.mouse.move(barBox.x + barBox.width * 0.42, barBox.y + barBox.height * 0.5);
  await expect(tooltip).toBeVisible();
  await expect(tooltip).toHaveAttribute('data-chart-tooltip-appearance', 'comparison');
  expect(await tooltip.locator('[data-chart-tooltip-row]').count()).toBeGreaterThanOrEqual(2);
  await expect(page.locator('[data-chart-crosshair]')).toHaveCount(1);
  await testInfo.attach('metric-explorer-dark-stacked-hover', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });

  // Demo media endpoints intentionally return 404. Failed previews must resolve to a readable
  // media label instead of leaving browser-broken images in the contributor list.
  const contributors = page.locator('section').filter({
    has: page.getByRole('heading', { name: /Топ постов по/ }),
  }).first();
  await contributors.scrollIntoViewIfNeeded();
  await expect(contributors.locator('img[src*="/api/tg/mtproto/thumb/"]')).toHaveCount(0);
  await expect(contributors.getByText(/Фото|Видео/).first()).toBeVisible();
});

test('metric explorer redesign: cohesive chart card, comparison card, rank/pivot shells, pinned day', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop-only metric explorer contract');
  await bootDemo(page, '/metrics/views', { theme: 'dark' });

  // 1) Chart panel is ONE rounded card whose toolbar carries a VISIBLE title (no longer sr-only),
  //    the type switcher, the widget menu, and an integrated footer time-bar.
  const card = page.locator('[data-metric-chart-card]');
  await card.waitFor({ state: 'visible', timeout: 15_000 });
  const cardTitle = card.getByRole('heading', { name: 'По дням' });
  await expect(cardTitle).toBeVisible();
  await expect(card.getByRole('button', { name: 'Тип графика: Линия' })).toBeVisible();
  await expect(card.getByRole('button', { name: /^Меню виджета/ })).toBeVisible();
  const toolbar = card.locator('[data-metric-toolbar]');
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole('group', { name: 'Гранулярность' })).toBeVisible();
  await expect(toolbar.getByRole('group', { name: 'Период' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Свой диапазон' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Предыдущее окно' })).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'Следующее окно' })).toBeVisible();

  // 2) The comparison rail is a distinct analytical card leading with the current total.
  const comparison = page.locator('[data-rail-card="comparison"]');
  await expect(comparison).toBeVisible();
  await expect(comparison.getByText('Текущий период')).toBeVisible();
  await testInfo.attach('metric-explorer-redesign-chart-shell', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });

  // 3) Rank and Pivot restyle into shells consistent with the chart card.
  await card.getByRole('button', { name: 'Тип графика: Рейтинг' }).click();
  await expect(card.locator('[data-rank-chart]')).toBeVisible();
  await testInfo.attach('metric-explorer-redesign-rank', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
  await card.getByRole('button', { name: 'Тип графика: Сводная' }).click();
  await expect(card.locator('[data-pivot-table]')).toBeVisible();
  await testInfo.attach('metric-explorer-redesign-pivot', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });

  // 4) Clicking a line point opens the redesigned scoped detail card; close removes it.
  await card.getByRole('button', { name: 'Тип графика: Линия' }).click();
  const line = card.locator('svg[data-chart-kind="line"][data-chart-expanded]').first();
  await line.waitFor({ state: 'visible', timeout: 10_000 });
  await line.scrollIntoViewIfNeeded();
  const lineBox = await line.boundingBox();
  if (!lineBox) throw new Error('line chart has no box');
  await page.mouse.click(lineBox.x + lineBox.width * 0.5, lineBox.y + lineBox.height * 0.55);
  const pinned = page.locator('[data-pinned-day="detail"]');
  await expect(pinned).toBeVisible();
  await pinned.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await testInfo.attach('metric-explorer-redesign-pinned-day', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
  await pinned.getByRole('button', { name: 'Снять выделение точки' }).click();
  await expect(pinned).toHaveCount(0);
});

test('metric explorer redesign stays contained on mobile', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile-430', 'Mobile-only metric explorer contract');
  await bootDemo(page, '/metrics/views', { theme: 'light' });

  const card = page.locator('[data-metric-chart-card]');
  await expect(card).toBeVisible();
  await expect(card.getByRole('heading', { name: 'По дням' })).toBeVisible();
  await expect(card.locator('[data-metric-toolbar]')).toBeVisible();
  const cardBox = await card.boundingBox();
  if (!cardBox) throw new Error('metric chart card has no box');
  expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(430);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
  await testInfo.attach('metric-explorer-redesign-mobile-chart', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });

  await card.getByRole('button', { name: 'Тип графика: Сводная' }).click();
  await expect(card.locator('[data-pivot-table]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);

  const comparison = page.locator('[data-rail-card="comparison"]');
  await comparison.scrollIntoViewIfNeeded();
  await expect(comparison).toBeVisible();
  await testInfo.attach('metric-explorer-redesign-mobile-rail', {
    body: await page.screenshot({ fullPage: false }),
    contentType: 'image/png',
  });
});

test('chart drill guard: a scrub across the chart does not navigate', async ({ page }) => {
  // Seed a drillable line widget (tg.views has a metric page) pinned to Home so its chart's
  // point-click drills to /metrics/views. addInitScript stacks before bootDemo's own seed. A
  // press-drag-release SCRUB (drag-to-read) must NOT drill — the guard bails when the pointer
  // travelled >5px between press and release. (The clean-click DRILL path is covered by the KPI
  // hero test above; asserting it on this chart is fixture-fragile — the story-card hero span
  // overlaps the svg centre — so this test locks only the no-navigation-on-scrub half.)
  await page.addInitScript(() => {
    localStorage.setItem('pulse_home_blocks', JSON.stringify({ keys: ['custom:probe1'] }));
    localStorage.setItem('pulse_widget_configs', JSON.stringify([{ id: 'probe1', metricId: 'tg.views', viz: 'line' }]));
  });
  await bootDemo(page, '/home');
  const chart = page.locator('svg[aria-label^="График:"]').first();
  await chart.waitFor({ state: 'visible', timeout: 15_000 });
  await chart.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const box = await chart.boundingBox();
  if (!box) throw new Error('chart svg has no box');
  const y = box.y + box.height * 0.5;

  await page.mouse.move(box.x + box.width * 0.2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, y, { steps: 8 });
  await page.mouse.up();
  await expect(page).not.toHaveURL(/\/metrics\//);
});

test('edit-mode entry + exit (Home)', async ({ page }) => {
  await bootDemo(page, '/home');
  // The «Изменить»↔«Готово» toggle reflects edit state via aria-pressed — robust whether Home is
  // empty or has pinned widgets (the empty state carries its own «Добавить виджет» button, so that
  // label alone can't distinguish the modes).
  const toggle = page.locator('button.edit-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true'); // entered edit mode
  // Entering edit mode reveals the bottom «+ Добавить виджет» dock (targeted by class so the desktop
  // header's always-on Add button doesn't make the name ambiguous).
  await expect(page.locator('.add-widget-trigger')).toBeVisible();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false'); // exited
});

test('legacy Home cards use one config path and preserve old prefs during migration', async ({ page }) => {
  // The retired TG «Показатели» composite (`kpi`) is covered by its own desktop split test; this
  // asserts the remaining legacy composites still heal onto one config path (viewport-agnostic).
  const legacyKeys = ['growth', 'top-posts', 'history', 'velocity', 'heatmap', 'mentions'];
  await page.addInitScript((keys) => {
    localStorage.setItem('pulse_home_blocks', JSON.stringify({ keys }));
    localStorage.setItem('pulse_widget_configs', '[]');
    localStorage.setItem('pulse_widget_prefs', JSON.stringify({
      'home-history': {
        period: 90,
        size: 'full',
        title: 'Моя история',
        source: 17,
        color: 2,
        tinted: false,
        variant: 'bar-values',
      },
      'home-mentions': { hidden: true },
    }));
    localStorage.setItem('pulse_widget_order', JSON.stringify({
      home: ['home-velocity', 'home-history', 'home-growth', 'home-top-posts', 'home-heatmap', 'home-mentions'],
    }));
  }, legacyKeys);

  await bootDemo(page, '/home');

  const cardHeadings = page.locator('.home-board-canvas h3');
  await expect(cardHeadings).toHaveCount(legacyKeys.length);
  await expect(cardHeadings.filter({ hasText: 'Моя история' })).toHaveCount(1);

  await expect.poll(() => page.evaluate(() => {
    const configs = JSON.parse(localStorage.getItem('pulse_widget_configs') ?? '[]') as Array<{
      id: string;
      metricId: string;
      viz: string;
      period?: number;
      size?: string;
      title?: string;
      source?: number;
      style?: { color?: number; tinted?: boolean };
    }>;
    const history = configs.find((config) => config.id === 'legacy-history');
    return {
      legacyIds: configs.filter((config) => config.metricId.startsWith('legacy:')).map((config) => config.id).sort(),
      history,
      prefs: JSON.parse(localStorage.getItem('pulse_widget_prefs') ?? '{}'),
      order: JSON.parse(localStorage.getItem('pulse_widget_order') ?? '{}').home,
    };
  })).toEqual({
    legacyIds: legacyKeys.map((key) => `legacy-${key}`).sort(),
    history: {
      id: 'legacy-history',
      metricId: 'legacy:history',
      viz: 'bar',
      period: 90,
      size: 'full',
      title: 'Моя история',
      source: 17,
      style: { color: 2, tinted: false },
    },
    prefs: expect.objectContaining({
      'custom-legacy-mentions': expect.objectContaining({ hidden: true }),
    }),
    order: [
      'custom-legacy-velocity',
      'custom-legacy-history',
      'custom-legacy-growth',
      'custom-legacy-top-posts',
      'custom-legacy-heatmap',
      'custom-legacy-mentions',
    ],
  });
});

test('desktop Home splits the legacy Telegram «Показатели» composite into five independent cards', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-only Home KPI split');
  // Make FLIP deliberately much longer than its 400ms safety bound. The migration runs while the
  // old cards are mounted; even if transitionend is swallowed (for example in a background tab),
  // no displaced card may remain translated over the new KPI rows.
  await page.addInitScript(() => {
    window.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = ':root { --motion-glide: 10s !important; }';
      document.head.append(style);
    });
  });
  // A saved board with the composite between two other widgets, plus the composite's old per-card
  // prefs (period + source) that each split card must inherit.
  await page.addInitScript(() => {
    localStorage.setItem('pulse_home_blocks', JSON.stringify({ keys: ['week', 'kpi', 'growth'] }));
    localStorage.setItem('pulse_widget_configs', '[]');
    localStorage.setItem('pulse_widget_prefs', JSON.stringify({ 'home-kpi': { period: 90, source: 3, includeToday: false } }));
  });

  await bootDemo(page, '/home', { theme: 'dark' });

  // No full-width composite «Показатели» survives; the five metric cards render instead.
  await expect(page.getByRole('heading', { name: 'Показатели', exact: true })).toHaveCount(0);
  for (const title of ['Просмотры', 'Подписчики', 'Средний охват поста', 'Реакции', 'Вовлечённость (ER)']) {
    await expect(page.locator('.home-board-canvas').getByRole('heading', { name: title, exact: true })).toHaveCount(1);
  }

  const state = await page.evaluate(() => {
    const configs = JSON.parse(localStorage.getItem('pulse_widget_configs') ?? '[]') as Array<{
      id: string; metricId: string; viz: string; size?: string; period?: number; source?: number; includeToday?: boolean;
    }>;
    const byId = (id: string) => configs.find((c) => c.id === id);
    return {
      keys: JSON.parse(localStorage.getItem('pulse_home_blocks') ?? '{}').keys as string[],
      order: JSON.parse(localStorage.getItem('pulse_widget_order') ?? '{}').home as string[] | undefined,
      splitCount: configs.filter((c) => c.id.startsWith('home-kpi-')).length,
      hasLegacyKpi: !!byId('legacy-kpi'),
      views: byId('home-kpi-tg-views'),
      avgReach: byId('home-kpi-tg-avgReach'),
      er: byId('home-kpi-tg-er'),
    };
  });

  // The composite key is replaced IN PLACE by the five split keys — other widgets keep their slots.
  expect(state.keys).toEqual([
    'week',
    'custom:home-kpi-tg-views',
    'custom:home-kpi-tg-subscribers',
    'custom:home-kpi-tg-avgReach',
    'custom:home-kpi-tg-reactions',
    'custom:home-kpi-tg-er',
    'growth',
  ]);
  expect(state.splitCount).toBe(5);
  expect(state.hasLegacyKpi).toBe(false); // orphaned composite config removed
  // Inherited period + source from the old composite prefs.
  expect(state.views).toMatchObject({ metricId: 'tg.views', viz: 'line', size: 'half', period: 90, source: 3, includeToday: false });
  // S/M footprints preserved; the S series card is a bar (not a coerced-up line).
  expect(state.avgReach).toMatchObject({ metricId: 'tg.avgReach', viz: 'bar', size: 'third', period: 90, source: 3 });
  expect(state.er).toMatchObject({ metricId: 'tg.er', viz: 'kpi', size: 'third', period: 90, source: 3 });

  await page.waitForTimeout(500);
  const stranded = await page.locator('.home-board-canvas section').evaluateAll((sections) =>
    sections
      .map((section) => ({
        title: section.querySelector('h3')?.textContent?.trim() ?? '',
        transform: getComputedStyle(section).transform,
        gliding: section.getAttribute('data-gliding'),
      }))
      .filter((section) => section.transform !== 'none' || section.gliding !== null),
  );
  expect(stranded).toEqual([]);

  // Idempotent: a reload does not duplicate the cards or resurrect the composite.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Показатели', exact: true })).toHaveCount(0);
  const after = await page.evaluate(() => {
    const configs = JSON.parse(localStorage.getItem('pulse_widget_configs') ?? '[]') as Array<{ id: string }>;
    return {
      splitCount: configs.filter((c) => c.id.startsWith('home-kpi-')).length,
      keys: JSON.parse(localStorage.getItem('pulse_home_blocks') ?? '{}').keys as string[],
    };
  });
  expect(after.splitCount).toBe(5);
  expect(after.keys.filter((k) => k === 'kpi')).toHaveLength(0);

  // Each split card owns its own menu (independent per-widget controls).
  await expect(page.getByRole('button', { name: 'Меню виджета «Просмотры»' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Меню виджета «Реакции»' })).toHaveCount(1);
});

test('desktop Home KPI split avoids duplicating a metric already pinned', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-only Home KPI split');
  // tg.views is already pinned as a separate custom card → the split must not add a second views card.
  await page.addInitScript(() => {
    localStorage.setItem('pulse_home_blocks', JSON.stringify({ keys: ['custom:mine', 'kpi'] }));
    localStorage.setItem('pulse_widget_configs', JSON.stringify([{ id: 'mine', metricId: 'tg.views', viz: 'line' }]));
  });

  await bootDemo(page, '/home', { theme: 'dark' });

  const state = await page.evaluate(() => {
    const configs = JSON.parse(localStorage.getItem('pulse_widget_configs') ?? '[]') as Array<{ id: string; metricId: string }>;
    return {
      keys: JSON.parse(localStorage.getItem('pulse_home_blocks') ?? '{}').keys as string[],
      viewsConfigs: configs.filter((c) => c.metricId === 'tg.views').map((c) => c.id).sort(),
    };
  });
  // Only the pre-existing views card remains for tg.views — no `home-kpi-tg-views` duplicate.
  expect(state.viewsConfigs).toEqual(['mine']);
  // The other four split cards are inserted at the composite's slot; the user's card is untouched.
  expect(state.keys).toEqual([
    'custom:mine',
    'custom:home-kpi-tg-subscribers',
    'custom:home-kpi-tg-avgReach',
    'custom:home-kpi-tg-reactions',
    'custom:home-kpi-tg-er',
  ]);
});

test('edit toggle: compact expand chip on mobile, stable labelled tool on desktop', async ({ page }) => {
  await bootDemo(page, '/home');
  const slot = page.locator('.edit-toggle-slot');
  const toggle = page.locator('button.edit-toggle');
  const vw = page.viewportSize()!.width;

  if (vw < 768) {
    // Mobile (<md): the chip starts as a compact icon control, then expands on hover/focus/active
    // over a fixed reserved slot, so the header never reflows while the action breathes.
    const idleSlot = await slot.boundingBox();
    const idle = await toggle.boundingBox();
    expect(idleSlot && idle).toBeTruthy();
    expect(idle!.width).toBeLessThan(idleSlot!.width - 40);

    await toggle.hover();
    await page.waitForTimeout(260);
    const hoverSlot = await slot.boundingBox();
    const hover = await toggle.boundingBox();
    expect(hoverSlot && hover).toBeTruthy();
    expect(Math.abs(hoverSlot!.width - idleSlot!.width)).toBeLessThan(0.5);
    expect(hover!.width).toBeGreaterThan(idle!.width + 40);
    return;
  }

  // Desktop (md+): a stable, always-labelled tool — its width must NOT change on hover or when
  // toggled active, so the header layout never jumps.
  const idle = await toggle.boundingBox();
  expect(idle).toBeTruthy();
  await toggle.hover();
  await page.waitForTimeout(260);
  const hover = await toggle.boundingBox();
  expect(Math.abs(hover!.width - idle!.width)).toBeLessThan(0.5);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const active = await toggle.boundingBox();
  expect(Math.abs(active!.width - idle!.width)).toBeLessThan(0.5);
});

test.describe('home edit-mode board (calm inward step, flat canvas — no nested page-card)', () => {
  // Seed one pinned widget so the board grid (#home) renders at rest AND in edit — otherwise an empty
  // Home shows HomeEmptyState (no #home) until edit mode. Same seed shape the drill-guard test uses;
  // addInitScript stacks BEFORE bootDemo's own seed.
  const seedBoard = (page: Page) =>
    page.addInitScript(() => {
      localStorage.setItem('pulse_home_blocks', JSON.stringify({ keys: ['custom:probe1'] }));
      localStorage.setItem('pulse_widget_configs', JSON.stringify([{ id: 'probe1', metricId: 'tg.views', viz: 'line' }]));
    });

  test('board steps calmly inward in edit mode over a flat canvas (desktop)', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await seedBoard(page);
    await bootDemo(page, '/home');

    const board = page.locator('.home-board-canvas');
    const toggle = page.locator('button.edit-toggle');
    await board.waitFor({ state: 'visible', timeout: 15_000 });

    const restingWidth = (await board.boundingBox())!.width;

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    // The whole grid steps inward ~52px per side (≈104px total) — noticeable but calm.
    await expect.poll(async () => Math.round(restingWidth - (await board.boundingBox())!.width)).toBeGreaterThanOrEqual(90);
    const editingWidth = (await board.boundingBox())!.width;
    expect(restingWidth - editingWidth).toBeLessThanOrEqual(120);
    // Still ONE flat canvas — no grey surface / hairline frame wrapping the whole board (the inward
    // step is a pure max-width move; the element carries no background or border of its own).
    const surface = await board.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { background: cs.backgroundColor, border: cs.borderTopColor, borderWidth: cs.borderTopWidth };
    });
    expect(surface.background).toBe('rgba(0, 0, 0, 0)');
    expect(surface.borderWidth === '0px' || surface.border === 'rgba(0, 0, 0, 0)').toBeTruthy();
    // The mode is signalled by an sr-only status — no visible «Редактирование» row / grey divider.
    await expect(page.getByText('Редактирование', { exact: true })).toHaveCount(0);
    await expect(board.locator('p[role="status"]')).toHaveText('Режим редактирования доски');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // «Готово» reverts the grid exactly to its resting width.
    await expect.poll(async () => Math.round(Math.abs((await board.boundingBox())!.width - restingWidth))).toBeLessThanOrEqual(1);
  });

  for (const w of [360, 390, 430]) {
    test(`edit mode stays full-bleed with no h-overflow @ ${w}px`, async ({ page }) => {
      await page.setViewportSize({ width: w, height: 820 });
      await seedBoard(page);
      await bootDemo(page, '/home');

      const board = page.locator('.home-board-canvas');
      const toggle = page.locator('button.edit-toggle');
      await board.waitFor({ state: 'visible', timeout: 15_000 });
      const before = (await board.boundingBox())!.width;

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await page.waitForTimeout(120);
      // The board keeps its full width…
      const after = (await board.boundingBox())!.width;
      expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
      // …and edit mode introduces no horizontal page scroll.
      const hScroll = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(hScroll, `h-scroll ${hScroll}px in edit mode @ ${w}`).toBeLessThanOrEqual(1);
    });
  }
});

test('cards carry the muted default tint (tint is on by default)', async ({ page }) => {
  // A fresh, un-configured widget should render with the default --card-tint wash — the tint is now
  // on by default (a muted "noble" surface, not the old saturated brand-blue fallback). The tint is an
  // inline radial-gradient over hsl(--card); a card with tint OFF reports backgroundImage 'none'.
  await page.addInitScript(() => {
    localStorage.setItem('pulse_home_blocks', JSON.stringify({ keys: ['custom:tintprobe'] }));
    localStorage.setItem('pulse_widget_configs', JSON.stringify([{ id: 'tintprobe', metricId: 'tg.views', viz: 'line' }]));
  });
  await bootDemo(page, '/home');
  const surface = page.locator('section:has(h3)').first().locator('.bg-card').first();
  await surface.waitFor({ state: 'visible', timeout: 15_000 });
  const bg = await surface.evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(bg, 'un-configured card should carry the default gradient tint').toContain('gradient');
});
