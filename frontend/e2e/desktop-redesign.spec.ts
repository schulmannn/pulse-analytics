import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { bootDemo, overflowingCards } from './helpers';

test('desktop analytics exports current and equal-previous windows for both networks', async ({ page }) => {
  await bootDemo(page, '/analytics', { theme: 'dark' });
  await page.getByRole('group', { name: 'Период', exact: true }).getByRole('button', { name: '7д' }).click();

  let downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Экспорт метрик аналитики за выбранный период в CSV' }).click();
  const tgDownload = await downloadPromise;
  // Слаг транслитерирован: Chrome отбрасывает весь `download` с не-ASCII (см. slugify).
  expect(tgDownload.suggestedFilename()).toMatch(/^telegram-analytics-demo-kanal-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/);
  const tgPath = await tgDownload.path();
  if (!tgPath) throw new Error('Telegram analytics CSV has no local download path');
  const tgCsv = await readFile(tgPath, 'utf8');
  expect(tgCsv).toContain('network,source,section,scope,from,to,date,metric,value,unit');
  expect(tgCsv).toContain(',current,');
  expect(tgCsv).toContain(',previous,');
  expect(tgCsv).toContain('Просмотры канала');
  expect(tgCsv).not.toContain('Реакции');

  await page.goto('/instagram/analytics');
  await expect(page.getByRole('button', { name: 'Экспорт метрик аналитики за выбранный период в CSV' })).toBeEnabled();
  downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Экспорт метрик аналитики за выбранный период в CSV' }).click();
  const igDownload = await downloadPromise;
  expect(igDownload.suggestedFilename()).toMatch(/^instagram-analytics-demo-channel-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/u);
  const igPath = await igDownload.path();
  if (!igPath) throw new Error('Instagram analytics CSV has no local download path');
  const igCsv = await readFile(igPath, 'utf8');
  expect(igCsv).toContain(',current,');
  expect(igCsv).toContain(',previous,');
  expect(igCsv).toContain('Охват');
});

test('desktop analytics keeps source and summary hierarchy explicit', async ({ page }, testInfo) => {
  await bootDemo(page, '/analytics', { theme: 'dark' });

  const feed = page.locator('[data-feed-block="analytics"]');
  await expect(feed.locator('[data-source-identity]')).toContainText('Telegram · @demo_channel');
  await expect(feed.getByRole('heading', { name: 'Сводка показателей' })).toHaveCount(1);
  await expect(feed.getByText('Ср. просмотры', { exact: true })).toBeVisible();
  await expect(feed.getByText('Публикации', { exact: true })).toBeVisible();
  await expect(feed.getByText('Уведомления вкл.', { exact: true })).toHaveCount(0);

  const dynamicsShot = testInfo.outputPath('analytics-dynamics-dark.png');
  await page.screenshot({ path: dynamicsShot, fullPage: true });
  await testInfo.attach('analytics-dynamics-dark', { path: dynamicsShot, contentType: 'image/png' });

  await feed.getByRole('tab', { name: 'Форматы' }).click();
  await expect(feed.getByRole('tab', { name: 'Форматы' })).toHaveAttribute('aria-selected', 'true');
  await expect(feed.getByRole('heading', { name: 'Сводка показателей' })).toHaveCount(0);

  const analyticsShot = testInfo.outputPath('analytics-formats-dark.png');
  await page.screenshot({ path: analyticsShot, fullPage: true });
  await testInfo.attach('analytics-formats-dark', { path: analyticsShot, contentType: 'image/png' });
});

test('desktop feed shell is one flat canvas aligned with Home (no nested page-card)', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'desktop-only flat feed shell');
  await bootDemo(page, '/', { theme: 'dark' });

  const block = page.locator('section[data-feed-block]').first();
  await block.waitFor({ state: 'visible', timeout: 15_000 });

  // The feed section carries NO surface of its own — no rounded/bordered/bg card, no page padding.
  // The widgets below own the only card chrome, exactly like the personal Home board.
  const surface = await block.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      bg: cs.backgroundColor,
      borderTop: cs.borderTopWidth,
      borderLeft: cs.borderLeftWidth,
      padLeft: cs.paddingLeft,
      padRight: cs.paddingRight,
      padTop: cs.paddingTop,
    };
  });
  expect(surface.bg).toBe('rgba(0, 0, 0, 0)');
  expect(surface.borderTop).toBe('0px');
  expect(surface.borderLeft).toBe('0px');
  expect(surface.padLeft).toBe('0px');
  expect(surface.padRight).toBe('0px');
  expect(surface.padTop).toBe('0px');

  // Header title and body content share ONE left edge (the shared canvas) — nothing is inset by a
  // page-card wrapper.
  const titleBox = (await block.getByRole('heading', { name: 'Обзор', exact: true }).boundingBox())!;
  const firstCardBox = (await block.locator('section:has(h3)').first().boundingBox())!;
  expect(Math.abs(titleBox.x - firstCardBox.x)).toBeLessThanOrEqual(1);

  // …and that edge is the same one the personal Home header sits on (shared PAGE_HEADER_SHELL).
  await page.goto('/home');
  const homeTitle = page.getByRole('heading', { name: 'Главная', exact: true });
  await homeTitle.waitFor({ state: 'visible', timeout: 15_000 });
  const homeTitleBox = (await homeTitle.boundingBox())!;
  expect(Math.abs(titleBox.x - homeTitleBox.x)).toBeLessThanOrEqual(1);

  await page.goto('/');
  const shot = testInfo.outputPath('feed-shell-flat-dark.png');
  await page.screenshot({ path: shot, fullPage: true });
  await testInfo.attach('feed-shell-flat-dark', { path: shot, contentType: 'image/png' });
});

