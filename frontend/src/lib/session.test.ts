import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateLegacySession, purgeLegacySession } from './session';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  clear() {
    this.values.clear();
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemoryStorage());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('legacy cookie migration bootstrap', () => {
  it('sends the old token only to migrate-cookie and purges both keys', async () => {
    localStorage.setItem('pulse_token', 'old-browser-token');
    localStorage.setItem('pulse_token_exp', String(Date.now() + 60_000));
    const request = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', request);

    await expect(migrateLegacySession()).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith(
      '/api/auth/migrate-cookie',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        headers: expect.objectContaining({
          'X-Session-Token': 'old-browser-token',
        }),
      }),
    );
    expect(localStorage.getItem('pulse_token')).toBeNull();
    expect(localStorage.getItem('pulse_token_exp')).toBeNull();
  });

  it('does not send an expired token and still purges it', async () => {
    localStorage.setItem('pulse_token', 'expired');
    localStorage.setItem('pulse_token_exp', String(Date.now() - 1));
    const request = vi.fn();
    vi.stubGlobal('fetch', request);

    await expect(migrateLegacySession()).resolves.toBe(false);
    expect(request).not.toHaveBeenCalled();
    expect(localStorage.getItem('pulse_token')).toBeNull();
    expect(localStorage.getItem('pulse_token_exp')).toBeNull();
  });

  it('aborts a stalled bridge after five seconds and continues logged-out bootstrap', async () => {
    vi.useFakeTimers();
    localStorage.setItem('pulse_token', 'stalled');
    localStorage.setItem('pulse_token_exp', String(Date.now() + 60_000));
    vi.stubGlobal(
      'fetch',
      vi.fn((_path: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })),
    );

    const migration = migrateLegacySession();
    await vi.advanceTimersByTimeAsync(5000);
    await expect(migration).resolves.toBe(false);
    expect(localStorage.getItem('pulse_token')).toBeNull();
    expect(localStorage.getItem('pulse_token_exp')).toBeNull();
  });

  it('purge is idempotent', () => {
    localStorage.setItem('pulse_token', 'x');
    purgeLegacySession();
    purgeLegacySession();
    expect(localStorage.getItem('pulse_token')).toBeNull();
  });
});
