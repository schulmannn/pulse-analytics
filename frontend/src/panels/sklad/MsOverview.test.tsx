import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { MsOverview } from './MsOverview';

// Ветки ошибки Обзора склада. Сами запросы подменены: проверяется ровно то, что экран рисует по
// коду ошибки сервера (sendMsError), — редирект на /login это уже не решает (lib/authRedirect).
const summary = vi.hoisted(() => ({ state: null as unknown }));

vi.mock('@/api/ms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/ms')>();
  const idle = { isPending: true, isError: false, isFetching: false, data: undefined };
  return {
    ...actual,
    useMsSummary: () => summary.state,
    useMsFunnel: () => idle,
    useMsReturns: () => idle,
  };
});

function renderWithError(status: number, message: string, code?: string): string {
  const error = new ApiError(status, message);
  if (code) error.code = code;
  summary.state = { isPending: false, isError: true, isFetching: false, error, data: undefined, refetch: () => undefined };
  return renderToStaticMarkup(
    <MemoryRouter>
      <MsOverview />
    </MemoryRouter>,
  );
}

describe('MsOverview error states', () => {
  it('shows the reconnect CTA when the MoySklad token was revoked (401 ms_token_revoked)', () => {
    const html = renderWithError(401, 'Токен отозван МойСкладом — переподключите источник', 'ms_token_revoked');
    expect(html).toContain('Токен МойСклада отозван');
    expect(html).toContain('Переподключить МойСклад');
    // Сразу на карточку МойСклада, а не на Telegram по умолчанию; путь назван целиком, потому что
    // замены токена у подключённого источника нет — только «Отключить» и новое подключение.
    expect(html).toContain('href="/connect?source=moysklad"');
    expect(html).toContain('отключите старый и вставьте новый');
    expect(html).toContain('История продаж сохранится');
  });

  it('names missing employee rights on 403 ms_forbidden instead of asking to reconnect', () => {
    const html = renderWithError(
      403,
      'МойСклад отказал в доступе: у сотрудника, чей токен подключён, нет прав на эти данные',
      'ms_forbidden',
    );
    expect(html).toContain('Не хватает прав в МойСкладе');
    expect(html).not.toContain('отозван');
    expect(html).not.toContain('Переподключить');
  });

  it('on ms_forbidden names the MoySklad rights the dashboard reads and offers no dead-end /connect CTA', () => {
    const html = renderWithError(
      403,
      'МойСклад отказал в доступе: у сотрудника, чей токен подключён, нет прав на эти данные',
      'ms_forbidden',
    );
    // Что именно выдать сотруднику: то, что читает дашборд склада.
    for (const right of ['Показателей', 'Заказов покупателей', 'Возвратов покупателей', 'Контрагентов', 'Каналов продаж', 'Прибыльность', 'Остатки', 'себестоимость']) {
      expect(html).toContain(right);
    }
    expect(html).toContain('обновите страницу');
    // У подключённого МойСклада на /connect нет замены токена (только «Отключить») — ссылка туда
    // была тупиком. Никакой кнопки: чинится правами в МойСкладе, а не у нас.
    expect(html).not.toContain('Подключить другой токен');
    expect(html).not.toContain('href="/connect');
    expect(html).not.toContain('<a ');
  });

  it('does not dress up a code-less 401 (our session expired) as a revoked token', () => {
    const html = renderWithError(401, 'Сессия истекла, войди снова');
    expect(html).not.toContain('Токен МойСклада отозван');
    expect(html).toContain('Не удалось получить данные МойСклада');
    expect(html).toContain('Сессия истекла, войди снова');
  });

  it('keeps the onboarding state for a channel without a MoySklad token (404)', () => {
    const html = renderWithError(404, 'МойСклад не подключён');
    expect(html).toContain('Подключить МойСклад');
    expect(html).toContain('href="/connect?source=moysklad"');
  });
});