test('desktop Overview keeps period context compact', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'pulse_widget_order',
      JSON.stringify({ overview: ['overview-hero', 'overview-growth', 'overview-week', 'overview-top-posts'] }),
    );
  });
  await bootDemo(page, '/', { theme: 'dark' });

  await expect(page.locator('[data-source-identity]')).toContainText('Telegram · @demo_channel');
  // «Главное изменение» больше нет отдельной карточкой — она слита в «Неделю канала» (владелец:
  // «правый почти не несёт нагрузки»): медиана и лучшая публикация уехали в её леджер, разбор
  // причины — абзацем рассказа. Контекст периода на Обзоре теперь несёт именно она.
  await expect(page.getByRole('heading', { name: 'Неделя канала' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Главное изменение' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Меню виджета «Просмотры»' }).click();
  await page.getByRole('menuitem', { name: 'Изменить' }).click();
  const editor = page.getByRole('dialog', { name: 'Настройка виджета «Просмотры»' });
  await expect(editor.getByRole('button', { name: 'S', exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'M', exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'L', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await overflowingCards(page)).toEqual([]);

  // Owner override 2026-07-27: idle-подпись «по датам публикаций» под спарклайном убрана (лишняя
  // строка на лице карточки); карточки с графиком остаются.
  // Дискретные суточные метрики ведут СТОЛБЦАМИ (#461) — искра осталась вариантом, но не
  // дефолтом; гейт по-прежнему требует график на лице карточки, только другой формы.
  for (const card of ['Ср. охват', 'Реакции']) {
    const section = page.getByRole('heading', { name: card, exact: true }).locator('xpath=ancestor::section[1]');
    await expect(section.getByText('по датам публикаций')).toHaveCount(0);
    await expect(section.locator('svg[data-chart-kind="bar"]')).toBeVisible();
  }

  // «Вовлечённость» — БЕЗ искры, и это гейт, а не упущение. ER = вовлечение ÷ аудитория, а
  // аудитория за окно меняется на проценты против десятков раз у вовлечения, поэтому
  // нормализованная по min–max кривая ER повторяла кривую «Реакций» почти в точности (замер на
  // проде: корреляция 0.996). С 2026-08-14 карточка — центрированный стат (референс владельца);
  // формула-пояснение остаётся её нижней строкой.
  {
    const er = page.getByRole('heading', { name: 'Вовлечённость', exact: true }).locator('xpath=ancestor::section[1]');
    await expect(er.locator('svg[data-chart-kind="sparkline"]')).toHaveCount(0);
    await expect(er.getByText(/Реакции, репосты и комментарии/)).toBeVisible();
  }

  // Пилюля текущей (последней) метки оси X (владелец, 2026-08-14) — на оси спарка hero-карточки.
  {
    const hero = page.getByRole('heading', { name: 'Просмотры', exact: true }).locator('xpath=ancestor::section[1]');
    await expect(hero.locator('[data-axis-current]').first()).toBeVisible();
  }

  const compactTop = await page.getByRole('heading', { name: 'Ср. охват', exact: true }).evaluate((el) => el.closest('section')!.getBoundingClientRect().top);
  const narrativeTop = await page.getByRole('heading', { name: 'Неделя канала', exact: true }).evaluate((el) => el.closest('section')!.getBoundingClientRect().top);
  expect(compactTop).toBeLessThan(narrativeTop);

  const overviewShot = testInfo.outputPath('overview-dark.png');
  await page.screenshot({ path: overviewShot, fullPage: true });
  await testInfo.attach('overview-dark', { path: overviewShot, contentType: 'image/png' });
});

test('desktop Instagram Overview keeps the split KPI hierarchy intact', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'pulse_widget_order',
      JSON.stringify({ 'ig-overview': ['ig-overview-kpi', 'ig-overview-week', 'ig-overview-top-posts'] }),
    );
  });
  await bootDemo(page, '/instagram', { theme: 'dark' });

  await expect(page.locator('[data-source-identity]')).toContainText('Instagram · @demo_channel');
  for (const heading of ['Охват', 'Динамика аудитории', 'Просмотры', 'Взаимодействия', 'Вовлечённость']) {
    await expect(page.getByRole('heading', { name: heading, exact: true })).toBeVisible();
  }
  const audienceSection = page.getByRole('heading', { name: 'Динамика аудитории', exact: true }).locator('xpath=ancestor::section[1]');
  // Idle-подпись «по дням» убрана (владелец, 2026-07-27); сам спарклайн уровня базы остаётся.
  await expect(audienceSection.getByText('по дням')).toHaveCount(0);
  await expect(audienceSection.locator('svg[data-chart-kind="sparkline"]')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Неделя аккаунта' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Главное изменение' })).toBeVisible();
  expect(await overflowingCards(page)).toEqual([]);

  // Просмотры / Взаимодействия carry an active-window chart over the CANONICAL account daily
  // series — the old previous-period empty copy is gone (the chart never depends on prior-window
  // coverage).
  for (const card of ['Просмотры', 'Взаимодействия']) {
    const section = page.getByRole('heading', { name: card, exact: true }).locator('xpath=ancestor::section[1]');
    // Idle-подпись «по дням» убрана (владелец, 2026-07-27); график остаётся.
    await expect(section.getByText('по дням')).toHaveCount(0);
    // «Взаимодействия» — счётный поток, ведёт столбцами (#461); «Просмотры» — искрой.
    const kind = card === 'Взаимодействия' ? 'bar' : 'sparkline';
    await expect(section.locator(`svg[data-chart-kind="${kind}"]`)).toBeVisible();
    await expect(section.getByText('Нет данных за предыдущий период для сравнения.')).toHaveCount(0);
    await expect(section.getByText('Недостаточно дневных данных для графика.')).toHaveCount(0);
  }

  // «Вовлечённость» — центрированный стат БЕЗ графика (владелец, 2026-08-14; зеркало TG-гейта):
  // процент по центру, под ним сравнение с прошлым периодом, дневной ER остаётся на /metrics/ig-er.
  {
    const er = page.getByRole('heading', { name: 'Вовлечённость', exact: true }).locator('xpath=ancestor::section[1]');
    await expect(er.locator('svg[data-chart-kind="sparkline"]')).toHaveCount(0);
    await expect(er.locator('svg[data-chart-kind="bar"]')).toHaveCount(0);
    await expect(er.getByText('Взаимодействия к охвату аккаунта за период.')).toBeVisible();
  }

  const compactTop = await page.getByRole('heading', { name: 'Просмотры', exact: true }).evaluate((el) => el.closest('section')!.getBoundingClientRect().top);
  const narrativeTop = await page.getByRole('heading', { name: 'Неделя аккаунта', exact: true }).evaluate((el) => el.closest('section')!.getBoundingClientRect().top);
  expect(compactTop).toBeLessThan(narrativeTop);

  const overviewShot = testInfo.outputPath('instagram-overview-dark.png');
  await page.screenshot({ path: overviewShot, fullPage: true });
  await testInfo.attach('instagram-overview-dark', { path: overviewShot, contentType: 'image/png' });
});

