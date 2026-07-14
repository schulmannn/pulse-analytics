import { describe, expect, it } from 'vitest';
import type { ReportListItem } from '@/api/schemas';
import {
  filterReports,
  reportBlockCountLabel,
  reportDeliveryLabel,
  reportHasDelivery,
  reportPeriodLabel,
} from '@/lib/reportListModel';

const item = (over: Partial<ReportListItem>): ReportListItem => ({
  id: 1,
  name: 'Отчёт',
  schedule: 'none',
  created_at: null,
  updated_at: null,
  channel_id: null,
  period_days: null,
  block_count: null,
  last_sent_at: null,
  ...over,
});

describe('reportPeriodLabel', () => {
  it('maps known presets and falls back to 30д when unset/unknown', () => {
    expect(reportPeriodLabel(7)).toBe('7д');
    expect(reportPeriodLabel(30)).toBe('30д');
    expect(reportPeriodLabel(90)).toBe('90д');
    expect(reportPeriodLabel(0)).toBe('Всё');
    expect(reportPeriodLabel(null)).toBe('30д');
    expect(reportPeriodLabel(undefined)).toBe('30д');
    expect(reportPeriodLabel(-5)).toBe('30д');
  });
});

describe('reportBlockCountLabel', () => {
  it('legacy null → базовый набор; 0 → dash; positive → number', () => {
    expect(reportBlockCountLabel(null)).toBe('Базовый набор');
    expect(reportBlockCountLabel(undefined)).toBe('Базовый набор');
    expect(reportBlockCountLabel(0)).toBe('—');
    expect(reportBlockCountLabel(4)).toBe('4');
  });
});

describe('reportDeliveryLabel / reportHasDelivery', () => {
  it('labels schedules and detects delivery', () => {
    expect(reportDeliveryLabel('none')).toBe('—');
    expect(reportDeliveryLabel('weekly')).toBe('Раз в неделю');
    expect(reportDeliveryLabel('monthly')).toBe('Раз в месяц');
    expect(reportDeliveryLabel(undefined)).toBe('—');
    expect(reportHasDelivery(item({ schedule: 'none' }))).toBe(false);
    expect(reportHasDelivery(item({ schedule: 'weekly' }))).toBe(true);
  });
});

describe('filterReports', () => {
  const items = [
    item({ id: 1, name: 'Недельный обзор', schedule: 'weekly', channel_id: 10 }),
    item({ id: 2, name: 'Рост', schedule: 'none', channel_id: 20 }),
    item({ id: 3, name: 'Контент', schedule: 'monthly', channel_id: 10 }),
  ];
  const sourceLabelOf = (r: ReportListItem) => (r.channel_id === 10 ? '@alpha' : '@beta');

  it('delivery filter keeps only scheduled reports', () => {
    expect(filterReports(items, { filter: 'delivery' }).map((r) => r.id)).toEqual([1, 3]);
    expect(filterReports(items, { filter: 'all' }).map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('search matches name and resolved source label', () => {
    expect(filterReports(items, { query: 'рост' }).map((r) => r.id)).toEqual([2]);
    expect(filterReports(items, { query: 'alpha', sourceLabelOf }).map((r) => r.id)).toEqual([1, 3]);
    expect(filterReports(items, { query: '  ' }).map((r) => r.id)).toEqual([1, 2, 3]);
  });

  it('combines filter and search', () => {
    expect(filterReports(items, { query: 'alpha', filter: 'delivery', sourceLabelOf }).map((r) => r.id)).toEqual([1, 3]);
  });
});
