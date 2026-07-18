import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

test.beforeEach(async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'MoySklad analytics is desktop-first');
  // Deep-link straight into the ?detail= overlay of the revenue card — the exact path a user hits
  // when opening «Развернуть» on МойСклад → Обзор → Выручка.
  await bootDemo(page, '/sklad?detail=ms-revenue', { theme: 'dark' });
});

test('MoySklad revenue detail opens the shared rich explorer with working controls', async ({ page }, testInfo) => {
  const dialog = page.getByRole('dialog', { name: 'График: Выручка' });
  await expect(dialog).toBeVisible();

  // Tier-2 rich explorer — the SHARED overlay used by Telegram/Instagram and the MS channels chart,
  // not a mere enlarged compact card: it carries period, grain and line/bar controls.
  const windowGroup = dialog.getByRole('group', { name: 'Окно', exact: true });
  await expect(windowGroup).toBeVisible();
  const grainGroup = dialog.getByRole('group', { name: 'Грануляция' });
  await expect(grainGroup).toBeVisible();
  const kindGroup = dialog.getByRole('group', { name: 'Тип графика' });
  await expect(kindGroup).toBeVisible();

  // Seeded from the authoritative top-bar window (30д), not the overlay's 90д fallback.
  await expect(windowGroup.getByRole('button', { name: '30д' })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByText('за 30 дн.')).toBeVisible();
  await expect(dialog.locator('svg[data-chart-kind="line"]')).toBeVisible();

  // The period control fetches/uses the SELECTED window instead of reusing the original top-bar
  // payload. Waiting for the exact request makes this an architectural assertion, not only a label.
  const request90 = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === '/api/ms/summary' && url.searchParams.get('days') === '90';
  });
  await windowGroup.getByRole('button', { name: '90д' }).click();
  await request90;
  await expect(windowGroup.getByRole('button', { name: '90д' })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByText('за 90 дн.')).toBeVisible();

  // Grain control works (день → месяц).
  await grainGroup.getByRole('button', { name: 'Месяц' }).click();
  await expect(grainGroup.getByRole('button', { name: 'Месяц' })).toHaveAttribute('aria-pressed', 'true');

  // Line ↔ bar switch works.
  await kindGroup.getByRole('button', { name: 'Тип графика: Столбцы' }).click();
  await expect(dialog.locator('svg[data-chart-kind="bar"]')).toBeVisible();

  const shot = testInfo.outputPath('moysklad-revenue-explorer-dark.png');
  await page.screenshot({ path: shot, fullPage: true });
  await testInfo.attach('moysklad-revenue-explorer-dark', { path: shot, contentType: 'image/png' });
});