test('desktop Instagram feed has one authoritative period and no card-local selectors', async ({ page }) => {
  await bootDemo(page, '/instagram', { theme: 'dark' });

  for (const route of ['/instagram', '/instagram/analytics']) {
    if (page.url().endsWith(route) === false) await page.goto(route);
    await expect(page.getByRole('group', { name: 'Период', exact: true })).toHaveCount(1);
    await expect(page.getByRole('toolbar', { name: 'Период виджета' })).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Период страницы' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Свой период' })).toBeVisible();
  }
});

test('desktop Home labels every mixed-source widget', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('pulse_home_blocks', JSON.stringify({ keys: ['kpi', 'ig-kpi'] }));
  });
  await bootDemo(page, '/home', { theme: 'dark' });

  const isDesktop = (page.viewportSize()?.width ?? 0) >= 768;
  const identities = page.locator('[data-source-identity]');
  if (isDesktop) {
    // Desktop splits the Telegram «Показатели» composite into five independent source-honest cards;
    // Instagram keeps its own «IG · Показатели» aggregate → five Telegram badges + one Instagram.
    await expect(identities).toHaveCount(6);
    await expect(identities.filter({ hasText: 'Telegram · @demo_channel' })).toHaveCount(5);
    await expect(identities.filter({ hasText: 'Instagram · @demo_channel' })).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Показатели', exact: true })).toHaveCount(0);
  } else {
    // Mobile keeps the legacy Telegram composite verbatim (the split is desktop-only).
    await expect(identities).toHaveCount(2);
    await expect(identities.filter({ hasText: 'Telegram · @demo_channel' })).toHaveCount(1);
    await expect(identities.filter({ hasText: 'Instagram · @demo_channel' })).toHaveCount(1);
    await expect(page.getByRole('heading', { name: 'Показатели', exact: true })).toHaveCount(1);
  }
  await expect(page.getByRole('heading', { name: 'IG · Показатели', exact: true })).toHaveCount(1);

  const homeShot = testInfo.outputPath('home-sources-dark.png');
  await page.screenshot({ path: homeShot, fullPage: true });
  await testInfo.attach('home-sources-dark', { path: homeShot, contentType: 'image/png' });
});
