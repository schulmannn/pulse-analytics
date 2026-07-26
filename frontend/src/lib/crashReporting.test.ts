import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetCrashReporting, reportCrashToServer } from './crashReporting';
import type { WidgetErrorReport } from './widgetErrors';

const mockFetch = vi.fn<
  (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
>();

function report(over: Partial<WidgetErrorReport> = {}): WidgetErrorReport {
  return { traceId: 'w-1', name: 'TypeError', message: 'boom', route: '/home', at: 'x', ...over };
}

function sentBodies(): Array<Record<string, unknown>> {
  return mockFetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
}

describe('reportCrashToServer', () => {
  beforeEach(() => {
    __resetCrashReporting();
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs a cookie-authenticated crash with the report fields + scope', () => {
    reportCrashToServer(report({ widgetId: 'custom-1', label: 'Просмотры' }), 'widget');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [path, init] = mockFetch.mock.calls[0];
    expect(path).toBe('/api/client-errors');
    expect(init).toMatchObject({
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    });
    expect(sentBodies()[0]).toMatchObject({
      traceId: 'w-1',
      name: 'TypeError',
      message: 'boom',
      widgetId: 'custom-1',
      label: 'Просмотры',
      scope: 'widget',
    });
  });

  it('does NOT dedupe occurrences with fresh trace ids', () => {
    reportCrashToServer(report({ widgetId: 'w1', traceId: 'w-a' }));
    reportCrashToServer(report({ widgetId: 'w1', traceId: 'w-b' }));
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(sentBodies().map((body) => body.traceId)).toEqual(['w-a', 'w-b']);
  });

  it('caps widget reports per session', () => {
    for (let index = 0; index < 30; index += 1) {
      reportCrashToServer(report({ message: `e${index}` }), 'widget');
    }
    expect(mockFetch).toHaveBeenCalledTimes(12);
  });

  it('gives app-scope crashes an independent budget', () => {
    for (let index = 0; index < 20; index += 1) {
      reportCrashToServer(report({ message: `e${index}` }), 'widget');
    }
    mockFetch.mockClear();
    reportCrashToServer(report({ message: 'white-screen' }), 'app');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sentBodies()[0].scope).toBe('app');
  });

  it('reports a global crash on its own budget', () => {
    for (let index = 0; index < 20; index += 1) {
      reportCrashToServer(report({ message: `e${index}` }), 'widget');
    }
    mockFetch.mockClear();
    reportCrashToServer(report({ message: 'unhandled' }), 'global');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(sentBodies()[0].scope).toBe('global');
  });

  it('swallows a synchronous fetch throw', () => {
    mockFetch.mockImplementationOnce(() => {
      throw new Error('sync');
    });
    expect(() => reportCrashToServer(report({ message: 'sync' }))).not.toThrow();
  });

  it('swallows a rejected request or response-contract failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('net'));
    expect(() => reportCrashToServer(report({ message: 'async' }))).not.toThrow();
    await Promise.resolve();

    mockFetch.mockResolvedValueOnce(Response.json({ accepted: true }));
    expect(() => reportCrashToServer(report({ message: 'drift' }))).not.toThrow();
    await Promise.resolve();
  });
});
