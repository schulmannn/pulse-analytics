import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { WidgetBody } from '@/components/ConfigWidget';
import type { WidgetConfig } from '@/lib/widgetConfig';

// Виджеты МойСклада и Метрики на Главной: отзыв токена — «Переподключить» в теле карточки, а не
// «сбой запроса, повторите». Запросы подменены: проверяется ровно то, что тело рисует по ошибке
// summary (useMs/YmWidgetData → SourceErrorState → sourceErrorKind).
const query = vi.hoisted(() => ({ ms: null as unknown, ym: null as unknown }));

vi.mock('@/api/ms', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/ms')>()),
  useMsSummary: () => query.ms,
}));
vi.mock('@/api/ym', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/ym')>()),
  useYmSummary: () => query.ym,
}));
vi.mock('@/lib/channel-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/channel-context')>()),
  useSelectedChannel: () => ({ channelId: 7, setChannelId: () => undefined }),
}));

function failed(status: number, message: string, code?: string) {
  const error = new ApiError(status, message);
  if (code) error.code = code;
  return { isPending: false, isError: true, isFetching: false, error, data: undefined, refetch: () => undefined };
}

function renderWidget(metricId: string): string {
  const config: WidgetConfig = { id: 'w1', metricId, viz: 'line' };
  return renderToStaticMarkup(
    <MemoryRouter>
      <WidgetBody config={config} />
    </MemoryRouter>,
  );
}

describe('Виджет МойСклада: ошибка summary', () => {
  it('отзыв токена в обеих формах → «Переподключить» вместо «Повторить»', () => {
    for (const state of [
      failed(401, 'Токен отозван МойСкладом — переподключите источник', 'ms_token_revoked'),
      failed(409, 'Токен отозван — переподключите источник', 'source_reauth'),
    ]) {
      query.ms = state;
      const html = renderWidget('ms.revenue');
      expect(html).toContain('Токен МойСклада отозван');
      expect(html).toContain('href="/connect?source=moysklad"');
      expect(html).not.toContain('Повторить');
      expect(html).not.toContain('это сбой запроса');
    }
  });

  it('403 ms_forbidden называет права, а не сбой запроса', () => {
    query.ms = failed(403, 'МойСклад отказал в доступе', 'ms_forbidden');
    const html = renderWidget('ms.orders');
    expect(html).toContain('Не хватает прав в МойСкладе');
    expect(html).not.toContain('Повторить');
  });

  it('прочий сбой — прежнее «Не удалось загрузить» с повтором', () => {
    query.ms = failed(502, 'МойСклад недоступен');
    const html = renderWidget('ms.revenue');
    expect(html).toContain('Не удалось загрузить');
    expect(html).toContain('это сбой запроса, а не пустой период');
    expect(html).toContain('Повторить');
  });
});

describe('Виджет Метрики: ошибка summary', () => {
  it('отзыв токена в обеих формах → «Переподключить» вместо «Повторить»', () => {
    for (const state of [
      failed(401, 'Токен отозван Яндексом — переподключите источник', 'ym_token_revoked'),
      failed(409, 'Токен отозван — переподключите источник', 'source_reauth'),
    ]) {
      query.ym = state;
      const html = renderWidget('ym.visits');
      expect(html).toContain('Токен Яндекса отозван');
      expect(html).toContain('href="/connect?source=metrika"');
      expect(html).not.toContain('Повторить');
    }
  });

  it('401 без кода — не отзыв: прежнее «Не удалось загрузить» (сессию уводит authRedirect)', () => {
    query.ym = failed(401, 'Сессия истекла, войди снова');
    const html = renderWidget('ym.visits');
    expect(html).toContain('Не удалось загрузить');
    expect(html).not.toContain('отозван');
  });
});
