/**
 * Pure URL contract for canonical MoySklad metric pages.
 *
 * PeriodUrlSync owns p/from/to. This module only owns controls inside a metric page and always
 * merges into the existing query, so period/source/debug parameters survive. Defaults are omitted;
 * malformed values are read as defaults and removed by the canonical form.
 */

export interface MsUrlEnumSpec {
  values: readonly string[];
  defaultValue: string;
}

export interface MsMetricUrlSchema {
  enums: Readonly<Record<string, MsUrlEnumSpec>>;
  channels?: boolean;
}

export interface ParsedMsMetricUrl {
  values: Readonly<Record<string, string>>;
  channels: string[];
  canonical: URLSearchParams;
}

export const MS_CHANNEL_SELECTION_LIMIT = 20;
const CHANNELS_KEY = 'channels';
const MAX_CHANNEL_PARAM_LENGTH = 8_192;
// MoySklad IDs use the UUID-shaped 8-4-4-4-12 form, but existing tenant IDs do not
// consistently set the RFC version/variant bits (for example the fourth group can start with 0).
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

/** Bounded UUID-only channel parsing: URL input can never create an unbounded upstream query. */
export function parseMsChannelIds(raw: string | null, limit = MS_CHANNEL_SELECTION_LIMIT): string[] {
  if (!raw || limit < 1) return [];
  const result: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.slice(0, MAX_CHANNEL_PARAM_LENGTH).split(',')) {
    const id = part.trim().toLowerCase();
    if (!UUID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= limit) break;
  }
  return result;
}

export function parseMsMetricUrl(params: URLSearchParams, schema: MsMetricUrlSchema): ParsedMsMetricUrl {
  const canonical = new URLSearchParams(params);
  const values: Record<string, string> = {};

  for (const [key, spec] of Object.entries(schema.enums)) {
    const raw = params.get(key);
    const value = raw != null && spec.values.includes(raw) ? raw : spec.defaultValue;
    values[key] = value;
    if (raw == null) continue;
    if (value === spec.defaultValue || raw !== value) canonical.delete(key);
  }

  const channels = schema.channels ? parseMsChannelIds(params.get(CHANNELS_KEY)) : [];
  if (schema.channels) {
    if (channels.length === 0) canonical.delete(CHANNELS_KEY);
    else {
      const encoded = channels.join(',');
      if (params.get(CHANNELS_KEY) !== encoded) canonical.set(CHANNELS_KEY, encoded);
    }
  }

  return { values, channels, canonical };
}

/** Merge one validated enum control into the query; default values keep the URL minimal. */
export function applyMsMetricEnum(
  prev: URLSearchParams,
  schema: MsMetricUrlSchema,
  key: string,
  value: string,
): URLSearchParams {
  const spec = schema.enums[key];
  if (!spec) return new URLSearchParams(prev);
  const next = new URLSearchParams(prev);
  const safe = spec.values.includes(value) ? value : spec.defaultValue;
  if (safe === spec.defaultValue) next.delete(key);
  else next.set(key, safe);
  return next;
}

/** Merge a bounded channel selection; callers may pass duplicates/untrusted strings safely. */
export function applyMsMetricChannels(prev: URLSearchParams, ids: readonly string[]): URLSearchParams {
  const next = new URLSearchParams(prev);
  const safe = parseMsChannelIds(ids.join(','));
  if (safe.length === 0) next.delete(CHANNELS_KEY);
  else next.set(CHANNELS_KEY, safe.join(','));
  return next;
}
