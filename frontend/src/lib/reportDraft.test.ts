import { describe, expect, it } from 'vitest';
import type { Report } from '@/api/schemas';
import { buildDraft, draftToPutBody, isDraftDirty } from '@/lib/reportDraft';

const report = (over: Partial<Report> = {}): Report => ({
  id: 1,
  name: 'Отчёт',
  schedule: 'weekly',
  created_at: null,
  updated_at: null,
  channel_id: null,
  period_days: null,
  block_count: null,
  last_sent_at: null,
  config: { blocks: [{ id: 'a', type: 'text', config: { text: 'hi' } }], periodDays: 7, channelId: 42 },
  ...over,
});

describe('buildDraft', () => {
  it('snapshots name / blocks / period / schedule / source', () => {
    const d = buildDraft(report());
    expect(d.name).toBe('Отчёт');
    expect(d.periodDays).toBe(7);
    expect(d.schedule).toBe('weekly');
    expect(d.source).toBe(42);
    expect(d.blocks).toEqual([{ id: 'a', type: 'text', config: { text: 'hi' } }]);
  });

  it('applies safe fallbacks for missing/garbage config', () => {
    const d = buildDraft(report({ schedule: 'bogus', config: { periodDays: 999 } }));
    expect(d.periodDays).toBe(30); // unknown → document default
    expect(d.schedule).toBe('none'); // invalid → none
    expect(d.source).toBeNull();
    // missing blocks → the default preset composition (non-empty)
    expect(d.blocks.length).toBeGreaterThan(0);
    expect(d.blocks.every((b) => b.type === 'preset')).toBe(true);
  });

  it('rejects malformed source ids', () => {
    expect(buildDraft(report({ config: { blocks: [], channelId: -1 } })).source).toBeNull();
    expect(buildDraft(report({ config: { blocks: [], channelId: 1.5 } })).source).toBeNull();
  });
});

describe('draftToPutBody', () => {
  it('emits one body with name + full config + schedule, source pinned', () => {
    const d = buildDraft(report());
    const body = draftToPutBody(d, report().config);
    expect(body.name).toBe('Отчёт');
    expect(body.schedule).toBe('weekly');
    expect(body.config.channelId).toBe(42);
    expect(body.config.periodDays).toBe(7);
    expect(body.config.blocks).toEqual(d.blocks);
  });

  it('drops channelId when the source follows the switcher, keeps other config keys', () => {
    const d = { ...buildDraft(report()), source: null };
    const body = draftToPutBody(d, { ...report().config, extraneous: 'keep' } as never);
    expect('channelId' in body.config).toBe(false);
    expect((body.config as Record<string, unknown>).extraneous).toBe('keep');
  });

  it('trims the name', () => {
    const d = { ...buildDraft(report()), name: '  Новый  ' };
    expect(draftToPutBody(d, report().config).name).toBe('Новый');
  });
});

describe('isDraftDirty', () => {
  it('is false for an untouched snapshot and true for each edited field', () => {
    const base = buildDraft(report());
    expect(isDraftDirty(base, base)).toBe(false);
    expect(isDraftDirty({ ...base, name: 'x' }, base)).toBe(true);
    expect(isDraftDirty({ ...base, schedule: 'none' }, base)).toBe(true);
    expect(isDraftDirty({ ...base, source: null }, base)).toBe(true);
    expect(isDraftDirty({ ...base, periodDays: 30 }, base)).toBe(true);
    expect(isDraftDirty({ ...base, blocks: [...base.blocks, base.blocks[0]] }, base)).toBe(true);
  });
});
