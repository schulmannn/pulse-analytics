import { describe, expect, it } from 'vitest';
import {
  MS_CHANNEL_SELECTION_LIMIT,
  applyMsMetricChannels,
  applyMsMetricEnum,
  parseMsChannelIds,
  parseMsMetricUrl,
  type MsMetricUrlSchema,
} from './msMetricUrlState';

const schema: MsMetricUrlSchema = {
  enums: {
    grain: { values: ['day', 'week', 'month'], defaultValue: 'day' },
    chart: { values: ['line', 'bar'], defaultValue: 'line' },
    metric: { values: ['count', 'sum'], defaultValue: 'count' },
    compare: { values: ['prev', 'off'], defaultValue: 'prev' },
  },
  channels: true,
};

const IDS = [
  // Real MoySklad IDs can be UUID-shaped without RFC variant bits.
  '16f07379-8039-11ec-0a80-03970021e97d',
  '26f07379-8039-11ec-9a80-03970021e97e',
];

describe('MoySklad metric URL state', () => {
  it('reads defaults and keeps a minimal URL', () => {
    const parsed = parseMsMetricUrl(new URLSearchParams(), schema);
    expect(parsed.values).toEqual({ grain: 'day', chart: 'line', metric: 'count', compare: 'prev' });
    expect(parsed.channels).toEqual([]);
    expect(parsed.canonical.toString()).toBe('');
  });

  it('round-trips valid non-default controls and preserves period/unrelated params', () => {
    const params = new URLSearchParams(`p=90d&debug=1&grain=week&chart=bar&metric=sum&compare=off&channels=${IDS.join(',')}`);
    const parsed = parseMsMetricUrl(params, schema);
    expect(parsed.values).toEqual({ grain: 'week', chart: 'bar', metric: 'sum', compare: 'off' });
    expect(parsed.channels).toEqual(IDS);
    expect(parsed.canonical.get('p')).toBe('90d');
    expect(parsed.canonical.get('debug')).toBe('1');
  });

  it('normalizes malformed enums and explicit defaults without touching from/to', () => {
    const parsed = parseMsMetricUrl(
      new URLSearchParams('from=2026-07-01&to=2026-07-31&grain=year&chart=line&metric=money&compare=prev'),
      schema,
    );
    expect(parsed.values).toEqual({ grain: 'day', chart: 'line', metric: 'count', compare: 'prev' });
    expect(parsed.canonical.toString()).toBe('from=2026-07-01&to=2026-07-31');
  });

  it('deduplicates, validates and caps channel ids', () => {
    const many = Array.from({ length: MS_CHANNEL_SELECTION_LIMIT + 5 }, (_, i) =>
      `${String(i).padStart(8, '0')}-8039-11ec-8a80-03970021e97d`,
    );
    const raw = [IDS[0].toUpperCase(), 'not-a-channel', IDS[0], ...many].join(',');
    const ids = parseMsChannelIds(raw);
    expect(ids[0]).toBe(IDS[0]);
    expect(ids).toHaveLength(MS_CHANNEL_SELECTION_LIMIT);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('apply helpers omit defaults and merge without losing other params', () => {
    const start = new URLSearchParams('p=7d&grain=week&debug=1');
    const reset = applyMsMetricEnum(start, schema, 'grain', 'day');
    expect(reset.toString()).toBe('p=7d&debug=1');
    const changed = applyMsMetricEnum(reset, schema, 'metric', 'sum');
    expect(changed.get('metric')).toBe('sum');
    expect(changed.get('p')).toBe('7d');
    const channels = applyMsMetricChannels(changed, [IDS[0], IDS[0], 'bad', IDS[1]]);
    expect(channels.get('channels')).toBe(IDS.join(','));
    expect(channels.get('debug')).toBe('1');
  });

  it('supports a route-specific nonstandard default', () => {
    const repeatSchema: MsMetricUrlSchema = {
      enums: { metric: { values: ['orders', 'revenue', 'repeatShare'], defaultValue: 'repeatShare' } },
    };
    expect(parseMsMetricUrl(new URLSearchParams('metric=repeatShare'), repeatSchema).canonical.toString()).toBe('');
    expect(parseMsMetricUrl(new URLSearchParams('metric=orders'), repeatSchema).values.metric).toBe('orders');
  });
});
