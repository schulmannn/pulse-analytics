import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiError, apiGet } from '@/api/client';
import {
  redirectBrowserOnUnauthorized,
  shouldRedirectOnUnauthorized,
} from './authRedirect';

describe('shouldRedirectOnUnauthorized', () => {
  it('redirects a protected me refetch after its cookie expires', () => {
    expect(
      shouldRedirectOnUnauthorized({ status: 401 }, '/', false),
    ).toBe(true);
  });

  it('redirects a protected query 401 without depending on the ApiError class bundle', () => {
    expect(
      shouldRedirectOnUnauthorized({ status: 401 }, '/home', false),
    ).toBe(true);
  });

  it('redirects a mutation 401 (including logout) but leaves a 503 on the page', () => {
    expect(
      shouldRedirectOnUnauthorized({ status: 401 }, '/settings', false),
    ).toBe(true);
    expect(
      shouldRedirectOnUnauthorized({ status: 503 }, '/settings', false),
    ).toBe(false);
  });

  it('does not redirect login, demo, non-401 or unrelated errors', () => {
    expect(
      shouldRedirectOnUnauthorized({ status: 401 }, '/login', false),
    ).toBe(false);
    // Публичная страница приглашения сама спрашивает сессию: «её нет» — это ветка сценария,
    // а не истёкшая сессия. Редирект здесь ломал ссылку из письма.
    expect(
      shouldRedirectOnUnauthorized({ status: 401 }, '/invite', false),
    ).toBe(false);
    expect(
      shouldRedirectOnUnauthorized({ status: 401 }, '/home', true),
    ).toBe(false);
    expect(
      shouldRedirectOnUnauthorized({ status: 500 }, '/home', false),
    ).toBe(false);
    expect(
      shouldRedirectOnUnauthorized(new Error('offline'), '/home', false),
    ).toBe(false);
  });

  it('does not treat a revoked MoySklad/Metrika token as the end of our own session', () => {
    // data-роуты МойСклада/Метрики отвечают 401 + code, когда провайдер отверг сохранённый токен.
    // Сессия Atlavue жива: экран источника показывает «Переподключить», а не форму входа.
    expect(
      shouldRedirectOnUnauthorized({ status: 401, code: 'ms_token_revoked' }, '/sklad', false),
    ).toBe(false);
    expect(
      shouldRedirectOnUnauthorized({ status: 401, code: 'ym_token_revoked' }, '/metrika', false),
    ).toBe(false);
    // Главная с закреплённым виджетом источника — та же политика.
    expect(
      shouldRedirectOnUnauthorized({ status: 401, code: 'ym_token_revoked' }, '/home', false),
    ).toBe(false);
    expect(
      shouldRedirectOnUnauthorized({ status: 401, code: 'ms_token_revoked' }, '/', false),
    ).toBe(false);
  });

  it('keeps logging out on a 401 without a source-token code (session expiry)', () => {
    expect(
      shouldRedirectOnUnauthorized({ status: 401, code: undefined }, '/metrika', false),
    ).toBe(true);
    // Любой другой код (или код не строкой) — это НЕ исключение: список явный.
    expect(
      shouldRedirectOnUnauthorized({ status: 401, code: 'csrf' }, '/sklad', false),
    ).toBe(true);
    expect(
      shouldRedirectOnUnauthorized({ status: 401, code: 'ig_token_revoked' }, '/sklad', false),
    ).toBe(true);
    expect(
      shouldRedirectOnUnauthorized({ status: 401, code: 42 }, '/sklad', false),
    ).toBe(true);
    // Код источника не превращает в 401 чужой статус и не отменяет демо/публичные исключения.
    expect(
      shouldRedirectOnUnauthorized({ status: 403, code: 'ms_forbidden' }, '/sklad', false),
    ).toBe(false);
    expect(
      shouldRedirectOnUnauthorized({ status: 401, code: 'ms_token_revoked' }, '/login', false),
    ).toBe(false);
    expect(
      shouldRedirectOnUnauthorized({ status: 401 }, '/sklad', true),
    ).toBe(false);
  });

  it('reads the server body through apiGet: revoked source token stays, expired session leaves', async () => {
    // Тела — ровно те, что отдают sendMsError/sendYmError и requireAuth: код должен пережить
    // readApiError (ApiError.code), иначе исключение выше не сработает на живом ответе.
    const failWith = async (status: number, body: unknown): Promise<unknown> => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status })));
      try {
        return await apiGet('/api/any', z.unknown(), { channelId: 7 });
      } catch (error) {
        return error;
      } finally {
        vi.unstubAllGlobals();
      }
    };
    const ms = await failWith(401, { error: 'Токен отозван МойСкладом — переподключите источник', code: 'ms_token_revoked' });
    const ym = await failWith(401, { error: 'Токен отозван Яндексом — переподключите источник', code: 'ym_token_revoked' });
    const expired = await failWith(401, { error: 'Сессия истекла, войди снова' });
    expect(ms).toBeInstanceOf(ApiError);
    expect((ms as ApiError).code).toBe('ms_token_revoked');
    expect((ym as ApiError).code).toBe('ym_token_revoked');

    const assign = vi.fn();
    expect(redirectBrowserOnUnauthorized(ms, { pathname: '/sklad', demoMode: false, assign })).toBe(false);
    expect(redirectBrowserOnUnauthorized(ym, { pathname: '/metrika', demoMode: false, assign })).toBe(false);
    expect(assign).not.toHaveBeenCalled();
    expect(redirectBrowserOnUnauthorized(expired, { pathname: '/metrika', demoMode: false, assign })).toBe(true);
    expect(assign).toHaveBeenCalledOnce();
    expect(assign).toHaveBeenCalledWith('/login');
  });

  it('redirects direct browser fetches once and respects login/demo exemptions', () => {
    const assign = vi.fn();
    expect(
      redirectBrowserOnUnauthorized(
        { status: 401 },
        { pathname: '/settings', demoMode: false, assign },
      ),
    ).toBe(true);
    expect(assign).toHaveBeenCalledWith('/login');

    expect(
      redirectBrowserOnUnauthorized(
        { status: 401 },
        { pathname: '/login', demoMode: false, assign },
      ),
    ).toBe(false);
    expect(
      redirectBrowserOnUnauthorized(
        { status: 401 },
        { pathname: '/settings', demoMode: true, assign },
      ),
    ).toBe(false);
    expect(assign).toHaveBeenCalledOnce();
  });
});
