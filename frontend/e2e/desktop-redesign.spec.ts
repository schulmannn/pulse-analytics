import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { bootDemo, overflowingCards } from './helpers';

test('desktop analytics exports current and equal-previous windows for both networks', async ({ page }) => {
  await bootDemo(page, '/analytics', { theme: 'dark' });
  await page.getByRole('group', { name: 'Период', exact: true }).getByRole('button', { name: '7д' }).click();

  let downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Экспорт метрик аналитики за выбранный период в CSV' }).click();
  const tgDownload = await downloadPromise;
  expect(tgDownload.suggestedFilename()).toMatch(/^telegram-analytics-демо-канал-\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv$/u);
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

test('desktop Overview keeps period context compact', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'pulse_widget_order',
      JSON.stringify({ overview: ['overview-hero', 'overview-growth', 'overview-week', 'overview-top-posts'] }),
    );
  });
  await bootDemo(page, '/', { theme: 'dark' });

  await expect(page.locator('[data-source-identity]')).toContainText('Telegram · @demo_channel');
  await expect(page.getByRole('heading', { name: 'Главное изменение' })).toBeVisible();

  await page.getByRole('button', { name: 'Меню виджета «Просмотры»' }).click();
  await page.getByRole('menuitem', { name: 'Изменить' }).click();
  const editor = page.getByRole('dialog', { name: 'Настройка виджета «Просмотры»' });
  await expect(editor.getByRole('button', { name: 'S', exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'M', exact: true })).toBeVisible();
  await expect(editor.getByRole('button', { name: 'L', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  expect(await overflowingCards(page)).toEqual([]);
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
  await expect(page.getByRole('heading', { name: 'Неделя аккаунта' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Главное изменение' })).toBeVisible();
  expect(await overflowingCards(page)).toEqual([]);
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
    await expect(page.getByRole('group', { name: 'Период виджета' })).toHaveCount(0);
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
