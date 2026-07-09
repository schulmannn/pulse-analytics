// Pure report-document block model — types, defaults, and the legacy→generic migration.
// Kept React-free so normalizeBlocks (which decides whether every saved report keeps working)
// is unit-testable in isolation. The rendering + editing UI lives in panels/ReportPage.

// ── Pre-built (curated) block keys — the sections the single report used to hard-code. ──
// They survive the move to the generic model as the `preset` block type (config.key), so an
// existing report renders byte-identical and the curated blocks stay addable.
export type ReportBlockKey =
  | 'week'
  | 'kpi-summary'
  | 'digest' // legacy — deprecated by 'week' (narrative); still a valid saved key, renders the narrative
  | 'metric-views'
  | 'metric-subscribers'
  | 'metric-reactions'
  | 'weekly-table'
  | 'insights'
  | 'top-posts';

// Addable presets. «Неделя канала» (narrative) leads and replaces the old «Инсайт» (Digest) block —
// 'digest' стал legacy: не предлагается заново, но остаётся валидным ключом (рендерит нарратив).
export const REPORT_BLOCKS: Array<{ key: ReportBlockKey; label: string }> = [
  { key: 'week', label: 'Неделя канала' },
  { key: 'kpi-summary', label: 'Сводка' },
  { key: 'metric-views', label: 'Просмотры по дням' },
  { key: 'metric-subscribers', label: 'Подписчики по дням' },
  { key: 'metric-reactions', label: 'Реакции по дням' },
  { key: 'weekly-table', label: 'По неделям' },
  { key: 'insights', label: 'Наблюдения' },
  { key: 'top-posts', label: 'Лучшие публикации' },
];

// Default document = the old single report's composition: «Подписчики» right after «Просмотры».
// «Реакции» stays in the registry (addable) but is not part of the default set.
export const DEFAULT_REPORT_BLOCKS: ReportBlockKey[] = REPORT_BLOCKS
  .map((b) => b.key)
  .filter((key) => key !== 'metric-reactions');

export function isReportBlockKey(raw: string): raw is ReportBlockKey {
  // 'digest' is legacy (dropped from the add-list) but still valid so saved reports keep rendering.
  return raw === 'digest' || REPORT_BLOCKS.some((b) => b.key === raw);
}

// ── Generic block model (steep / Notion): a block is { id, type, config }. ──────────────────
export type ReportBlockType = 'text' | 'chart' | 'table' | 'bignumber' | 'map' | 'divider' | 'preset';
export interface ReportBlock {
  id: string;
  type: ReportBlockType;
  config: Record<string, unknown>;
}

const BLOCK_TYPES = new Set<ReportBlockType>(['text', 'chart', 'table', 'bignumber', 'map', 'divider', 'preset']);

/** Stable per-block id (crypto where available, else a cheap unique fallback). */
export function genId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `b_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function presetBlock(key: ReportBlockKey): ReportBlock {
  return { id: genId(), type: 'preset', config: { key } };
}

/** A new block with sensible defaults for its type (what the inline «+» inserts). */
export function defaultBlock(type: ReportBlockType, presetKey?: ReportBlockKey): ReportBlock {
  switch (type) {
    case 'text':
      return { id: genId(), type, config: { text: '' } };
    case 'chart':
      return { id: genId(), type, config: { metric: 'views', viz: 'line' } };
    case 'table':
      return { id: genId(), type, config: { source: 'weekly' } };
    case 'bignumber':
      return { id: genId(), type, config: { metric: 'views' } };
    case 'map':
    case 'divider':
      return { id: genId(), type, config: {} };
    case 'preset':
      return presetBlock(presetKey && isReportBlockKey(presetKey) ? presetKey : 'week');
  }
}

/**
 * Read config.blocks in either shape:
 *   - missing / not an array → the default preset composition (legacy null rows, new reports);
 *   - []                      → an explicitly emptied document (stays empty);
 *   - string[]                → legacy preset keys → wrapped as `preset` blocks;
 *   - object[]                → new blocks, validated (known type, config object, unique id).
 * Never throws: unknown elements are dropped.
 */
export function normalizeBlocks(raw: unknown): ReportBlock[] {
  if (!Array.isArray(raw)) return DEFAULT_REPORT_BLOCKS.map(presetBlock);
  const out: ReportBlock[] = [];
  const seen = new Set<string>();
  for (const el of raw) {
    let block: ReportBlock | null = null;
    if (typeof el === 'string') {
      if (isReportBlockKey(el)) block = presetBlock(el);
    } else if (el && typeof el === 'object' && !Array.isArray(el)) {
      const o = el as Record<string, unknown>;
      const type = typeof o.type === 'string' && BLOCK_TYPES.has(o.type as ReportBlockType) ? (o.type as ReportBlockType) : null;
      if (type) {
        const config = o.config && typeof o.config === 'object' && !Array.isArray(o.config) ? (o.config as Record<string, unknown>) : {};
        // A preset block is meaningless without a known key.
        if (type === 'preset' && !(typeof config.key === 'string' && isReportBlockKey(config.key))) {
          block = null;
        } else {
          const id = typeof o.id === 'string' && o.id ? o.id : genId();
          block = { id, type, config };
        }
      }
    }
    if (!block) continue;
    if (seen.has(block.id)) block.id = genId();
    seen.add(block.id);
    out.push(block);
  }
  return out;
}
