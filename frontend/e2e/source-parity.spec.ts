import { expect, test } from '@playwright/test';
import { SOURCES } from './fixtures/sources';

/**
 * Паритет источников (программа унификации источников): одно свойство — один тест на каждый
 * источник из fixtures/sources, без своей ветки кода под источник. Расхождение между источниками
 * здесь становится красным тестом, а не находкой следующего аудита.
 *
 * Каркас PR 1.7 держит то, что верно уже сегодня: «Обзор» каждого источника несёт один
 * авторитетный период страницы с пресетами и ровно одним выбранным, KPI-карточку с числом и не
 * даёт горизонтальной прокрутки страницы.
 *
 * TODO(5.x): клик по карточке, по числу, по точке и ⋯ «Развернуть» ведут в один URL (путь +
 * p/from/to + канал) с одним итогом окна; reload и Back восстанавливают вид; уход на ленту без
 * параметров не сбрасывает окно; «Свой период» точен; пропуск — разрыв, а не 0; отзыв токена —
 * SourceAccessNotice с «Переподключить», а не /login; усечение подписано.
 */

const PRESETS = ['7д', '30д', '90д', 'Всё'];

for (const source of SOURCES) {
  test(`${source.label}: «Обзор» — один период страницы, KPI-карточка с числом, без горизонтальной прокрутки`, async ({
    page,
  }) => {
    await source.boot(page, source.overview);
    // Источник не подменился другим по дороге (редирект на чужую ленту прошёл бы проверки ниже).
    expect(new URL(page.url()).pathname).toBe(source.overview);

    const period = page.getByRole('group', { name: 'Период', exact: true });
    await expect(period).toHaveCount(1);
    for (const preset of PRESETS) {
      await expect(period.getByRole('button', { name: preset, exact: true })).toBeVisible();
    }
    await expect(period.locator('button[aria-pressed="true"]')).toHaveCount(1);

    // Крупное число KPI-карточки рисует общий KpiValue — у всех источников один и тот же узел.
    const kpi = page.locator('section[data-widget-size] [data-kpi-value]').first();
    await expect(kpi).toBeVisible({ timeout: 20_000 });
    await expect(kpi).toHaveText(/\d/);

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${source.overview}: страница прокручивается по горизонтали на ${overflow}px`).toBeLessThanOrEqual(1);
  });
}
