import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { YmOverview } from './YmOverview';

// Ветки ошибки Обзора Метрики. Запросы подменены: проверяется то, что экран рисует по коду ошибки
// сервера (sendYmError), — редирект на /login это уже не решает (lib/authRedirect).
const summary = vi.hoisted(() => ({ state: null as unknown }));

vi.mock('@/api/ym', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/ym')>();
  const idle = { isPending: true, isError: false, isFetching: false, data: undefined };
  return {
    ...actual,
    useYmSummary: () => summary.state,
    useYmGoals: () => idle,
    useYmHourly: () => idle,
  };
});

function renderWithError(status: number, message: string, code?: string): string {
  const error = new ApiError(status, message);
  if (code) error.code = code;
  summary.state = { isPending: false, isError: true, isFetching: false, error, data: undefined, refetch: () => undefined };
  return renderToStaticMarkup(
    <MemoryRouter>
      <YmOverview />
    </MemoryRouter>,
  );
}

describe('YmOverview error states', () => {
  it('shows the reconnect CTA when the Yandex token was revoked (401 ym_token_revoked)', () => {
    const html = renderWithError(401, 'Токен отозван Яндексом — переподключите источник', 'ym_token_revoked');
    expect(html).toContain('Токен Яндекса отозван');
    expect(html).toContain('Переподключить Метрику');
    expect(html).toContain('href="/connect?source=metrika"');
  });

  it('does not dress up a code-less 401 (our session expired) as a revoked token', () => {
    const html = renderWithError(401, 'Сессия истекла, войди снова');
    expect(html).not.toContain('Токен Яндекса отозван');
    expect(html).toContain('Не удалось получить данные Яндекс.Метрики');
    expect(html).toContain('Сессия истекла, войди снова');
  });

  it('keeps the onboarding state for a channel without a counter (404)', () => {
    const html = renderWithError(404, 'Метрика не подключена');
    expect(html).toContain('Подключить Метрику');
  });
});
