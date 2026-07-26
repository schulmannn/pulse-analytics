// Initial-closure bundle gate. Run after `vite build`:
//   node scripts/check-bundle-size.mjs
//
// Гейт меряет ВСЮ initial closure, а не один entry-чанк: `dist/index.html` перечисляет ровно то,
// что браузер тянет до первой интеракции — entry `<script src>`, каждый `<link rel="modulepreload">`
// и каждый `<link rel="stylesheet">`. Прежняя версия смотрела ТОЛЬКО на `assets/index-*.js`
// (~87 KB gzip) и не видела регрессий в остальных 16 ассетах — внешний аудит поймал расхождение
// с реальными 336 KB gzip. Классические `<script src>` (наш прерисовочный theme-boot) тоже входят
// в закрытие: браузер обязан их скачать и выполнить до первого кадра.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const assetsDir = join(distDir, 'assets');
const indexHtml = join(distDir, 'index.html');

// ── Бюджеты ───────────────────────────────────────────────────────────────────────────────────
// Исторический порог одного entry-чанка — оставлен без изменений (преемственность: на него
// ссылаются комментарии о code splitting в App.tsx / panels/feed/feeds.tsx).
const MAX_ENTRY_RAW_BYTES = 620_000;
// BASELINE-ФИКСАЦИЯ, НЕ ЦЕЛЕВОЙ БЮДЖЕТ. Пороги ниже сняты с фактического билда origin/main
// (initial JS 311.2 KB gzip, TOTAL 336.5 KB gzip) + ~5% запаса, чтобы гейт зафиксировал статус-кво
// и ловил РОСТ, а не красил CI в день внедрения. Цель — ~220 KB gzip initial JS; путь к ней:
// вынести из закрытия ChartWidget/SourceIdentity/markdown-ветку и подрезать ui-vendor. Каждый шаг
// к цели ОБЯЗАН опускать эти числа — порог движется только вниз.
const MAX_INITIAL_JS_GZIP_BYTES = 335_000;
const MAX_INITIAL_TOTAL_GZIP_BYTES = 362_000;

const kb = (bytes) => (bytes / 1024).toFixed(1);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
  return match?.[2];
}

/** Локальный ассет из dist (внешние https://-ссылки — Google Fonts — не наш бюджет). */
function localAsset(href) {
  if (!href || /^[a-z]+:/i.test(href) || href.startsWith('//')) return null;
  const rel = href.replace(/[?#].*$/, '').replace(/^\//, '');
  const path = join(distDir, rel);
  return existsSync(path) ? path : null;
}

/** Всё, что документ грузит до первого кадра: скрипты (module и классические) + стили. */
function initialClosure(html) {
  const js = [];
  const css = [];
  const seen = new Set();
  const push = (list, path) => {
    if (seen.has(path)) return;
    seen.add(path);
    list.push(path);
  };

  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const path = localAsset(attr(match[0], 'src'));
    if (path) push(js, path);
  }
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = attr(tag, 'rel')?.toLowerCase();
    if (rel !== 'modulepreload' && rel !== 'stylesheet') continue;
    const path = localAsset(attr(tag, 'href'));
    if (path) push(rel === 'stylesheet' ? css : js, path);
  }
  return { js, css };
}

function measure(paths) {
  return paths.map((path) => ({
    name: relative(distDir, path).replace(/\\/g, '/'),
    raw: statSync(path).size,
    gzip: gzipSync(readFileSync(path)).length,
  }));
}

const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);

function htmlEntry(html) {
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const tag = match[0];
    if (attr(tag, 'type')?.toLowerCase() !== 'module') continue;

    const src = attr(tag, 'src');
    if (src && /(?:^|\/)assets\/index-[^/]+\.js$/.test(src)) {
      return join(distDir, src.replace(/^\//, ''));
    }
  }
  return null;
}

function fallbackEntry() {
  if (!existsSync(assetsDir)) fail('dist/assets не найден. Запусти gate после build.');

  const candidates = readdirSync(assetsDir)
    .filter((name) => /^index-.*\.js$/.test(name))
    .map((name) => join(assetsDir, name))
    .sort((a, b) => statSync(b).size - statSync(a).size);

  return candidates[0] ?? null;
}

if (!existsSync(indexHtml)) fail('dist/index.html не найден. Запусти gate после build.');
const html = readFileSync(indexHtml, 'utf8');

const { js, css } = initialClosure(html);
if (js.length === 0) fail('В dist/index.html не нашлось ни одного локального скрипта. Запусти gate после build.');

const jsRows = measure(js);
const cssRows = measure(css);
const jsRaw = sum(jsRows, 'raw');
const jsGzip = sum(jsRows, 'gzip');
const cssRaw = sum(cssRows, 'raw');
const cssGzip = sum(cssRows, 'gzip');
const totalRaw = jsRaw + cssRaw;
const totalGzip = jsGzip + cssGzip;

const entry = htmlEntry(html) ?? fallbackEntry();
if (!entry || !existsSync(entry)) fail('Entry chunk не найден в dist/assets. Запусти gate после build.');
const entryRaw = statSync(entry).size;
const entryGzip = gzipSync(readFileSync(entry)).length;
const entryName = relative(root, entry).replace(/\\/g, '/');

// ТОП-5 закрытия — чтобы регрессия читалась сразу, без ручного пересчёта dist.
const heaviest = [...jsRows, ...cssRows].sort((a, b) => b.gzip - a.gzip).slice(0, 5);

console.log(
  `initial JS:    ${jsRows.length} файлов · ${kb(jsRaw)}KB raw / ${kb(jsGzip)}KB gzip · limit ${kb(MAX_INITIAL_JS_GZIP_BYTES)}KB gzip`,
);
console.log(`initial CSS:   ${cssRows.length} файлов · ${kb(cssRaw)}KB raw / ${kb(cssGzip)}KB gzip`);
console.log(
  `initial TOTAL: ${jsRows.length + cssRows.length} файлов · ${kb(totalRaw)}KB raw / ${kb(totalGzip)}KB gzip · limit ${kb(MAX_INITIAL_TOTAL_GZIP_BYTES)}KB gzip`,
);
console.log(`entry chunk:   ${kb(entryRaw)}KB raw / ${kb(entryGzip)}KB gzip · limit ${kb(MAX_ENTRY_RAW_BYTES)}KB raw · ${entryName}`);
console.log('топ-5 initial closure:');
for (const row of heaviest) {
  console.log(`  ${kb(row.raw).padStart(7)}KB raw / ${kb(row.gzip).padStart(6)}KB gzip · ${row.name}`);
}

const problems = [];
if (entryRaw > MAX_ENTRY_RAW_BYTES) {
  problems.push(`entry chunk too large: ${kb(entryRaw)}KB raw · limit ${kb(MAX_ENTRY_RAW_BYTES)}KB (${entryName})`);
}
if (jsGzip > MAX_INITIAL_JS_GZIP_BYTES) {
  problems.push(`initial JS too large: ${kb(jsGzip)}KB gzip · limit ${kb(MAX_INITIAL_JS_GZIP_BYTES)}KB`);
}
if (totalGzip > MAX_INITIAL_TOTAL_GZIP_BYTES) {
  problems.push(`initial TOTAL too large: ${kb(totalGzip)}KB gzip · limit ${kb(MAX_INITIAL_TOTAL_GZIP_BYTES)}KB`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error('hint: вынеси тяжёлый роут в ленивый чанк (как ig-cluster) или разбей импорт;');
  console.error('hint: смотри топ-5 выше — регрессия почти всегда в одном из этих ассетов');
  process.exit(1);
}

console.log('bundle OK');
