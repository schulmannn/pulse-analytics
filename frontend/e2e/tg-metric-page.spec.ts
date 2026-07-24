import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Telegram «дополнительные» графики — полноэкранные /metrics/tg-*. Проверяем миграцию карточек
 * Аналитики (тепловая карта активности, скорость набора просмотров) с generic `?detail=` оверлея на
 * выделенные route-страницы (грамматика эталона /metrics/ig-views / /metrics/ym-visits): клик по
 * карточке ведёт на route (не role=dialog), прямой заход + reload держат TG-контекст, у скорости
 * есть Line/Bar (обе честны для накопительной кривой), у тепловой карты — своя heatmap-форма без
 * выдуманного Line/Bar/сравнения.
 *
 * Boot из client-side demo-фикстур (pulse_demo) — реальных Telegram-кредов в раннере нет.
 */

test.describe('Telegram extra-chart metric pages', () => {
  test('клик по «Тепловая карта активности» ведёт на /metrics/tg-heatmap (route, не модалка)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Аналитика — desktop-first поверхность');
    await bootDemo(page, '/analytics?tab=audience');

    await page.getByRole('heading', { name: 'Тепловая карта активности', exact: true }).click();

    await expect(page).toHaveURL(/\/metrics\/tg-heatmap$/);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Тепловая карта активности', level: 1 })).toBeVisible();

    // Назад-ссылка возвращает в Аналитику · Аудитория.
    await page.getByRole('link', { name: /Аналитика · Аудитория/ }).click();
    await expect(page).toHaveURL(/\/analytics/);
  });

  test('клик по «Скорость набора просмотров» ведёт на /metrics/tg-velocity (route, не модалка)', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Аналитика — desktop-first поверхность');
    await bootDemo(page, '/analytics?tab=dynamics');

    await page.getByRole('heading', { name: 'Скорость набора просмотров', exact: true }).click();

    await expect(page).toHaveURL(/\/metrics\/tg-velocity$/);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Скорость набора просмотров', level: 1 })).toBeVisible();
  });

  test('прямой заход /metrics/tg-heatmap + reload держит TG-контекст, без Line/Bar', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Аналитика — desktop-first поверхность');
    await bootDemo(page, '/metrics/tg-heatmap');

    await expect(page.getByRole('heading', { name: 'Тепловая карта активности', level: 1 })).toBeVisible();
    await expect(page.locator('[data-source-identity]')).toContainText('Telegram');
    // Heatmap — своя форма: никакого выдуманного селектора типа графика и никакого сравнения.
    await expect(page.getByRole('group', { name: 'Тип графика' })).toHaveCount(0);
    // Окно окна есть (heatmap пересобирается по окну).
    await expect(page.getByRole('group', { name: 'Окно' })).toBeVisible();

    await page.reload();
    await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
    await expect(page.getByRole('heading', { name: 'Тепловая карта активности', level: 1 })).toBeVisible();
    await expect(page.locator('[data-source-identity]')).toContainText('Telegram');
  });

  test('прямой заход /metrics/tg-velocity + reload держит TG-контекст, есть Line/Bar', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Аналитика — desktop-first поверхность');
    await bootDemo(page, '/metrics/tg-velocity');

    await expect(page.getByRole('heading', { name: 'Скорость набора просмотров', level: 1 })).toBeVisible();
    await expect(page.locator('[data-source-identity]')).toContainText('Telegram');
    // Накопительная кривая честна и линией, и столбцами → селектор типа графика есть.
    await expect(page.getByRole('group', { name: 'Тип графика' })).toBeVisible();
    // Bar-режим переключается без падения.
    await page.getByRole('group', { name: 'Тип графика' }).getByText('Столбцы').click();

    await page.reload();
    await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });
    await expect(page.getByRole('heading', { name: 'Скорость набора просмотров', level: 1 })).toBeVisible();
  });

  test('stale ?detail=<migrated-id> канонизируется в /metrics/tg-heatmap без dialog', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Аналитика — desktop-first поверхность');
    // Устаревший deep-link на generic оверлей мигрированной карточки должен увести на выделенный route.
    await bootDemo(page, '/analytics?tab=audience&detail=Тепловая карта активности');

    await expect(page).toHaveURL(/\/metrics\/tg-heatmap$/);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Тепловая карта активности', level: 1 })).toBeVisible();
  });
});

/**
 * Вторая волна миграции: остальные графики Аналитики (Compare / Hashtags / TgAnalytics
 * content·audience·dynamics) уходят с generic `?detail=` оверлея на выделенные /metrics/tg-* той же
 * грамматики. Разрезы — truthful rank-списки без выдуманного Line/Bar/сравнения; недельные/часовые —
 * категориальная серия, где Line честна (как в исходной карточке); прямой заход держит TG-контекст.
 */

