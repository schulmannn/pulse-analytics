import { expect, test } from '@playwright/test';

/**
 * /ai — анатомия ответа по Astryx chat-кластеру: «Источники» под устоявшимся ответом
 * (Citation = живой drill: чип-ссылка на поверхность с теми же данными) + разворот в детали
 * вызовов с честными ошибками. Устоявшийся вид не требует SSE — рендер из персистентного
 * tool_trace (GET чата), поэтому стаб — обычные route-моки (boot без pulse_demo: клиентские
 * demo-фикстуры перехватывали бы сеть).
 */
test('ai answer shows linked sources with expandable call details', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-1440', 'Desktop-поверхность ассистента');
  await page.route(/^https?:\/\/[^/]+\/api\//, (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/auth/me') {
      return json(200, { uid: 1, email: 'owner@pulse.local', role: 'superuser', avatar: null, ai: { enabled: true } });
    }
    if (path === '/api/channels') return json(200, { enabled: true, channels: [{ id: 1, username: 'demo', title: 'Demo' }] });
    if (path === '/api/ai/chats/5') {
      return json(200, {
        chat: { id: 5, title: 'Как дела у канала?', created_at: new Date().toISOString() },
        messages: [
          { id: 1, role: 'user', content: 'Как дела у канала за неделю?' },
          {
            id: 2,
            role: 'assistant',
            content: 'Просмотры выросли на 12%, лучший день — воскресенье.',
            tool_trace: [
              { name: 'get_telegram_metrics', ok: true },
              { name: 'get_mentions_summary', ok: false, error: 'квота исчерпана' },
            ],
          },
        ],
      });
    }
    if (path === '/api/ai/chats') return json(200, { chats: [], usage: { used: 1, limit: 20 } });
    return json(404, { error: 'not_stubbed' });
  });
  await page.addInitScript(() => localStorage.setItem('pulse_theme', 'dark'));
  await page.goto('/ai/5');
  await page.locator('main').waitFor({ state: 'visible', timeout: 25_000 });

  // Ответ и «Источники»: успешный инструмент — чип-ссылка на свою поверхность.
  await expect(page.getByText('Просмотры выросли на 12%')).toBeVisible();
  const sourceChip = page.getByRole('link', { name: 'метрики Telegram' });
  await expect(sourceChip).toBeVisible();
  await expect(sourceChip).toHaveAttribute('href', '/analytics');

  // Ошибочный вызов не прячется: счётчик в кнопке, текст ошибки в развороте.
  const toggle = page.getByRole('button', { name: /Источники/ });
  await expect(toggle).toContainText('1 с ошибкой');
  await toggle.click();
  await expect(page.getByText('упоминания — квота исчерпана')).toBeVisible();

  // Чип-цитата действительно ведёт на поверхность с данными.
  await sourceChip.click();
  await expect(page).toHaveURL(/\/analytics$/);
});
