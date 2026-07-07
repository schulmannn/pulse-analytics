import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/client', () => ({
  apiSend: vi.fn(() => Promise.resolve({ ok: true })),
}));

import { apiSend } from '@/api/client';
import { __resetCrashReporting, reportCrashToServer } from './crashReporting';
import type { WidgetErrorReport } from './widgetErrors';

const mockSend = apiSend as unknown as ReturnType<typeof vi.fn>;

function report(over: Partial<WidgetErrorReport> = {}): WidgetErrorReport {
  return { traceId: 'w-1', name: 'TypeError', message: 'boom', route: '/home', at: 'x', ...over };
}

describe('reportCrashToServer', () => {
  beforeEach(() => {
    __resetCrashReporting();
    mockSend.mockReset();
    mockSend.mockImplementation(() => Promise.resolve({ ok: true }));
  });

  it('POSTs a crash to /api/client-errors with the report fields + scope', () => {
    reportCrashToServer(report({ widgetId: 'custom-1', label: 'Просмотры' }), 'widget');
    expect(mockSend).toHaveBeenCalledTimes(1);
    const [method, path, body] = mockSend.mock.calls[0];
    expect(method).toBe('POST');
    expect(path).toBe('/api/client-errors');
    expect(body).toMatchObject({
      traceId: 'w-1',
      name: 'TypeError',
      message: 'boom',
      widgetId: 'custom-1',
      label: 'Просмотры',
      scope: 'widget',
    });
  });

  it('does NOT dedupe — every occurrence (e.g. a retry with a fresh trace id) is POSTed so its shown id is stored', () => {
    reportCrashToServer(report({ widgetId: 'w1', traceId: 'w-a' }));
    reportCrashToServer(report({ widgetId: 'w1', traceId: 'w-b' })); // same signature, fresh trace id
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls.map((c) => c[2].traceId)).toEqual(['w-a', 'w-b']);
  });

  it('caps widget reports per session (anti crash-loop)', () => {
    for (let i = 0; i < 30; i++) reportCrashToServer(report({ message: `e${i}` }), 'widget');
    expect(mockSend).toHaveBeenCalledTimes(12);
  });

  it('gives app-scope crashes an INDEPENDENT budget — widget noise never starves an app crash', () => {
    for (let i = 0; i < 20; i++) reportCrashToServer(report({ message: `e${i}` }), 'widget'); // exhaust widget cap
    expect(mockSend).toHaveBeenCalledTimes(12);
    mockSend.mockClear();
    reportCrashToServer(report({ message: 'white-screen' }), 'app'); // app still gets through
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][2].scope).toBe('app');
  });

  it('reports a global (window-level) crash on its own budget, tagged scope=global', () => {
    for (let i = 0; i < 20; i++) reportCrashToServer(report({ message: `e${i}` }), 'widget'); // exhaust widget cap
    mockSend.mockClear();
    reportCrashToServer(report({ message: 'unhandled' }), 'global');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][2].scope).toBe('global');
  });

  it('swallows a synchronous apiSend throw (never escalates a crash)', () => {
    mockSend.mockImplementationOnce(() => {
      throw new Error('sync throw (demo mode)');
    });
    expect(() => reportCrashToServer(report({ message: 'sync' }))).not.toThrow();
  });

  it('swallows a rejected apiSend promise', async () => {
    mockSend.mockImplementationOnce(() => Promise.reject(new Error('net')));
    expect(() => reportCrashToServer(report({ message: 'async' }))).not.toThrow();
    await Promise.resolve();
  });
});
