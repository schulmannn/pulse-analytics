import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, apiGet } from '@/api/client';
import { isSourceAccessCode, SOURCE_ACCESS_CODES } from '@/lib/authRedirect';
import { sourceErrorKind } from './sourceErrors';

const apiError = (status: number, code?: string, extra: { retryAfter?: number; network?: boolean } = {}) => {
  const error = new ApiError(status, 'x', extra.retryAfter);
  if (code) error.code = code;
  if (extra.network) error.network = true;
  return error;
};

describe('sourceErrorKind: отзыв токена в обеих формах', () => {
  it('нынешний 401 с кодом источника (sendMsError / sendYmError) → reauth', () => {
    expect(sourceErrorKind(apiError(401, 'ms_token_revoked'))).toBe('reauth');
    expect(sourceErrorKind(apiError(401, 'ym_token_revoked'))).toBe('reauth');
  });

  it('будущий 409 source_reauth единого sendSourceError → reauth', () => {
    expect(sourceErrorKind(apiError(409, 'source_reauth'))).toBe('reauth');
  });

  it('409 ig_reauth Instagram — тоже reauth', () => {
    expect(sourceErrorKind(apiError(409, 'ig_reauth'))).toBe('reauth');
  });

  it('разбор утиный: хватает {status, code}, класс ApiError не обязателен', () => {
    expect(sourceErrorKind({ status: 401, code: 'ms_token_revoked' })).toBe('reauth');
    expect(sourceErrorKind({ status: 409, code: 'source_reauth' })).toBe('reauth');
  });
});

describe('sourceErrorKind: не выдаёт нашу сессию и чужие отказы за источник', () => {
  it('401 без кода и с чужим кодом — наша сессия, не источник', () => {
    expect(sourceErrorKind(apiError(401))).toBeNull();
    expect(sourceErrorKind(apiError(401, 'csrf'))).toBeNull();
    expect(sourceErrorKind(apiError(401, 'ig_token_revoked'))).toBeNull();
  });

  it('403 без кода — права в воркспейсе, не источник; 403 ms_forbidden — права в МойСкладе', () => {
    expect(sourceErrorKind(apiError(403))).toBeNull();
    expect(sourceErrorKind(apiError(403, 'ms_forbidden'))).toBe('forbidden');
  });

  it('409 без кода, 400 без кода, дрейф схемы и не-объекты — null', () => {
    expect(sourceErrorKind(apiError(409))).toBeNull();
    expect(sourceErrorKind(apiError(400))).toBeNull();
    expect(sourceErrorKind(apiError(0))).toBeNull();
    expect(sourceErrorKind(new Error('boom'))).toBeNull();
    expect(sourceErrorKind('boom')).toBeNull();
    expect(sourceErrorKind(null)).toBeNull();
    expect(sourceErrorKind(undefined)).toBeNull();
  });
});

describe('sourceErrorKind: прочие состояния источника', () => {
  it('404 data-роута (makeResolveSourceChannel) и source_not_connected → not_connected', () => {
    expect(sourceErrorKind(apiError(404))).toBe('not_connected');
    expect(sourceErrorKind(apiError(404, 'source_not_connected'))).toBe('not_connected');
  });

  it('квота: 429, 503 с Retry-After (МС/Метрика сегодня) и код rate_limited', () => {
    expect(sourceErrorKind(apiError(429))).toBe('rate_limited');
    expect(sourceErrorKind(apiError(503, undefined, { retryAfter: 5 }))).toBe('rate_limited');
    expect(sourceErrorKind(apiError(503, 'rate_limited'))).toBe('rate_limited');
  });

  it('5xx без Retry-After, обрыв сети и коды недоступности → unavailable', () => {
    expect(sourceErrorKind(apiError(502))).toBe('unavailable');
    expect(sourceErrorKind(apiError(503))).toBe('unavailable');
    expect(sourceErrorKind(apiError(500))).toBe('unavailable');
    expect(sourceErrorKind(apiError(0, undefined, { network: true }))).toBe('unavailable');
    expect(sourceErrorKind(apiError(503, 'source_unavailable'))).toBe('unavailable');
    expect(sourceErrorKind(apiError(503, 'db_unavailable'))).toBe('unavailable');
  });

  it('bad_period — только по коду: 400 без кода у МойСклада бывает и не про период', () => {
    expect(sourceErrorKind(apiError(400, 'bad_period'))).toBe('bad_period');
  });
});

describe('allow-list 401-редиректа и словарь состояний согласованы', () => {
  it('всякий 401, который не разлогинивает, экран источника узнаёт как отзыв', () => {
    // Весь список, а не выборка: код, пропущенный мимо /login, но незнакомый словарю, оставил бы
    // экран без «Переподключить» — с «Повторить», который вернёт тот же отказ.
    expect(SOURCE_ACCESS_CODES.size).toBeGreaterThan(0);
    for (const code of SOURCE_ACCESS_CODES) {
      expect(isSourceAccessCode(code), code).toBe(true);
      expect(sourceErrorKind(apiError(401, code)), code).toBe('reauth');
    }
  });
});

describe('sourceErrorKind на живом ответе apiGet', () => {
  const failWith = async (status: number, body: unknown): Promise<unknown> => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));
    try {
      return await apiGet('/api/ms/summary', z.unknown(), { channelId: 7 });
    } catch (error) {
      return error;
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it('код переживает readApiError в обеих формах отзыва', async () => {
    const legacy = await failWith(401, { error: 'Токен отозван МойСкладом — переподключите источник', code: 'ms_token_revoked' });
    const unified = await failWith(409, { error: 'Токен отозван — переподключите источник', code: 'source_reauth', source: 'ms' });
    const session = await failWith(401, { error: 'Сессия истекла, войди снова' });
    expect(sourceErrorKind(legacy)).toBe('reauth');
    expect(sourceErrorKind(unified)).toBe('reauth');
    expect(sourceErrorKind(session)).toBeNull();
  });
});
