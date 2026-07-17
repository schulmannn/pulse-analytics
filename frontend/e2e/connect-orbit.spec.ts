import { expect, test } from '@playwright/test';
import { bootDemo } from './helpers';

/**
 * Орбита /connect: узлы источников обязаны раскладываться без наездов друг на друга при ЛЮБОМ
 * их числе. Регресс: жёсткий шаг π/4 (сетка на 8) с девятым источником (МойСклад) клал Facebook
 * (i=8 → 2π) ровно под Telegram (i=0) — прод-фидбек владельца.
 */
test('connect orbit spreads all source nodes without overlap', async ({ page }) => {
  // Вход-анимация орбов разлетается из центра — замер в полёте дал бы флаки; дизайн гасит motion
  // под prefers-reduced-motion, этим и пользуемся.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await bootDemo(page, '/connect');
  const dots = page.locator('button[data-dot]');
  await expect(dots.first()).toBeVisible();
  const count = await dots.count();
  expect(count).toBeGreaterThanOrEqual(9);

  const centers: Array<{ x: number; y: number }> = [];
  let size = 0;
  for (let i = 0; i < count; i++) {
    const b = await dots.nth(i).boundingBox();
    expect(b, `узел ${i} без boundingBox`).not.toBeNull();
    if (!b) return;
    centers.push({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
    size = Math.max(size, b.width);
  }
  for (let i = 0; i < centers.length; i++) {
    for (let j = i + 1; j < centers.length; j++) {
      const dist = Math.hypot(centers[i].x - centers[j].x, centers[i].y - centers[j].y);
      // Минимум — диаметр узла: соседи могут стоять плотно, но не перекрываться.
      expect(dist, `узлы ${i} и ${j} наезжают: ${Math.round(dist)}px при узле ${size}px`).toBeGreaterThan(size);
    }
  }
});
