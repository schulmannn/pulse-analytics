import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

test('settings keeps one continuous category page at every shell breakpoint', async ({ page }) => {
  await bootDemo(page, '/settings');

  await expect(page.getByRole('heading', { name: 'Аккаунт', level: 2 })).toBeVisible();
  for (const heading of ['Профиль', 'Оформление', 'Безопасность']) {
    await expect(page.getByRole('heading', { name: heading, level: 3 })).toBeVisible();
  }

  const metrics = await page.evaluate(() => {
    const visible = (element: Element | null) => {
      if (!(element instanceof HTMLElement)) return false;
      return Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    };
    const category = document.querySelector<HTMLElement>('[data-settings-category="account"]');
    const firstSection = document.querySelector<HTMLElement>('[data-settings-section="account"]');
    const sectionHeader = firstSection?.querySelector<HTMLElement>(':scope > header');
    const sectionBody = firstSection?.querySelector<HTMLElement>(':scope > div');
    const categoryButtons = Array.from(
      document.querySelectorAll<HTMLElement>('[data-settings-category-trigger]'),
    );
    const dashboard = document.querySelector<HTMLElement>('[data-dashboard-scroll]');
    const categoryBox = category?.getBoundingClientRect();
    const headerBox = sectionHeader?.getBoundingClientRect();
    const bodyBox = sectionBody?.getBoundingClientRect();

    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dashboardOverflow: dashboard ? dashboard.scrollWidth - dashboard.clientWidth : 0,
      visibleH1: Array.from(document.querySelectorAll('h1')).filter(visible).length,
      categoryWidth: categoryBox?.width ?? 0,
      categoryButtonBoxes: categoryButtons.map((button) => {
        const box = button.getBoundingClientRect();
        return { left: box.left, right: box.right, height: box.height };
      }),
      activeCategories: categoryButtons.filter(
        (button) => button.getAttribute('aria-current') === 'page',
      ).length,
      oldRailCount: document.querySelectorAll('aside nav[aria-label="Разделы настроек"]').length,
      oldPickerCount: document.querySelectorAll(
        'button[aria-label^="Выбрать раздел настроек"]',
      ).length,
      sectionSplit:
        headerBox && bodyBox ? Math.abs(headerBox.top - bodyBox.top) <= 2 : false,
    };
  });

  expect(metrics.documentOverflow).toBeLessThanOrEqual(1);
  expect(metrics.dashboardOverflow).toBeLessThanOrEqual(1);
  expect(metrics.visibleH1).toBe(1);
  expect(metrics.categoryWidth).toBeLessThanOrEqual(961);
  expect(metrics.activeCategories).toBe(1);
  expect(metrics.oldRailCount).toBe(0);
  expect(metrics.oldPickerCount).toBe(0);
  expect(metrics.categoryButtonBoxes).toHaveLength(3);
  expect(metrics.categoryButtonBoxes.every((box) => box.height >= 44)).toBe(true);
  expect(metrics.categoryButtonBoxes.every((box) => box.left >= -1)).toBe(true);
  expect(
    metrics.categoryButtonBoxes.every((box) => box.right <= (page.viewportSize()?.width ?? 0) + 1),
  ).toBe(true);
  expect(metrics.sectionSplit).toBe(metrics.categoryWidth >= 768);
});

