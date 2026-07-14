// Pure draft model for the desktop report editor. The desktop document edits a LOCAL draft and
// commits it with a single PUT on «Сохранить» (no debounce chain that could race). Keeping the
// build / serialize / dirty logic here — React-free — makes the save/cancel contract testable.
import type { Report, ReportConfig } from '@/api/schemas';
import type { PeriodDays } from '@/lib/period';
import { normalizeBlocks, type ReportBlock } from '@/lib/reportBlocks';

export type ReportSchedule = 'none' | 'weekly' | 'monthly';
const SCHEDULES: readonly ReportSchedule[] = ['none', 'weekly', 'monthly'];
const PERIODS: readonly PeriodDays[] = [0, 7, 30, 90];

// The document's own default period when a report has no persisted periodDays (matches the index).
export const DRAFT_DEFAULT_PERIOD_DAYS: PeriodDays = 30;

export interface ReportDraft {
  name: string;
  blocks: ReportBlock[];
  /** Effective preset (fallback already applied) — one of 0 | 7 | 30 | 90. */
  periodDays: PeriodDays;
  schedule: ReportSchedule;
  /** Persistent source (config.channelId); null = follow the switcher. */
  source: number | null;
}

function coercePeriod(raw: unknown): PeriodDays {
  return PERIODS.includes(raw as PeriodDays) ? (raw as PeriodDays) : DRAFT_DEFAULT_PERIOD_DAYS;
}

function coerceSchedule(raw: unknown): ReportSchedule {
  return SCHEDULES.includes(raw as ReportSchedule) ? (raw as ReportSchedule) : 'none';
}

/** Snapshot a saved report into an editable draft (the edit-mode baseline). */
export function buildDraft(report: Report): ReportDraft {
  const config = report.config ?? {};
  return {
    name: report.name,
    blocks: normalizeBlocks(config.blocks),
    periodDays: coercePeriod(config.periodDays),
    schedule: coerceSchedule(report.schedule),
    source:
      typeof config.channelId === 'number' && Number.isInteger(config.channelId) && config.channelId > 0
        ? config.channelId
        : null,
  };
}

/**
 * Serialize a draft into ONE PUT body (name + full config + schedule). The base config is
 * preserved (unknown/legacy keys survive the round-trip); channelId is dropped when the source
 * follows the switcher so «Как в свитчере» durably clears a previously pinned source.
 */
export function draftToPutBody(
  draft: ReportDraft,
  baseConfig: ReportConfig | undefined,
): { name: string; config: ReportConfig; schedule: ReportSchedule } {
  const config: ReportConfig = { ...(baseConfig ?? {}), blocks: draft.blocks, periodDays: draft.periodDays };
  if (draft.source == null) delete (config as Record<string, unknown>).channelId;
  else config.channelId = draft.source;
  return { name: draft.name.trim(), config, schedule: draft.schedule };
}

/** True when the draft differs from its baseline (drives the cancel-confirm + Save enablement). */
export function isDraftDirty(draft: ReportDraft, baseline: ReportDraft): boolean {
  return (
    draft.name !== baseline.name ||
    draft.schedule !== baseline.schedule ||
    draft.source !== baseline.source ||
    draft.periodDays !== baseline.periodDays ||
    JSON.stringify(draft.blocks) !== JSON.stringify(baseline.blocks)
  );
}
