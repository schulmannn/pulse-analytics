import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildWidgetErrorReport,
  nextTraceId,
  reportWidgetError,
  setWidgetErrorSink,
  type WidgetErrorReport,
} from './widgetErrors';

describe('nextTraceId', () => {
  it('is w-prefixed and unique across many calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const id = nextTraceId();
      expect(id).toMatch(/^w-[0-9a-z]+-[0-9a-z]+$/);
      ids.add(id);
    }
    expect(ids.size).toBe(1000);
  });
});

describe('buildWidgetErrorReport', () => {
  it('extracts name/message from an Error and keeps the context', () => {
    const report = buildWidgetErrorReport({
      traceId: 'w-x',
      error: new TypeError('boom'),
      widgetId: 'custom-1',
      label: 'Просмотры',
      componentStack: '\n    at Foo',
      route: '/home',
      at: '2026-07-04T00:00:00.000Z',
    });
    expect(report).toMatchObject({
      traceId: 'w-x',
      widgetId: 'custom-1',
      label: 'Просмотры',
      name: 'TypeError',
      message: 'boom',
      route: '/home',
      at: '2026-07-04T00:00:00.000Z',
    });
    expect(report.componentStack).toContain('at Foo');
  });

  it('handles non-Error throwables (string / null / object)', () => {
    expect(buildWidgetErrorReport({ traceId: 't', error: 'oops', at: 'x' })).toMatchObject({
      name: 'Error',
      message: 'oops',
    });
    expect(buildWidgetErrorReport({ traceId: 't', error: null, at: 'x' }).message).toBe('null');
    expect(buildWidgetErrorReport({ traceId: 't', error: { a: 1 }, at: 'x' }).message).toBe('[object Object]');
  });

  it('truncates a long message and component stack', () => {
    const r = buildWidgetErrorReport({
      traceId: 't',
      error: new Error('a'.repeat(500)),
      componentStack: 'b'.repeat(5000),
      at: 'x',
    });
    expect(r.message.length).toBeLessThanOrEqual(301);
    expect(r.message.endsWith('…')).toBe(true);
    expect((r.componentStack ?? '').length).toBeLessThanOrEqual(2001);
    expect((r.componentStack ?? '').endsWith('…')).toBe(true);
  });
});

describe('reportWidgetError', () => {
  afterEach(() => {
    setWidgetErrorSink(null);
    vi.restoreAllMocks();
  });

  it('logs to console and forwards to the sink with a fresh trace id', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: WidgetErrorReport[] = [];
    setWidgetErrorSink((r) => seen.push(r));
    const report = reportWidgetError({ error: new Error('x'), widgetId: 'w1', label: 'L', route: '/r', at: 'A' });
    expect(report.traceId).toMatch(/^w-/);
    expect(spy).toHaveBeenCalledWith('[widget-crash]', report.traceId, report);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(report);
  });

  it('swallows a throwing sink — reporting never escalates a crash', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setWidgetErrorSink(() => {
      throw new Error('sink broke');
    });
    expect(() => reportWidgetError({ error: new Error('x'), route: '/r', at: 'A' })).not.toThrow();
  });

  it('setWidgetErrorSink returns the previous sink and unregisters on null', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const a = () => {};
    expect(setWidgetErrorSink(a)).toBeNull();
    expect(setWidgetErrorSink(null)).toBe(a);
    const seen: WidgetErrorReport[] = [];
    setWidgetErrorSink((r) => seen.push(r));
    setWidgetErrorSink(null);
    reportWidgetError({ error: new Error('x'), at: 'A' });
    expect(seen).toHaveLength(0);
  });
});
