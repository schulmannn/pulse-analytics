import type { z } from 'zod';
import { getSelectedChannel } from '@/lib/channel';
import { isDemoMode } from '@/lib/demo';
import { demoFixture } from '@/lib/demoFixtures';

/** Thrown on non-2xx responses; metadata lets callers distinguish retryable backpressure. */
export class ApiError extends Error {
  status: number;
  retryAfter?: number;
  /** Запрос не дошёл до сервера (обрыв сети/DNS/офлайн) — ретраится как 5xx, см. main.tsx. */
  network?: boolean;
  constructor(status: number, message: string, retryAfter?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// Фолбэк, когда сервер не прислал собственное поле `error` (non-JSON тело: обрыв на прокси,
// 502/504 от gateway, HTML-страница ошибки). Эти сообщения через error.message попадают в
// ErrorState.reason по всему приложению — пользователь должен видеть русский текст, а не
// «502 Bad Gateway»; числовой код остаётся для баг-репортов.
function humanHttpMessage(status: number): string {
  if (status === 401) return 'Сессия истекла — войдите заново';
  if (status === 403) return 'Нет доступа к этому разделу';
  if (status === 404) return 'Данные не найдены';
  if (status === 429) return 'Слишком много запросов — попробуйте чуть позже';
  if (status >= 500) return 'Сервер временно недоступен — попробуйте позже';
  return `Не удалось выполнить запрос (код ${status})`;
}

// Часть ответов сервера несёт в `error` не текст для человека, а машинный код: он полезен в логах и
// мониторинге, но показывать его пользователю нельзя («internal_error» вместо «Сервер временно
// недоступен»). Явный список — то, что сервер реально отдаёт в HTTP-теле (app.js 404/500-хендлеры,
// authService csrf, routes/tg not_configured, generic-фолбэк 'error'); плюс общая форма
// snake_case-идентификатора, чтобы новый код с сервера не протёк в UI дословно. Русские
// (и любые содержащие пробел/заглавные/кириллицу) сообщения этой проверкой НЕ затрагиваются.
const MACHINE_ERROR_CODES = new Set([
  'internal_error',
  'not_found',
  'not_configured',
  'forbidden',
  'csrf',
  'error',
]);
const MACHINE_ERROR_SHAPE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

function isMachineErrorCode(value: string): boolean {
  return MACHINE_ERROR_CODES.has(value) || MACHINE_ERROR_SHAPE.test(value);
}

async function readApiError(res: Response): Promise<ApiError> {
  let message = humanHttpMessage(res.status);
  let retryAfter: number | undefined;
  try {
    const body = await res.json();
    // Машинный код оставляем серверу (логи/мониторинг), пользователю — фолбэк по статусу.
    if (body && typeof body.error === 'string' && !isMachineErrorCode(body.error)) message = body.error;
    const rawRetry = body && body.retry_after;
    const parsedRetry = rawRetry === '' || rawRetry == null ? NaN : Number(rawRetry);
    if (Number.isFinite(parsedRetry) && parsedRetry >= 0) retryAfter = parsedRetry;
  } catch {
    /* error body was not JSON — keep the human fallback */
  }
  if (retryAfter == null) {
    const rawHeader = res.headers.get('Retry-After');
    const header = rawHeader == null ? NaN : Number(rawHeader);
    if (Number.isFinite(header) && header >= 0) retryAfter = header;
  }
  return new ApiError(res.status, message, retryAfter);
}

/**
 * Per-request options threaded from the calling hook:
 * - `signal` — TanStack Query's AbortSignal, forwarded into fetch so cancelQueries()
 *   actually aborts the network request (not just ignores the result).
 * - `channelId` — the channel captured at render time by the hook (the same value baked
 *   into the query key). Passing it explicitly closes the race where a retry fired after
 *   a channel switch would read the NEW channel from the module singleton and cache
 *   channel-B data under channel-A's key. `undefined` = fall back to the singleton
 *   (non-channel endpoints / mutations); `null` = explicitly no channel header.
 */
export interface ApiOptions {
  signal?: AbortSignal;
  channelId?: number | null;
}

export type ApiWriteMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

function parseResponse<S extends z.ZodTypeAny>(
  method: string,
  path: string,
  schema: S,
  data: unknown,
): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    if (import.meta.env.DEV) console.warn('[api-drift]', method, path, result.error.issues);
    // Surface schema drift as a friendly ApiError, not a raw ZodError issue dump. status 0
    // marks it client-side: never retried (see the retry predicate) and never auth-handled.
    throw new ApiError(0, 'Формат данных не совпадает с ожидаемым');
  }
  return result.data;
}

