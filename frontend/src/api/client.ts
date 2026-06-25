import type { z } from 'zod';
import { getSelectedChannel } from '@/lib/channel';
import { getSessionToken } from '@/lib/session';

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
 * Typed GET against the existing Express API. Auth mirrors the legacy dashboard: the
 * HMAC session token lives in localStorage (shared with '/' — same origin) and is sent
 * as the `X-Session-Token` header (NOT a cookie). The JSON is then validated/narrowed
 * through a Zod schema so the return type is inferred — no `any` leaks into panels.
 */
export async function apiGet<S extends z.ZodTypeAny>(path: string, schema: S): Promise<z.infer<S>> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getSessionToken();
  const channelId = getSelectedChannel();
  if (token) headers['X-Session-Token'] = token;
  if (channelId != null) headers['X-Channel-Id'] = String(channelId);
  const res = await fetch(path, { credentials: 'same-origin', headers });
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
  return schema.parse(data);
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
): Promise<z.infer<S>>;
export async function apiSend(method: string, path: string, body?: unknown): Promise<unknown>;
export async function apiSend(
  method: string,
  path: string,
  body?: unknown,
  schema?: z.ZodTypeAny,
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = getSessionToken();
  const channelId = getSelectedChannel();
  if (token) headers['X-Session-Token'] = token;
  if (channelId != null) headers['X-Channel-Id'] = String(channelId);
  const init: RequestInit = { method, credentials: 'same-origin', headers };
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
  return schema ? schema.parse(data) : data;
}
