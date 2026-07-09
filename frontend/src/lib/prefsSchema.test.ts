import { describe, expect, it } from 'vitest';
import { parsePrefs } from '@/lib/prefsSchema';

const jsonShape = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe('parsePrefs', () => {
  it('keeps valid prefs unchanged and preserves unknown passthrough keys', () => {
    const input = {
      version: 1,
      widgets: {
        w1: {
          color: 2,
          tinted: false,
          hidden: true,
          title: 'Custom title',
          variant: 'bar',
          period: 90,
          size: 'full',
          grain: 'week',
          includeToday: false,
          target: 100,
          source: 5,
          futureWidgetKey: { enabled: true },
        },
      },
      widgetOrder: { overview: ['w2', 'w1'], home: [] },
      home: ['digest', 'custom:abc'],
      widgetConfigs: [{ id: 'cfg1', metricId: 'tg.views', viz: 'line', period: 30, size: 'half' }],
      futureTopKey: { survives: true },
    };

    expect(jsonShape(parsePrefs(input))).toEqual(input);
  });

  it('returns default prefs for total garbage and never throws', () => {
    for (const raw of ['bad', ['bad'], null, 42]) {
      expect(() => parsePrefs(raw)).not.toThrow();
      expect(parsePrefs(raw)).toEqual({ version: 1 });
    }
  });

  it('keeps valid entries when sibling entries are malformed', () => {
    const parsed = parsePrefs({
      version: 1,
      widgets: {
        good: { color: 2, period: 30, size: 'half' },
        bad: 'not an object',
        mixed: { color: 'bad', hidden: true, period: 'bad', futureWidgetKey: 'ok' },
      },
      widgetOrder: { overview: ['good', 7, 'mixed'], bad: 'not an array' },
      home: ['digest', 9, 'history'],
      widgetConfigs: [
        { id: 'cfg1', metricId: 'tg.views', viz: 'line' },
        { id: 'bad-metric', metricId: 'ghost.metric', viz: 'line' },
        'not a config',
      ],
    });

    expect(jsonShape(parsed.widgets)).toEqual({
      good: { color: 2, period: 30, size: 'half' },
      mixed: { hidden: true, futureWidgetKey: 'ok' },
    });
    expect(parsed.widgets).not.toHaveProperty('bad');
    expect(jsonShape(parsed.widgetOrder)).toEqual({ overview: ['good', 'mixed'] });
    expect(parsed.widgetOrder).not.toHaveProperty('bad');
    expect(parsed.home).toEqual(['digest', 'history']);
    expect(parsed.widgetConfigs).toEqual([{ id: 'cfg1', metricId: 'tg.views', viz: 'line' }]);
  });

  it('stamps unversioned input to version 1', () => {
    expect(parsePrefs({ widgets: { w1: { hidden: true } } }).version).toBe(1);
  });

  it('preserves future unknown top-level keys', () => {
    const parsed = parsePrefs({ version: 1, futureTopKey: { mode: 'next' } });
    expect(parsed.futureTopKey).toEqual({ mode: 'next' });
  });
});