// Обрыв сети / DNS / офлайн: fetch кидает TypeError с английским «Failed to fetch», и этот текст
// раньше доходил до ErrorState. Оборачиваем ТОЛЬКО TypeError: отмена запроса (AbortError от
// cancelQueries) обязана пробрасываться как есть, иначе TanStack Query перестанет её узнавать.
async function fetchApi(path: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(path, init);
  } catch (err) {
    if (err instanceof TypeError) {
      const error = new ApiError(0, 'Нет соединения с сервером — проверьте интернет и попробуйте ещё раз');
      error.network = true;
      throw error;
    }
    throw err;
  }
}

function buildHeaders(channelId: number | null): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (channelId != null) headers['X-Channel-Id'] = String(channelId);
  return headers;
}

/**
 * Typed GET against the existing Express API. Authentication is the same-origin
 * HttpOnly cookie carried by fetch; browser JavaScript never receives the token.
 * JSON is validated/narrowed through a Zod schema so no `any` leaks into panels.
 */
export async function apiGet<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  opts: ApiOptions = {},
): Promise<z.infer<S>> {
  // Demo mode: serve bundled sample data for covered endpoints; anything not covered (Instagram,
  // auth) falls through to the real server below.
  if (isDemoMode()) {
    const fixture = demoFixture(path);
    if (fixture !== undefined) return parseResponse('GET', path, schema, fixture);
  }
  const channelId = opts.channelId !== undefined ? opts.channelId : getSelectedChannel();
  const res = await fetchApi(path, {
    credentials: 'same-origin',
    headers: buildHeaders(channelId),
    signal: opts.signal,
  });
  if (!res.ok) {
    throw await readApiError(res);
  }
  const data: unknown = await res.json();
  return parseResponse('GET', path, schema, data);
}

/**
 * Typed write (POST/PATCH/DELETE) against the API. Same cookie auth as apiGet.
 * JSON body when provided; validates the response through the given Zod schema. Throws
 * ApiError (with .status + server `error` message) on non-2xx.
 */
export async function apiSend<S extends z.ZodTypeAny>(
  method: ApiWriteMethod,
  path: string,
  body: unknown,
  schema: S,
  opts: ApiOptions = {},
): Promise<z.infer<S>> {
  // No untyped overload by design: every successful write response crosses the same runtime
  // contract boundary as apiGet. A 204 becomes null and must be accepted explicitly by the
  // caller's schema instead of silently widening to unknown.
  // Demo mode is read-only: block writes (except auth, so login/logout still work) with a clear
  // message rather than silently no-op'ing or hitting the server.
  if (isDemoMode() && !path.startsWith('/api/auth/')) {
    throw new ApiError(400, 'Действие недоступно в демо-режиме');
  }
  const channelId = opts.channelId !== undefined ? opts.channelId : getSelectedChannel();
  const headers = buildHeaders(channelId);
  const init: RequestInit = { method, credentials: 'same-origin', headers, signal: opts.signal };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetchApi(path, init);
  if (!res.ok) {
    throw await readApiError(res);
  }
  const data: unknown = res.status === 204 ? null : await res.json().catch(() => null);
  return parseResponse(method, path, schema, data);
}
