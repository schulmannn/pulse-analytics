import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiSend } from './client';

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
