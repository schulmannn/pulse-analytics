import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REPORT_BLOCKS,
  defaultBlock,
  normalizeBlocks,
  type ReportBlock,
} from '@/lib/reportBlocks';

describe('normalizeBlocks — legacy → generic migration', () => {
  it('missing / non-array config → the default preset composition', () => {
    for (const raw of [undefined, null, {}, 'nope', 42]) {
      const blocks = normalizeBlocks(raw);
      expect(blocks.map((b) => b.type)).toEqual(DEFAULT_REPORT_BLOCKS.map(() => 'preset'));
      expect(blocks.map((b) => b.config.key)).toEqual(DEFAULT_REPORT_BLOCKS);
    }
  });

  it('an explicitly emptied report ([]) stays empty', () => {
    expect(normalizeBlocks([])).toEqual([]);
  });

  it('legacy string[] preset keys → preset blocks, unknown keys dropped', () => {
    const blocks = normalizeBlocks(['kpi-summary', 'digest', 'bogus', 'top-posts']);
    expect(blocks.map((b) => b.type)).toEqual(['preset', 'preset', 'preset']);
    expect(blocks.map((b) => b.config.key)).toEqual(['kpi-summary', 'digest', 'top-posts']);
  });

  it('new object blocks are preserved (id / type / config)', () => {
    const input = [
      { id: 'a', type: 'text', config: { text: 'привет' } },
      { id: 'b', type: 'chart', config: { metric: 'views', viz: 'bar' } },
      { id: 'c', type: 'divider', config: {} },
    ];
    const blocks = normalizeBlocks(input);
    expect(blocks).toEqual(input);
  });

  it('drops blocks with an unknown type', () => {
    expect(normalizeBlocks([{ id: 'x', type: 'wormhole', config: {} }])).toEqual([]);
  });

  it('drops a preset block without a valid key, keeps one with a valid key', () => {
    expect(normalizeBlocks([{ type: 'preset', config: {} }])).toEqual([]);
    expect(normalizeBlocks([{ type: 'preset', config: { key: 'zzz' } }])).toEqual([]);
    const ok = normalizeBlocks([{ type: 'preset', config: { key: 'insights' } }]);
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ type: 'preset', config: { key: 'insights' } });
    expect(typeof ok[0].id).toBe('string');
  });

  it('fills a missing id and a missing/invalid config', () => {
    const blocks = normalizeBlocks([{ type: 'text' }, { type: 'map', config: 'oops' }]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].id).toBeTruthy();
    expect(blocks[0].config).toEqual({});
    expect(blocks[1].config).toEqual({});
  });

  it('regenerates duplicate ids so keys stay unique', () => {
    const blocks = normalizeBlocks([
      { id: 'dup', type: 'divider', config: {} },
      { id: 'dup', type: 'text', config: { text: '' } },
    ]);
    expect(blocks).toHaveLength(2);
    expect(new Set(blocks.map((b) => b.id)).size).toBe(2);
  });

  it('reconciles a mixed legacy + new array in order', () => {
    const blocks = normalizeBlocks(['digest', { id: 'z', type: 'bignumber', config: { metric: 'er' } }]);
    expect(blocks.map((b) => b.type)).toEqual(['preset', 'bignumber']);
    expect(blocks[0].config.key).toBe('digest');
    expect(blocks[1]).toEqual({ id: 'z', type: 'bignumber', config: { metric: 'er' } });
  });
});

describe('defaultBlock — inserted-block defaults', () => {
  const hasId = (b: ReportBlock) => typeof b.id === 'string' && b.id.length > 0;

  it('gives each generic type sensible defaults', () => {
    expect(defaultBlock('text')).toMatchObject({ type: 'text', config: { text: '' } });
    expect(defaultBlock('chart')).toMatchObject({ type: 'chart', config: { metric: 'views', viz: 'line' } });
    expect(defaultBlock('table')).toMatchObject({ type: 'table', config: { source: 'weekly' } });
    expect(defaultBlock('bignumber')).toMatchObject({ type: 'bignumber', config: { metric: 'views' } });
    expect(defaultBlock('divider')).toMatchObject({ type: 'divider', config: {} });
    expect(defaultBlock('map')).toMatchObject({ type: 'map', config: {} });
    expect(hasId(defaultBlock('text'))).toBe(true);
  });

  it('preset default takes a valid key, else falls back to digest', () => {
    expect(defaultBlock('preset', 'insights')).toMatchObject({ type: 'preset', config: { key: 'insights' } });
    // @ts-expect-error — an invalid key is coerced to the fallback at runtime
    expect(defaultBlock('preset', 'nope')).toMatchObject({ type: 'preset', config: { key: 'digest' } });
    expect(defaultBlock('preset')).toMatchObject({ type: 'preset', config: { key: 'digest' } });
  });
});
