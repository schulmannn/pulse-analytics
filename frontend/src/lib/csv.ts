// Tiny client-side CSV export — no dependency. Quotes cells containing separators/quotes/
// newlines (RFC-4180), prepends a UTF-8 BOM so Excel renders Cyrillic correctly.

export type CsvRow = Record<string, string | number | null | undefined>;

function escapeCell(value: string | number | null | undefined): string {
  if (value == null) return '';
  const s = String(value);
  return /["\n\r,;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a CSV string from row objects. Columns = union of all rows' keys (so a sparse
    row built incrementally never drops columns the first row happened to lack). */
export function toCsv(rows: CsvRow[]): string {
  if (rows.length === 0) return '';
  const headers = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) {
    lines.push(headers.map((h) => escapeCell(row[h])).join(','));
  }
  return lines.join('\r\n');
}

/** Trigger a browser download of the rows as a CSV file. No-op without a DOM. */
export function downloadCsv(filename: string, rows: CsvRow[]): void {
  if (rows.length === 0 || typeof document === 'undefined') return;
  const blob = new Blob(['﻿' + toCsv(rows)], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  // Defer cleanup — Safari/WebView process the download async; revoking in the same tick
  // can abort it or yield an empty file.
  setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 0);
}
