import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTH_PROBE_TIMEOUT_MS,
  DEMO_ME,
  authGateInitialState,
  parseMe,
  probeMe,
  shouldRenderLandingForProbeError,
} from '@/AuthGate';
import {
  DEMO_MODE_CHANGE_EVENT,
  disableDemoMode,
  enableDemoMode,
  isDemoMode,
} from '@/lib/demo';
import { resolveInitialChannel } from '@/lib/channel-context';

class MemoryStorage {
  private readonly values = new Map<string, string>();

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
  vi.stubGlobal('window', new EventTarget());
});

afterEach(() => {
  disableDemoMode();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('public demo bootstrap', () => {
  it('starts as a real auth probe until the user explicitly enables demo', () => {
    expect(authGateInitialState()).toEqual({ status: 'pending' });
  });

  it('persists demo + synthetic channel and resolves AuthGate without /api/auth/me', () => {
    let changes = 0;
    window.addEventListener(DEMO_MODE_CHANGE_EVENT, () => {
      changes += 1;
    });

    enableDemoMode();

    expect(isDemoMode()).toBe(true);
    expect(localStorage.getItem('pulse_channel')).toBe('0');
    expect(authGateInitialState()).toEqual({ status: 'success', me: DEMO_ME });
    expect(changes).toBe(1);
  });

  it('returns to the real auth probe when demo is disabled', () => {
    enableDemoMode();
    disableDemoMode();

    expect(isDemoMode()).toBe(false);
    expect(authGateInitialState()).toEqual({ status: 'pending' });
  });

  it('keeps demo active in memory when localStorage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });

    enableDemoMode();

    expect(isDemoMode()).toBe(true);
    expect(authGateInitialState()).toEqual({ status: 'success', me: DEMO_ME });
    expect(resolveInitialChannel()).toBe(0);
  });
});

describe('raw auth boundary parser', () => {
  it('accepts the production /api/auth/me shape', () => {
    expect(
      parseMe({
        uid: 42,
        email: 'owner@example.com',
        role: 'user',
        avatar: null,
        ai: { enabled: true },
      }),
    ).toEqual({
      uid: 42,
      email: 'owner@example.com',
      role: 'user',
      avatar: null,
      ai: { enabled: true },
    });
  });

  it('rejects an empty object and invalid uid before loading the protected graph', () => {
    expect(() => parseMe({})).toThrow('Формат данных не совпадает с ожидаемым');
    expect(() =>
      parseMe({
        uid: 1.5,
        email: 'owner@example.com',
        role: 'user',
        avatar: null,
      }),
    ).toThrow('Формат данных не совпадает с ожидаемым');
  });

  it('bounds a stalled auth probe and falls back to the public Landing', async () => {
    vi.useFakeTimers();
    const request = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    ) as unknown as typeof fetch;
    const probe = probeMe(new AbortController().signal, request);
    const outcome = expect(probe).rejects.toMatchObject({
      status: 0,
      message: expect.stringContaining('не ответил вовремя'),
    });

    await vi.advanceTimersByTimeAsync(AUTH_PROBE_TIMEOUT_MS);
    await outcome;
    expect(shouldRenderLandingForProbeError(0)).toBe(true);
  });

  it('routes offline/session-missing to Landing but keeps a real 5xx as an outage', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('offline');
    }) as unknown as typeof fetch;
    await expect(
      probeMe(new AbortController().signal, offline),
    ).rejects.toMatchObject({ status: 0 });

    expect(shouldRenderLandingForProbeError(401)).toBe(true);
    expect(shouldRenderLandingForProbeError(0)).toBe(true);
    expect(shouldRenderLandingForProbeError(503)).toBe(false);
  });
});
