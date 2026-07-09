import { z } from 'zod';
import type { WidgetPrefs } from '@/components/ChartWidget';
import { normalizeWidgets, type WidgetConfig } from '@/lib/widgetConfig';

const CURRENT_PREFS_VERSION = 1;

const PeriodDaysSchema = z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(0)]);
const WidgetSizeSchema = z.enum(['third', 'half', 'full']);
const WidgetPrefsGrainSchema = z.enum(['week', 'month']);

const optional = <T extends z.ZodTypeAny>(schema: T) => schema.optional().catch(undefined);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function copyDefined(value: Record<string, unknown>): Record<string, unknown> {
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (value[key] !== undefined) out[key] = value[key];
  }
  return out;
}

const WidgetPrefsSchema = z
  .object({
    color: optional(z.number().int().min(1).max(6)),
    tinted: optional(z.boolean()),
    hidden: optional(z.boolean()),
    title: optional(z.string()),
    variant: optional(z.string()),
    period: optional(PeriodDaysSchema),
    size: optional(WidgetSizeSchema),
    grain: optional(WidgetPrefsGrainSchema),
    includeToday: optional(z.literal(false)),
    target: optional(z.number().finite()),
    source: optional(z.number().int().positive()),
  })
  .passthrough()
  .transform((value) => copyDefined(value) as unknown as WidgetPrefs);

function normalizeWidgetPrefsMap(raw: Record<string, unknown>): Record<string, WidgetPrefs> {
  const out = Object.create(null) as Record<string, WidgetPrefs>;
  for (const key of Object.keys(raw)) {
    const row = raw[key];
    if (!isRecord(row)) continue;
    const parsed = WidgetPrefsSchema.safeParse(row);
    if (parsed.success) out[key] = parsed.data;
  }
  return out;
}

function normalizeStringArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

function normalizeWidgetOrderMap(raw: Record<string, unknown>): Record<string, string[]> {
  const out = Object.create(null) as Record<string, string[]>;
  for (const key of Object.keys(raw)) {
    const order = normalizeStringArray(raw[key]);
    if (order.length || Array.isArray(raw[key])) out[key] = order;
  }
  return out;
}

const WidgetPrefsMapSchema = z.record(z.unknown()).catch({}).transform(normalizeWidgetPrefsMap);
const WidgetOrderMapSchema = z.record(z.unknown()).catch({}).transform(normalizeWidgetOrderMap);
const HomeBlocksSchema = z.array(z.unknown()).catch([]).transform(normalizeStringArray);
const WidgetConfigsSchema = z.array(z.unknown()).catch([]).transform(normalizeWidgets);

export const PrefsSchema = z
  .object({
    version: z.number().catch(CURRENT_PREFS_VERSION),
    widgets: WidgetPrefsMapSchema.optional().catch(undefined),
    widgetOrder: WidgetOrderMapSchema.optional().catch(undefined),
    home: HomeBlocksSchema.optional().catch(undefined),
    widgetConfigs: WidgetConfigsSchema.optional().catch(undefined),
  })
  .passthrough();

export type Prefs = z.infer<typeof PrefsSchema> & {
  widgets?: Record<string, WidgetPrefs>;
  widgetOrder?: Record<string, string[]>;
  home?: string[];
  widgetConfigs?: WidgetConfig[];
};

function defaultPrefs(): Prefs {
  return { version: CURRENT_PREFS_VERSION };
}

export function migratePrefs(raw: unknown): unknown {
  if (!isRecord(raw)) return raw;
  const version = typeof raw.version === 'number' && Number.isFinite(raw.version) ? raw.version : 0;
  if (version >= CURRENT_PREFS_VERSION) return raw;
  const next = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(raw)) next[key] = raw[key];
  next.version = CURRENT_PREFS_VERSION;
  return next;
}

export function parsePrefs(raw: unknown): Prefs {
  try {
    const parsed = PrefsSchema.safeParse(migratePrefs(raw));
    return parsed.success ? (parsed.data as Prefs) : defaultPrefs();
  } catch {
    return defaultPrefs();
  }
}
