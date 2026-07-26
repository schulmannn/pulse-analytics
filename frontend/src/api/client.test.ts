import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, apiGet, apiSend } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ApiError retry metadata', () => {
  it('preserves JSON retry_after for protective backpressure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'Сейчас входит слишком много пользователей — попробуйте снова через минуту',
      retry_after: 60,
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '60' },
    })));

    await expect(apiSend('POST', '/api/tg/qr/start')).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      retryAfter: 60,
    });
  });

  it('keeps an ordinary 503 without retry metadata eligible for the cold-start retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'Сервис Telegram недоступен, попробуйте позже',
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })));

    await expect(apiSend('POST', '/api/tg/qr/start')).rejects.toMatchObject({
      name: 'ApiError',
      status: 503,
      retryAfter: undefined,
    });
  });
});

// В реальных инцидентах (упавший gateway, деплой, офлайн) сервер не присылает JSON с полем
// `error` — эти тесты закрепляют, что до ErrorState доходит человеческий русский текст, а не
// «502 Bad Gateway» / «Failed to fetch», и что отмена запроса не глотается обёрткой.
describe('api error humanization', () => {
  const AnySchema = z.object({}).passthrough();

  async function failGet(): Promise<ApiError> {
    try {
      await apiGet('/api/anything', AnySchema);
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError);
      return err as ApiError;
    }
    throw new Error('apiGet was expected to reject');
  }

  it('maps a non-JSON 502 to a human Russian message, not the status line', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' })),
    );
    const err = await failGet();
    expect(err.status).toBe(502);
    expect(err.message).toBe('Сервер временно недоступен — попробуйте позже');
    expect(err.message).not.toContain('Bad Gateway');
  });

  it('keeps the server-provided error message when the body carries one', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'Канал не найден' }, { status: 404 })),
    );
    const err = await failGet();
    expect(err.status).toBe(404);
    expect(err.message).toBe('Канал не найден');
  });

  // server/app.js отдаёт `{ error: 'internal_error' }` на любой необработанный 500 — токен нужен
  // логам/мониторингу, но пользователю обязан достаться русский текст, а не машинный код.
  it('never shows the internal_error token — falls back to the human 500 message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'internal_error', request_id: 'req-1' }, { status: 500 })),
    );
    const err = await failGet();
    expect(err.status).toBe(500);
    expect(err.message).toBe('Сервер временно недоступен — попробуйте позже');
    expect(err.message).not.toContain('internal_error');
  });

  it('hides the other machine codes the server emits (404 not_found, 403 csrf, 400 not_configured)', async () => {
    const cases = [
      { code: 'not_found', status: 404, human: 'Данные не найдены' },
      { code: 'csrf', status: 403, human: 'Нет доступа к этому разделу' },
      { code: 'not_configured', status: 400, human: 'Не удалось выполнить запрос (код 400)' },
      { code: 'session_decrypt_failed', status: 500, human: 'Сервер временно недоступен — попробуйте позже' },
    ];
    for (const { code, status, human } of cases) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: code }, { status })));
      const err = await failGet();
      expect(err.message).toBe(human);
      expect(err.message).not.toContain(code);
    }
  });

  it('keeps a human Russian 400 message untouched', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'Подключение Telegram по QR не настроено на сервере' }, { status: 400 })),
    );
    const err = await failGet();
    expect(err.status).toBe(400);
    expect(err.message).toBe('Подключение Telegram по QR не настроено на сервере');
  });

  it('still reads retry_after from a body whose error field is a machine code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ error: 'internal_error', retry_after: 30 }, { status: 500 })),
    );
    const err = await failGet();
    expect(err.retryAfter).toBe(30);
    expect(err.message).toBe('Сервер временно недоступен — попробуйте позже');
  });

  it('maps a bodyless 429 to a human message and still reads Retry-After', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 429, headers: { 'Retry-After': '7' } })),
    );
    const err = await failGet();
    expect(err.message).toBe('Слишком много запросов — попробуйте чуть позже');
    expect(err.retryAfter).toBe(7);
  });

  it('wraps a network failure into a retryable ApiError with a Russian message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const err = await failGet();
    expect(err.status).toBe(0);
    expect(err.network).toBe(true);
    expect(err.message).toBe('Нет соединения с сервером — проверьте интернет и попробуйте ещё раз');
    expect(err.message).not.toContain('Failed to fetch');
  });

  it('lets an aborted request propagate untouched so cancellation keeps working', async () => {
    const abort = new DOMException('The user aborted a request.', 'AbortError');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw abort;
      }),
    );
    await expect(apiGet('/api/anything', AnySchema)).rejects.toBe(abort);
  });
});