test('settings billing stacks plans before the expanded shell makes them cramped', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one CI worker owns the 900px regression');

  await page.setViewportSize({ width: 900, height: 900 });
  await page.addInitScript(() => localStorage.setItem('pulse_sidebar', 'open'));
  await bootDemo(page, '/settings?section=billing');

  await expect(page.getByRole('heading', { name: 'Рабочее пространство', level: 2 })).toBeVisible();
  for (const heading of ['Подписка', 'Команда', 'Данные']) {
    await expect(page.getByRole('heading', { name: heading, level: 3 })).toBeVisible();
  }

  const cards = await page
    .locator('[data-settings-section="billing"] [data-settings-plan-card]')
    .evaluateAll((elements) =>
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

test('all legacy section deep links open the right continuous category', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one project owns the URL matrix');

  const cases = [
    { section: 'account', category: 'Аккаунт', tab: 'Аккаунт', siblings: ['Профиль', 'Оформление', 'Безопасность'] },
    { section: 'appearance', category: 'Аккаунт', tab: 'Аккаунт', siblings: ['Профиль', 'Оформление', 'Безопасность'] },
    { section: 'security', category: 'Аккаунт', tab: 'Аккаунт', siblings: ['Профиль', 'Оформление', 'Безопасность'] },
    { section: 'billing', category: 'Рабочее пространство', tab: 'Пространство', siblings: ['Подписка', 'Команда', 'Данные'] },
    { section: 'team', category: 'Рабочее пространство', tab: 'Пространство', siblings: ['Подписка', 'Команда', 'Данные'] },
    { section: 'data', category: 'Рабочее пространство', tab: 'Пространство', siblings: ['Подписка', 'Команда', 'Данные'] },
    { section: 'channels', category: 'Подключения', tab: 'Подключения', siblings: ['Каналы', 'Instagram'] },
    { section: 'instagram', category: 'Подключения', tab: 'Подключения', siblings: ['Каналы', 'Instagram'] },
  ] as const;

  await bootDemo(page, `/settings?section=${cases[0].section}&keep=1`);
  for (const [index, item] of cases.entries()) {
    if (index > 0) {
      await page.goto(`/settings?section=${item.section}&keep=1`);
      await page.locator('main').waitFor({ state: 'visible' });
    }

    await expect(page.getByRole('heading', { name: item.category, level: 2 })).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Категории настроек' })
        .getByRole('button', { name: item.tab, exact: true }),
    ).toHaveAttribute('aria-current', 'page');
    for (const sibling of item.siblings) {
      await expect(page.getByRole('heading', { name: sibling, level: 3 })).toBeVisible();
    }
    await expect(page).toHaveURL(new RegExp(`[?&]section=${item.section}(?:&|$)`));
    await expect(page).toHaveURL(/[?&]keep=1(?:&|$)/);

    const target = page.locator(`[data-settings-section="${item.section}"]`);
    await expect(target).toBeVisible();
    await expect.poll(async () => (await target.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(55);
    await expect
      .poll(async () => (await target.boundingBox())?.y ?? Number.POSITIVE_INFINITY)
      .toBeLessThan(page.viewportSize()?.height ?? 900);
    if (item.section === 'instagram') {
      await page.waitForTimeout(600);
      await expect.poll(async () => (await target.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(55);
      await expect
        .poll(async () => (await target.boundingBox())?.y ?? Number.POSITIVE_INFINITY)
        .toBeLessThan(page.viewportSize()?.height ?? 900);
    }
  }

  await page.goto('/settings?section=unknown&keep=1');
  await expect(page.getByRole('heading', { name: 'Аккаунт', level: 2 })).toBeVisible();
  await expect.poll(() => new URL(page.url()).searchParams.get('section')).toBeNull();
  expect(new URL(page.url()).searchParams.get('keep')).toBe('1');
});

test('category navigation replaces settings history and focuses its destination', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one project owns the history contract');

  await bootDemo(page, '/home');
  await page.goto('/settings');
  const workspace = page
    .getByRole('navigation', { name: 'Категории настроек' })
    .getByRole('button', { name: 'Пространство', exact: true });
  await workspace.focus();
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL(/[?&]section=billing(?:&|$)/);
  await expect(page.getByRole('heading', { name: 'Рабочее пространство', level: 2 })).toBeFocused();
  await page.goBack();
  await expect(page).toHaveURL(/\/home$/);
});

test('deep-linked Instagram stays anchored while a delayed channel list expands above it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one project owns the async layout-shift case');

  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (pathname === '/api/config') {
      return route.fulfill({ json: { google_client_id: null } });
    }
    if (pathname === '/api/auth/me') {
      return route.fulfill({
        json: { uid: 7, email: 'user@example.com', role: 'user', avatar: null },
      });
    }
    if (pathname === '/api/channels' && request.method() === 'GET') {
      await new Promise((resolve) => setTimeout(resolve, 700));
      return route.fulfill({
        json: {
          enabled: true,
          selected: 1,
          channels: Array.from({ length: 14 }, (_, index) => ({
            id: index + 1,
            username: `collector_${index + 1}`,
            title: `Длинный канал ${index + 1}`,
            status: 'active',
            source: 'collector',
          })),
        },
      });
    }
    if (/^\/api\/channels\/\d+\/collector-status$/.test(pathname)) {
      return route.fulfill({ json: { status: null } });
    }
    if (/^\/api\/channels\/\d+\/keys$/.test(pathname)) {
      return route.fulfill({
        json: { keys: [{ id: 11, key_prefix: 'demo', label: 'collector', revoked: false }] },
      });
    }
    if (/^\/api\/channels\/\d+\/key$/.test(pathname) && request.method() === 'POST') {
      return route.fulfill({
        json: {
          id: 12,
          key_prefix: 'fresh',
          label: 'settings-ui',
          key: 'fresh_test_token',
          revoked: false,
        },
      });
    }
    if (pathname === '/api/ig/oauth/status') {
      return route.fulfill({
        json: {
          server_ready: true,
          env_fallback: false,
          connected: false,
          channel_id: 1,
          username: null,
          ig_user_id: null,
          connected_at: null,
          token_expires_at: null,
        },
      });
    }
    return route.fulfill({ status: 404, json: { error: 'not_available_in_test' } });
  });

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    const channelsResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/channels' && response.status() === 200,
    );
    await page.goto(`/settings?section=instagram&viewport=${viewport.width}`);
    const target = page.locator('[data-settings-section="instagram"]');
    await expect(target).toBeVisible();
    await channelsResponse;
    await expect(
      page.locator('[data-settings-section="channels"]').getByText('Длинный канал 14', {
        exact: true,
      }),
    ).toBeVisible();

    await expect.poll(async () => (await target.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(
      viewport.width >= 768 ? 55 : 0,
    );
    await expect
      .poll(async () => (await target.boundingBox())?.y ?? Number.POSITIVE_INFINITY)
      .toBeLessThan(viewport.height);

    if (viewport.width === 390) {
      const channels = page.locator('[data-settings-section="channels"]');
      await channels.getByRole('button', { name: 'API-ключи' }).first().click();
      const keyPanel = channels.locator('[data-settings-key-panel]');
      await expect(keyPanel.getByRole('button', { name: 'Создать ключ' })).toBeVisible();
      await keyPanel.getByRole('button', { name: 'Создать ключ' }).click();
      await expect(keyPanel.getByRole('button', { name: 'Копировать' })).toBeVisible();
      const touchTargetHeights = await keyPanel
        .locator('[data-mobile-touch-target]')
        .evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().height));
      expect(touchTargetHeights.length).toBeGreaterThanOrEqual(4);
      expect(touchTargetHeights.every((height) => height >= 44)).toBe(true);
    }

    const overflow = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      dashboard:
        (document.querySelector<HTMLElement>('[data-dashboard-scroll]')?.scrollWidth ?? 0) -
        (document.querySelector<HTMLElement>('[data-dashboard-scroll]')?.clientWidth ?? 0),
    }));
    expect(overflow.document).toBeLessThanOrEqual(1);
    expect(overflow.dashboard).toBeLessThanOrEqual(1);
  }
});

