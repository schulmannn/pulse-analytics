import type { z } from 'zod';
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
  if (token) headers['X-Session-Token'] = token;
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
