import { expect, test } from '@playwright/test';
import { bootDemo, overflowingCards } from './helpers';

const CHANNEL_A = '16f07379-8039-11ec-0a80-03970021e97d';
const CHANNEL_B = '26f07379-8039-11ec-0a80-03970021e97e';
const CHANNEL_WITHOUT_CURRENT_SALES = '46f07379-8039-11ec-0a80-03970021e970';

test.beforeEach(({ page: _page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'MoySklad analytics is desktop-first');
});

test('metric controls survive reload and browser back while preserving the period query', async ({ page }) => {
  await bootDemo(
    page,
    '/metrics/ms-returns?p=90d&grain=week&chart=bar&metric=sum&compare=off',
    { theme: 'dark' },
  );

  const grain = page.getByRole('group', { name: 'Грануляция' });
  const chart = page.getByRole('group', { name: 'Тип графика' });
  const metric = page.getByRole('group', { name: 'Метрика возвратов' });
  const comparison = page.getByRole('group', { name: 'База сравнения' });

  await expect(grain.getByRole('button', { name: 'Неделя' })).toHaveAttribute('aria-pressed', 'true');
  await expect(chart.getByRole('button', { name: 'Столбцы' })).toHaveAttribute('aria-pressed', 'true');
  await expect(metric.getByRole('button', { name: 'Сумма' })).toHaveAttribute('aria-pressed', 'true');
  await expect(comparison.getByRole('button', { name: 'Выкл' })).toHaveAttribute('aria-pressed', 'true');
  expect(new URL(page.url()).searchParams.get('p')).toBe('90d');

  await page.reload();
  await expect(metric.getByRole('button', { name: 'Сумма' })).toHaveAttribute('aria-pressed', 'true');
  await expect(grain.getByRole('button', { name: 'Неделя' })).toHaveAttribute('aria-pressed', 'true');

  await metric.getByRole('button', { name: 'Число' }).click();
  await grain.getByRole('button', { name: 'Месяц' }).click();
  await comparison.getByRole('button', { name: 'Пред. период' }).click();
  const changed = new URL(page.url());
  expect(changed.searchParams.get('p')).toBe('90d');
  expect(changed.searchParams.get('grain')).toBe('month');
  expect(changed.searchParams.has('metric')).toBe(false);
  expect(changed.searchParams.has('compare')).toBe(false);

  await page.getByRole('link', { name: /МойСклад · Обзор/ }).click();
  await expect(page).toHaveURL(/\/sklad/);
  await page.goBack();
  await expect(page).toHaveURL(/\/metrics\/ms-returns/);
  await expect(grain.getByRole('button', { name: 'Месяц' })).toHaveAttribute('aria-pressed', 'true');
  expect(new URL(page.url()).searchParams.get('p')).toBe('90d');
  expect(await overflowingCards(page)).toEqual([]);
});

test('channel links canonicalize invalid selections and incompatible chart state', async ({ page }) => {
  const rawChannels = [CHANNEL_A, CHANNEL_A, 'not-a-channel', CHANNEL_B, CHANNEL_WITHOUT_CURRENT_SALES].join(',');
  await bootDemo(
    page,
    `/metrics/ms-channels?grain=month&chart=bar&metric=orders&view=breakdown&channels=${rawChannels}`,
    { theme: 'dark' },
  );

  await expect(page).toHaveURL(/\/metrics\/ms-channels/);
  const expectedChannels = `${CHANNEL_A},${CHANNEL_B},${CHANNEL_WITHOUT_CURRENT_SALES}`;
  await expect.poll(() => new URL(page.url()).searchParams.get('channels')).toBe(expectedChannels);
  const canonical = new URL(page.url()).searchParams;
  expect(canonical.get('grain')).toBe('month');
  expect(canonical.get('metric')).toBe('orders');
  expect(canonical.get('view')).toBe('breakdown');
  expect(canonical.has('chart')).toBe(false);

  await expect(page.getByRole('group', { name: 'Грануляция' }).getByRole('button', { name: 'Месяц' }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('group', { name: 'Метрика' }).getByRole('button', { name: 'Заказы' }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('group', { name: 'Вид' }).getByRole('button', { name: 'По каналам' }))
    .toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('group', { name: 'Тип графика' })).toHaveCount(0);

  const picker = page.getByRole('button', { name: 'Каналы: 3' });
  await picker.click();
  const channelGroup = page.getByRole('group', { name: 'Каналы продаж' });
  await expect(channelGroup.getByRole('checkbox', { name: 'Интернет-магазин' })).toBeChecked();
  await expect(channelGroup.getByRole('checkbox', { name: 'Партнёры' })).toBeChecked();
  await expect(channelGroup.getByRole('checkbox', { name: 'Недоступный канал · 46f07379' })).toBeChecked();

  await page.reload();
  await expect(page.getByRole('button', { name: 'Каналы: 3' })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('channels')).toBe(expectedChannels);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await overflowingCards(page)).toEqual([]);
});