test('all categories stay stacked and overflow-free in narrow shell containers', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'one project owns the explicit viewport matrix');

  await page.addInitScript(() => {
    localStorage.setItem('pulse_sidebar', 'open');
    localStorage.setItem('pulse_plan', 'pro');
  });
  await page.setViewportSize({ width: 360, height: 800 });
  await bootDemo(page, '/settings');

  const viewports = [
    { width: 360, height: 800 },
    { width: 768, height: 1024 },
    { width: 900, height: 900 },
  ];
  const routes = [
    { path: '/settings', category: 'Аккаунт' },
    { path: '/settings?section=billing', category: 'Рабочее пространство' },
    { path: '/settings?section=channels', category: 'Подключения' },
  ];

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    for (const route of routes) {
      await page.goto(route.path);
      await expect(page.getByRole('heading', { name: route.category, level: 2 })).toBeVisible();
      const metrics = await page.evaluate(() => {
        const dashboard = document.querySelector<HTMLElement>('[data-dashboard-scroll]');
        const category = document.querySelector<HTMLElement>('[data-settings-category]');
        const firstSection = category?.querySelector<HTMLElement>('[data-settings-section]');
        const header = firstSection?.querySelector<HTMLElement>(':scope > header');
        const body = firstSection?.querySelector<HTMLElement>(':scope > div');
        const buttons = Array.from(
          document.querySelectorAll<HTMLElement>('[data-settings-category-trigger]'),
        ).map((button) => {
          const box = button.getBoundingClientRect();
          return { left: box.left, right: box.right, height: box.height };
        });
        return {
          documentOverflow:
            document.documentElement.scrollWidth - document.documentElement.clientWidth,
          dashboardOverflow: dashboard ? dashboard.scrollWidth - dashboard.clientWidth : 0,
          split:
            header && body
              ? Math.abs(header.getBoundingClientRect().top - body.getBoundingClientRect().top) <= 2
              : false,
          buttons,
        };
      });

      expect(metrics.documentOverflow).toBeLessThanOrEqual(1);
      expect(metrics.dashboardOverflow).toBeLessThanOrEqual(1);
      expect(metrics.split).toBe(false);
      expect(metrics.buttons.every((button) => button.height >= 44)).toBe(true);
      expect(metrics.buttons.every((button) => button.left >= -1)).toBe(true);
      expect(metrics.buttons.every((button) => button.right <= viewport.width + 1)).toBe(true);
    }
  }
});