/** Каждый новый route: term (h1) — точное название карточки-источника. */
const TG_ROUTES: { key: string; heading: string }[] = [
  { key: 'tg-weekday-reach', heading: 'Охват по дням недели' },
  { key: 'tg-format-views', heading: 'По форматам (просмотры)' },
  { key: 'tg-hashtag-erv', heading: 'Влияние хэштегов на ERV' },
  { key: 'tg-emoji', heading: 'Реакции по эмодзи' },
  { key: 'tg-engagement-mix', heading: 'Состав вовлечённости' },
  { key: 'tg-reach-by-type', heading: 'Ср. охват по типу' },
  { key: 'tg-erv-by-format', heading: 'Вовлечённость по формату' },
  { key: 'tg-views-by-source', heading: 'Просмотры по источникам' },
  { key: 'tg-followers-by-source', heading: 'Новые подписчики по источникам' },
  { key: 'tg-languages', heading: 'Языки аудитории' },
  { key: 'tg-sentiment', heading: 'Тональность реакций' },
  { key: 'tg-hours', heading: 'Активность по часам' },
  { key: 'tg-weekday-views', heading: 'По дням недели' },
  { key: 'tg-post-count', heading: 'Количество постов' },
  { key: 'tg-churn', heading: 'Динамика оттока' },
];

/** Категориальные серии (недельная/часовая ось) — Line честна, поэтому у них ЕСТЬ «Тип графика». */
const CATEGORY_KEYS = new Set(['tg-weekday-reach', 'tg-weekday-views', 'tg-post-count', 'tg-hours']);

test.describe('Telegram chart cards — вторая волна /metrics/tg-*', () => {
  for (const route of TG_ROUTES) {
    test(`прямой заход /metrics/${route.key} рендерит полноэкранно, TG-контекст, без dialog`, async ({ page }, testInfo) => {
      test.skip(testInfo.project.name !== 'desktop-1440', 'Аналитика — desktop-first поверхность');
      await bootDemo(page, `/metrics/${route.key}`);

      await expect(page.getByRole('heading', { name: route.heading, level: 1 })).toBeVisible();
      await expect(page.locator('[data-source-identity]')).toContainText('Telegram');
      // Никогда не generic-оверлей — это выделенный route.
      await expect(page.locator('[role="dialog"]')).toHaveCount(0);
      // Ни на одной странице нет фабрикованного сравнения периодов (нет контрола «База сравнения»).
      await expect(page.getByRole('group', { name: 'База сравнения' })).toHaveCount(0);

      if (CATEGORY_KEYS.has(route.key)) {
        // Категориальная серия — Line честна, «Тип графика» присутствует.
        await expect(page.getByRole('group', { name: 'Тип графика' })).toBeVisible();
      } else {
        // Разрез — truthful rank-список, никакого выдуманного выбора Line/Bar.
        await expect(page.getByRole('group', { name: 'Тип графика' })).toHaveCount(0);
      }
    });
  }

  test('клик по разрезу «Состав вовлечённости» ведёт на route, не открывает dialog', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Аналитика — desktop-first поверхность');
    await bootDemo(page, '/analytics?tab=content');

    await page.getByRole('heading', { name: 'Состав вовлечённости', exact: true }).click();

    await expect(page).toHaveURL(/\/metrics\/tg-engagement-mix/);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Состав вовлечённости', level: 1 })).toBeVisible();
    // Разрез — без выдуманного селектора типа графика.
    await expect(page.getByRole('group', { name: 'Тип графика' })).toHaveCount(0);
  });

  test('клик по «По дням недели» ведёт на категориальный route с честными Line/Bar', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Аналитика — desktop-first поверхность');
    await bootDemo(page, '/analytics?tab=audience');

    await page.getByRole('heading', { name: 'По дням недели', exact: true }).click();

    await expect(page).toHaveURL(/\/metrics\/tg-weekday-views/);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(page.getByRole('group', { name: 'Тип графика' })).toBeVisible();
    // Категориальная ось — но сравнения периодов нет (не времянка).
    await expect(page.getByRole('group', { name: 'База сравнения' })).toHaveCount(0);
    // Bar-режим переключается без падения.
    await page.getByRole('group', { name: 'Тип графика' }).getByText('Столбцы').click();
    await expect(page.getByRole('heading', { name: 'По дням недели', level: 1 })).toBeVisible();
  });

  test('stale ?detail=<мигрированная-карточка> канонизируется в /metrics/tg-engagement-mix без dialog', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'Аналитика — desktop-first поверхность');
    await bootDemo(page, '/analytics?tab=content&detail=Состав вовлечённости');

    await expect(page).toHaveURL(/\/metrics\/tg-engagement-mix/);
    await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Состав вовлечённости', level: 1 })).toBeVisible();
  });
});
