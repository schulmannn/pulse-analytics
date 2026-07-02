import type { z } from 'zod';
import { getSelectedChannel } from '@/lib/channel';
import { getSessionToken } from '@/lib/session';
import { isDemoMode } from '@/lib/demo';
import { demoFixture } from '@/lib/demoFixtures';

/** Thrown on non-2xx responses; `status` lets callers special-case 401 etc. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
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

function buildHeaders(channelId: number | null): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getSessionToken();
  if (token) headers['X-Session-Token'] = token;
  if (channelId != null) headers['X-Channel-Id'] = String(channelId);
  return headers;
}

/**
 * Typed GET against the existing Express API. Auth mirrors the legacy dashboard: the
 * HMAC session token lives in localStorage (shared with '/' — same origin) and is sent
 * as the `X-Session-Token` header (NOT a cookie). The JSON is then validated/narrowed
 * through a Zod schema so the return type is inferred — no `any` leaks into panels.
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
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: buildHeaders(channelId),
    signal: opts.signal,
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      /* error body was not JSON — keep the status line */
    }
    throw new ApiError(res.status, message);
  }
  const data: unknown = await res.json();
  return parseResponse('GET', path, schema, data);
}

/**
 * Typed write (POST/PATCH/DELETE) against the API. Same auth as apiGet (X-Session-Token).
 * JSON body when provided; validates the response through the given Zod schema. Throws
 * ApiError (with .status + server `error` message) on non-2xx.
 */
export async function apiSend<S extends z.ZodTypeAny>(
  method: string,
  path: string,
  body: unknown,
  schema: S,
  opts?: ApiOptions,
): Promise<z.infer<S>>;
export async function apiSend(method: string, path: string, body?: unknown): Promise<unknown>;
export async function apiSend(
  method: string,
  path: string,
  body?: unknown,
  schema?: z.ZodTypeAny,
  opts: ApiOptions = {},
): Promise<unknown> {
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
  const res = await fetch(path, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const errBody = await res.json();
      if (errBody && typeof errBody.error === 'string') message = errBody.error;
    } catch {
      /* error body was not JSON */
    }
    throw new ApiError(res.status, message);
  }
  if (res.status === 204) return null;
  const data: unknown = await res.json().catch(() => null);
  return schema ? parseResponse(method, path, schema, data) : data;
}
