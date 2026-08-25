import { test, expect, type Page } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Студия «Оформление»: пользовательская тема поверх канона.
 *
 * Проверяется ровно то, что нельзя доказать юнит-тестом:
 *  • канон по умолчанию НЕ переопределяется (иначе все прочие гейты перестали бы быть авторитетными);
 *  • выбор доезжает до реальных вычисленных переменных документа, а не только до стора;
 *  • тема переживает перезагрузку И встаёт ДО первого кадра (как `.dark`, см. theme-fouc.spec);
 *  • «Сбросить» возвращает документ ровно к канону, не оставляя мёртвого <style>.
 */

const SETTINGS = '/settings?section=appearance';

const token = (page: Page, name: string) =>
  page.evaluate(
    (variable) => getComputedStyle(document.documentElement).getPropertyValue(variable).trim(),
    name,
  );

/** Открывает студию и ДОЖИДАЕТСЯ её панели: ленивый чанк настроек на холодном vite едет дольше
    дефолтного ожидания, и первый спек прогона иначе флейчит на пустой оболочке. */
const openStudio = async (page: Page, theme: 'light' | 'dark' = 'dark') => {
  await bootDemo(page, SETTINGS, { theme });
  await page
    .locator('[data-settings-section="appearance"]')
    .waitFor({ state: 'visible', timeout: 25_000 });
};

const pick = async (page: Page, label: string) => {
  await page
    .locator('[data-settings-section="appearance"] button', { hasText: new RegExp(`^${label}$`) })
    .first()
    .click();
};

test.describe('студия оформления', () => {
  test.beforeEach(async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-1440', 'студия не зависит от брейкпоинта');
  });

  test('по умолчанию канон не переопределяется ни одной переменной', async ({ page }) => {
    await openStudio(page);

    await expect(page.getByRole('heading', { name: 'Оформление' })).toBeVisible();
    expect(await page.locator('#pulse-appearance').count()).toBe(0);
    expect(await token(page, '--primary')).toBe('219 80% 68%');
  });

  test('выбор акцента, нейтрали, палитры и формы доезжает до документа', async ({ page }) => {
    await openStudio(page);

    await pick(page, 'Изумрудный');
    await pick(page, 'Нейтральная');
    await pick(page, 'Как акцент');
    await pick(page, '0');
    await pick(page, 'Моноширинный');

    // Акцент ведёт и роль primary у графиков (--chart-role-primary → --brand-iris).
    await expect.poll(() => token(page, '--primary')).toMatch(/^15[0-9](\.\d)? /);
    await expect.poll(() => token(page, '--chart-role-primary')).toMatch(/^15[0-9](\.\d)? /);
    // Нейтраль двигает ТОН, но не светлоту: тёмная карточка остаётся на 8%.
    expect(await token(page, '--card')).toBe('0 0% 8%');
    // Радиус пересчитывает всё семейство, а не только --radius.
    expect(await token(page, '--radius')).toBe('0rem');
    expect(await token(page, '--radius-xl')).toBe('calc(0rem + 8px)');
    expect(
      await page.evaluate(() => getComputedStyle(document.body).fontFamily),
    ).toContain('monospace');

    // Оценочные цвета остаются каноном — это семантика, а не вкус.
    expect(await token(page, '--brand-verdant')).toBe('147 45% 52%');
    expect(await token(page, '--brand-ember')).toBe('11 78% 62%');
  });

  test('тема переживает перезагрузку и встаёт до первого кадра', async ({ page }) => {
    await openStudio(page);
    await pick(page, 'Цветение');
    await expect.poll(() => page.locator('#pulse-appearance').count()).toBe(1);
    const chosen = await token(page, '--primary');

    // Приложение не грузим вовсе: если переменная уже применена, её мог поставить ТОЛЬКО
    // прерисовочный бутстрап из <head> (та же логика доказательства, что в theme-fouc.spec).
    await page.route('**/src/main.tsx*', (route) => route.abort());
    await page.goto('/', { waitUntil: 'commit' });

    await expect.poll(() => token(page, '--primary')).toBe(chosen);
    expect(await page.evaluate(() => document.getElementById('root')?.innerHTML ?? null)).toBe('');
  });

  test('«Сбросить» возвращает документ к канону и снимает <style>', async ({ page }) => {
    await openStudio(page);
    await pick(page, 'Терминал');
    await expect.poll(() => token(page, '--radius')).toBe('0rem');

    await page.getByRole('button', { name: 'Сбросить' }).click();

    await expect.poll(() => page.locator('#pulse-appearance').count()).toBe(0);
    expect(await token(page, '--primary')).toBe('219 80% 68%');
    expect(await token(page, '--radius')).toBe('0.25rem');
    expect(
      await page.evaluate(() => localStorage.getItem('pulse_appearance')),
    ).toBeNull();
  });
});
