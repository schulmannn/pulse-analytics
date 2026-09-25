// Shared, framework-free analytics export model. One long-form schema for every network/section so
// export correctness lives in pure, testable helpers — not in the presentation panels. Each row is a
// single metric observation:
//
//   network, source, section, scope (current|previous), from, to, date?, metric, value, unit
//
// `date` is populated ONLY for genuine daily series (additive flows). Aggregate-only metrics — IG
// reach (deduped window total), views, likes, saves, … — never fabricate a daily value: they emit
// one row per scope with an empty `date`. `from`/`to` identify that row's current or equal-previous
// scope, so an export can never silently leak history outside the represented window.
import { downloadCsv, type CsvRow } from '@/lib/csv';

export type ExportNetwork = 'telegram' | 'instagram';
export type ExportScope = 'current' | 'previous';

export interface AnalyticsRow {
  network: ExportNetwork;
  /** Human-facing source label (channel/account). Kept verbatim in the cell; slugged for filenames. */
  source: string;
  /** Product surface the row belongs to (e.g. «Аналитика»). */
  section: string;
  /** Selected window (`current`) or its equal preceding window (`previous`). */
  scope: ExportScope;
  /** This row's scope bounds — local calendar YYYY-MM-DD (previous rows name the previous window). */
  from: string;
  to: string;
  /** Daily observation day (YYYY-MM-DD) for real daily series; omitted for aggregate-only metrics. */
  date?: string;
  metric: string;
  value: number;
  unit: string;
}

// Fixed column order so the CSV header is deterministic regardless of which rows carry `date`.
const COLUMNS = ['network', 'source', 'section', 'scope', 'from', 'to', 'date', 'metric', 'value', 'unit'] as const;

/** Project the long-form rows onto the fixed column order (absent `date` → empty cell). */
export function analyticsRowsToCsvRows(rows: AnalyticsRow[]): CsvRow[] {
  return rows.map((row) => {
    const out: CsvRow = {};
    for (const key of COLUMNS) {
      const value = (row as unknown as Record<string, string | number | undefined>)[key];
      out[key] = value ?? '';
    }
    return out;
  });
}

/** Local calendar YYYY-MM-DD from epoch ms (period windows are local-day, not UTC — matches period.tsx). */
export function toYmd(ms: number): string {
  const date = new Date(ms);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** Кириллица → латиница для имён файлов. Ровно ГОСТ-подобная практичная схема: цель — читаемый
    и узнаваемый источник, а не обратимость. */
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
  х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
  ғ: 'g', қ: 'k', ң: 'n', ө: 'o', ұ: 'u', ү: 'u', һ: 'h', і: 'i', ї: 'i', є: 'e', ґ: 'g', ў: 'u',
};

/** Filesystem-safe ASCII slug (lowercase letter/number runs joined by '-').
 *
 *  ASCII, а не Unicode, — измеренное требование БРАУЗЕРА, а не вкусовщина: Chrome 149 (проверено и
 *  на полном бинарнике, и на headless-shell) молча ОТБРАСЫВАЕТ атрибут `download` целиком, если в
 *  нём есть не-ASCII, и сохраняет файл под именем «download» — без расширения и без источника.
 *  Поэтому кириллицу транслитерируем: «Мой Канал» → «moy-kanal» остаётся узнаваемым, а прежний
 *  «мой-канал» терял не часть имени, а ВСЁ имя. Остатки не-ASCII (иероглифы, эмодзи) режем — они
 *  уронили бы имя так же. */
export function slugify(raw: string | null | undefined): string {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .normalize('NFKC')
    .replace(/\p{L}/gu, (ch) => TRANSLIT[ch] ?? ch)
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

export interface FilenameParts {
  network: ExportNetwork;
  /** Short section token, e.g. 'analytics' | 'content'. */
  section: string;
  from?: number;
  to?: number;
  source?: string | null;
}

/** Deterministic, safe filename: network-section[-source][-from_to].csv. Bounds are omitted only
    when unknown (e.g. «Всё» with no data); a source slug is included only when it is non-empty. */
export function exportFilename(parts: FilenameParts): string {
  const bits: string[] = [parts.network, parts.section];
  const source = slugify(parts.source);
  if (source) bits.push(source);
  if (parts.from != null && parts.to != null) bits.push(`${toYmd(parts.from)}_${toYmd(parts.to)}`);
  return `${bits.join('-')}.csv`;
}

/** Trigger a browser download of long-form analytics rows. No-op when there are no rows. */
export function downloadAnalyticsCsv(filename: string, rows: AnalyticsRow[]): void {
  downloadCsv(filename, analyticsRowsToCsvRows(rows));
}
