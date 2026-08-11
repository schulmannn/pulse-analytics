import { test, expect } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * The two motion-canon rules that live on shared primitives rather than on one surface:
 *  - a pressable control dips while held (`--motion-press`, scale 0.97);
 *  - an overlay leaves faster than it arrived (`--motion-exit` < the 150ms enter).
 * Both are asserted against COMPUTED style in a real browser — the CSS can compile and still lose a
 * specificity tie, which is exactly what a class-name assertion would miss.
 */

test('a pressed button dips and releases back', async ({ page }) => {
  await bootDemo(page, '/');

  // Демо-баннер всегда на месте в demo-режиме и несёт обычный Button (variant=secondary).
  const button = page.getByRole('button', { name: 'Выйти из демо' });
  await button.waitFor({ state: 'visible', timeout: 15_000 });

  const scaleOf = () =>
    button.evaluate((element) => getComputedStyle(element).scale);

  expect(await scaleOf()).toBe('none');

  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // 0.97 в обе оси; браузер сериализует как «0.97» либо «0.97 0.97».
  await expect.poll(scaleOf).toMatch(/^0\.97( 0\.97)?$/);

  // Отпускаем ВНЕ кнопки: полноценный клик по «Выйти из демо» размонтировал бы её вместе с
  // баннером, и проверять отпускание было бы уже не на чем.
  await page.mouse.move(box.x + box.width / 2, box.y - 120);
  await page.mouse.up();
  await expect.poll(scaleOf).toBe('none');
  await expect(button).toBeVisible();

  // Дип должен ехать на своей рунге, а не на дефолте Tailwind.
  const timing = await button.evaluate((element) => {
    const style = getComputedStyle(element);
    return { duration: style.transitionDuration, property: style.transitionProperty };
  });
  expect(timing.duration.split(',').every((part) => Number.parseFloat(part) === 0.14)).toBe(true);
  expect(timing.property).toContain('transform');
});

test('a link-styled button does not depress', async ({ page }) => {
  await bootDemo(page, '/');
  // `link` — это текст, а не нажимаемая поверхность: у него нет active-дипа даже под нажатием.
  const hasLinkDip = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, a')).some((element) =>
      element.className.toString().includes('underline-offset-4') &&
      element.className.toString().includes('active:scale-['),
    ),
  );
  expect(hasLinkDip).toBe(false);
});

test('an overlay leaves faster than it arrives', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'sidebar account menu is desktop chrome');
  await bootDemo(page, '/');

  await page.getByRole('button', { name: 'Аккаунт' }).click();
  const menu = page.getByRole('menu').first();
  await expect(menu).toBeVisible();

  const durationOf = () =>
    menu.evaluate((element) => Number.parseFloat(getComputedStyle(element).animationDuration));

  // Приход — дефолт tailwindcss-animate (150ms), он не трогался.
  expect(await durationOf()).toBeCloseTo(0.15, 2);

  // Уход — рунга --motion-exit. Radix держит узел смонтированным до animationend, так что
  // закрытое состояние успевает быть измеренным.
  await page.keyboard.press('Escape');
  await expect.poll(async () => {
    const closing = page.locator('[data-state="closed"][role="menu"]');
    if ((await closing.count()) === 0) return null;
    return closing.first().evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).animationDuration),
    );
  }).toBeCloseTo(0.12, 2);
});
