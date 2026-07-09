// Entry bundle size gate. Run after `vite build`:
//   node scripts/check-bundle-size.mjs
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const assetsDir = join(distDir, 'assets');
const indexHtml = join(distDir, 'index.html');
const MAX_ENTRY_RAW_BYTES = 620_000;

const kb = (bytes) => (bytes / 1024).toFixed(1);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
  return match?.[2];
}

function htmlEntry() {
  if (!existsSync(indexHtml)) fail('dist/index.html не найден. Запусти gate после build.');

  const html = readFileSync(indexHtml, 'utf8');
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

const entry = htmlEntry() ?? fallbackEntry();
if (!entry || !existsSync(entry)) fail('Entry chunk не найден в dist/assets. Запусти gate после build.');

const rawBytes = statSync(entry).size;
const gzipBytes = gzipSync(readFileSync(entry)).length;
const fileName = relative(root, entry).replace(/\\/g, '/');

if (rawBytes > MAX_ENTRY_RAW_BYTES) {
  console.error(`bundle too large: ${kb(rawBytes)}KB raw / ${kb(gzipBytes)}KB gzip · limit ${kb(MAX_ENTRY_RAW_BYTES)}KB`);
  console.error(`file: ${fileName}`);
  console.error('hint: вынеси тяжёлый роут в ленивый чанк (как ig-cluster) или разбей импорт');
  process.exit(1);
}

console.log(`bundle OK: ${kb(rawBytes)}KB raw / ${kb(gzipBytes)}KB gzip · limit ${kb(MAX_ENTRY_RAW_BYTES)}KB`);
