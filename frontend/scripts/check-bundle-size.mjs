// Route-closure bundle gate. Run after `vite build`:
//   node scripts/check-bundle-size.mjs
//
// `dist/index.html` is the real browser bootstrap (including classic scripts, CSS and local fonts).
// Vite's manifest then extends that set with every transitive STATIC import for an addressed route.
// Dynamic imports are added only when that route actually crosses the boundary. This catches both
// size regressions and accidental graph re-merges (for example MetricRoute importing both generic
// and Instagram explorers again).
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const indexHtml = join(distDir, 'index.html');
const manifestPath = join(distDir, '.vite', 'manifest.json');
const KB = 1024;

/*
 * ДВА ЯРУСА, а не один. Прежний гейт держал ОДИН набор чисел, выставленных «по факту замера + 2KB»,
 * и файл правился 28 раз за восемь недель — почти всегда вместе с фичей, всегда вверх (+5, +2, +3,
 * +2, +2, +2, +1KB) и один раз вниз. Это детектор регрессий, а не бюджет: «auth» стоял в 0.8KB от
 * своего потолка, «tg overview» в 0.5KB, — то есть любая фича обязана была двигать порог, и
 * двигала (аудит #554, ТЗ-8).
 *
 * Ярус 1 — PRODUCT_BUDGETS: продуктовые потолки с запасом. Их правят ОТДЕЛЬНЫМ PR с обоснованием,
 * а не попутно с фичей. Это ответ на вопрос «сколько маршрут имеет право весить», и ответ даёт
 * владелец, а не последний замер.
 *
 * Ярус 2 — bundle-baseline.json: последний замер. Гейт красный, если маршрут вырос относительно
 * baseline больше чем на max(3%, 5KB). Рост в пределах допуска проходит молча; чтобы зафиксировать
 * новый вес, автор PR запускает `npm run size-check -- --update-baseline` и ОБЪЯСНЯЕТ рост в
 * описании. Уменьшение baseline не ломает — гейт печатает «можно ужать», и трещотка ужимается тем
 * же флагом. В CI флаг не используется НИКОГДА.
 *
 * История правок потолков до перехода на два яруса (зачем они были такими) осталась в git blame
 * этого файла; переносить её сюда — значит держать changelog в гейте.
 */
const PRODUCT_BUDGETS = {
  // Публичный бут и лендинг: их видит незалогиненный посетитель, здесь запас самый узкий.
  entryRaw: 50 * KB,
  publicBootJs: 110 * KB,
  publicBootCode: 145 * KB,
  publicBootResources: 210 * KB,
  landingCode: 175 * KB,
  landingResources: 260 * KB,
  authCode: 200 * KB,
  // Оболочка приложения — общий код всех защищённых маршрутов.
  protectedJs: 270 * KB,
  protectedCode: 300 * KB,
  // Маршруты с графиками. Один потолок на всю семью: расхождение между ними — это не продуктовое
  // решение, а история того, кто последним двигал своё число.
  overviewCode: 400 * KB,
  metricDispatcherCode: 300 * KB,
  genericMetricCode: 400 * KB,
  instagramMetricCode: 400 * KB,
  moySkladMetricCode: 400 * KB,
  metrikaMetricCode: 400 * KB,
  telegramMetricCode: 400 * KB,
  mentionsMetricCode: 400 * KB,
};

// Допуск роста относительно baseline: шум сборки (перетасовка чанков, gzip на мелких корзинах)
// живёт в единицах килобайт, поэтому абсолютный пол важнее процента на лёгких маршрутах.
const DRIFT_PCT = 0.03;
const DRIFT_MIN = 5 * KB;

const baselinePath = join(root, 'scripts', 'bundle-baseline.json');
const updateBaseline = process.argv.includes('--update-baseline');
const baseline = existsSync(baselinePath)
  ? JSON.parse(readFileSync(baselinePath, 'utf8'))
  : null;

const kb = (bytes) => (bytes / KB).toFixed(1);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function attr(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(['"])(.*?)\\1`, 'i'));
  return match?.[2];
}

function localAsset(href) {
  if (!href || /^[a-z]+:/i.test(href) || href.startsWith('//')) return null;
  const rel = href.replace(/[?#].*$/, '').replace(/^\//, '');
  const path = join(distDir, rel);
  return existsSync(path) ? path : null;
}

/** All local font files referenced by bootstrap CSS (conservative: every unicode subset). */
function cssFonts(stylesheet) {
  const source = readFileSync(stylesheet, 'utf8');
  const fonts = [];
  const seen = new Set();
  for (const match of source.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    const href = match[2]?.replace(/[?#].*$/, '');
    if (!href || /^[a-z]+:/i.test(href) || href.startsWith('//') || href.startsWith('#')) continue;
    if (!/\.woff2?$/i.test(href)) continue;
    const path = href.startsWith('/')
      ? join(distDir, href.replace(/^\//, ''))
      : resolve(dirname(stylesheet), href);
    if (existsSync(path) && !seen.has(path)) {
      seen.add(path);
      fonts.push(path);
    }
  }
  return fonts;
}

/** Browser bootstrap from HTML: module/classic scripts + modulepreloads + styles + local fonts. */
function initialClosure(html) {
  const js = new Set();
  const css = new Set();
  for (const match of html.matchAll(/<script\b[^>]*>/gi)) {
    const path = localAsset(attr(match[0], 'src'));
    if (path) js.add(path);
  }
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rel = attr(tag, 'rel')?.toLowerCase();
    if (rel !== 'modulepreload' && rel !== 'stylesheet') continue;
    const path = localAsset(attr(tag, 'href'));
    if (path) (rel === 'stylesheet' ? css : js).add(path);
  }
  return {
    js,
    css,
    fonts: new Set([...css].flatMap(cssFonts)),
  };
}

function measure(paths) {
  return [...paths].map((path) => ({
    name: relative(distDir, path).replace(/\\/g, '/'),
    path,
    raw: statSync(path).size,
    gzip: gzipSync(readFileSync(path)).length,
  }));
}

const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);

if (!existsSync(indexHtml)) fail('dist/index.html не найден. Запусти gate после build.');
if (!existsSync(manifestPath)) {
  fail('dist/.vite/manifest.json не найден. Включи build.manifest и запусти build.');
}

const html = readFileSync(indexHtml, 'utf8');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const initial = initialClosure(html);
if (initial.js.size === 0) {
  fail('В dist/index.html не нашлось локального скрипта. Запусти gate после build.');
}

function assetPath(file) {
  const path = join(distDir, file);
  if (!existsSync(path)) fail(`Manifest ссылается на отсутствующий ассет: ${file}`);
  return path;
}

function resolveManifestKey(ref) {
  if (manifest[ref]) return ref;
  const matches = Object.entries(manifest)
    .filter(([, item]) => item.src === ref || item.name === ref)
    .map(([key]) => key);
  if (matches.length !== 1) {
    fail(
      matches.length === 0
        ? `Manifest entry не найден: ${ref}`
        : `Manifest entry неоднозначен: ${ref} → ${matches.join(', ')}`,
    );
  }
  return matches[0];
}

function staticManifestClosure(rootKeys) {
  const keys = new Set();
  const visit = (key) => {
    if (keys.has(key)) return;
    const item = manifest[key];
    if (!item) fail(`Manifest import не найден: ${key}`);
    keys.add(key);
    for (const imported of item.imports ?? []) visit(imported);
  };
  for (const key of rootKeys) visit(key);
  return keys;
}

/** Bootstrap plus static closure of the dynamic route entries actually crossed by this route. */
function routeClosure(refs) {
  const js = new Set(initial.js);
  const css = new Set(initial.css);
  const keys = staticManifestClosure(refs.map(resolveManifestKey));
  for (const key of keys) {
    const item = manifest[key];
    js.add(assetPath(item.file));
    for (const file of item.css ?? []) css.add(assetPath(file));
  }
  const jsRows = measure(js);
  const cssRows = measure(css);
  const jsGzip = sum(jsRows, 'gzip');
  const cssGzip = sum(cssRows, 'gzip');
  return {
    jsRows,
    cssRows,
    jsGzip,
    cssGzip,
    codeGzip: jsGzip + cssGzip,
  };
}

const routes = {
  boot: routeClosure(['index.html']),
  landing: routeClosure(['index.html', 'src/AuthGate.tsx', 'src/pages/Landing.tsx']),
  auth: routeClosure(['index.html', 'src/pages/Auth.tsx']),
  protected: routeClosure(['index.html', 'src/AuthGate.tsx', 'src/ProtectedApp.tsx']),
  overview: routeClosure([
    'index.html',
    'src/AuthGate.tsx',
    'src/ProtectedApp.tsx',
    'Overview',
  ]),
  metricDispatcher: routeClosure([
    'index.html',
    'src/AuthGate.tsx',
    'src/ProtectedApp.tsx',
    'src/panels/MetricRoute.tsx',
  ]),
  genericMetric: routeClosure([
    'index.html',
    'src/AuthGate.tsx',
    'src/ProtectedApp.tsx',
    'src/panels/MetricRoute.tsx',
    'src/panels/MetricPage.tsx',
  ]),
  instagramMetric: routeClosure([
    'index.html',
    'src/AuthGate.tsx',
    'src/ProtectedApp.tsx',
    'src/panels/MetricRoute.tsx',
    'src/panels/IgMetricPage.tsx',
  ]),
  moySkladMetric: routeClosure([
    'index.html',
    'src/AuthGate.tsx',
    'src/ProtectedApp.tsx',
    'src/panels/MetricRoute.tsx',
    'src/panels/sklad/MsMetricPage.tsx',
  ]),
  metrikaMetric: routeClosure([
    'index.html',
    'src/AuthGate.tsx',
    'src/ProtectedApp.tsx',
    'src/panels/MetricRoute.tsx',
    'src/panels/metrika/YmMetricPage.tsx',
  ]),
  telegramMetric: routeClosure([
    'index.html',
    'src/AuthGate.tsx',
    'src/ProtectedApp.tsx',
    'src/panels/MetricRoute.tsx',
    'src/panels/TgMetricPage.tsx',
  ]),
  mentionsMetric: routeClosure([
    'index.html',
    'src/AuthGate.tsx',
    'src/ProtectedApp.tsx',
    'src/panels/MetricRoute.tsx',
    'src/panels/mentions/MentionsMetricPage.tsx',
  ]),
};

const fontRows = measure(initial.fonts);
const fontGzip = sum(fontRows, 'gzip');
const bootResources = routes.boot.codeGzip + fontGzip;
const landingResources = routes.landing.codeGzip + fontGzip;

const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry);
if (!entryKey) fail('Manifest entry chunk не найден.');
const entryPath = assetPath(manifest[entryKey].file);
const entryRaw = statSync(entryPath).size;
const entryGzip = gzipSync(readFileSync(entryPath)).length;

function printRoute(label, route) {
  console.log(
    `${label.padEnd(19)} ${route.jsRows.length} JS + ${route.cssRows.length} CSS · ` +
      `${kb(route.jsGzip)}KB JS / ${kb(route.codeGzip)}KB code`,
  );
}

/* Все отслеживаемые числа одной таблицей: ярус 1 (потолок) и ярус 2 (baseline) применяются к ним
   единообразно, и добавить маршрут — значит дописать строку, а не три места. */
const MEASURED = [
  ['entryRaw', 'entry chunk (raw)', entryRaw, PRODUCT_BUDGETS.entryRaw],
  ['publicBootJs', 'public boot JS', routes.boot.jsGzip, PRODUCT_BUDGETS.publicBootJs],
  ['publicBootCode', 'public boot code', routes.boot.codeGzip, PRODUCT_BUDGETS.publicBootCode],
  ['publicBootResources', 'public boot resources', bootResources, PRODUCT_BUDGETS.publicBootResources],
  ['landingCode', 'landing code', routes.landing.codeGzip, PRODUCT_BUDGETS.landingCode],
  ['landingResources', 'landing resources', landingResources, PRODUCT_BUDGETS.landingResources],
  ['authCode', 'auth code', routes.auth.codeGzip, PRODUCT_BUDGETS.authCode],
  ['protectedJs', 'protected shell JS', routes.protected.jsGzip, PRODUCT_BUDGETS.protectedJs],
  ['protectedCode', 'protected shell code', routes.protected.codeGzip, PRODUCT_BUDGETS.protectedCode],
  ['overviewCode', 'tg overview code', routes.overview.codeGzip, PRODUCT_BUDGETS.overviewCode],
  ['metricDispatcherCode', 'metric dispatcher code', routes.metricDispatcher.codeGzip, PRODUCT_BUDGETS.metricDispatcherCode],
  ['genericMetricCode', 'generic metric code', routes.genericMetric.codeGzip, PRODUCT_BUDGETS.genericMetricCode],
  ['instagramMetricCode', 'instagram metric code', routes.instagramMetric.codeGzip, PRODUCT_BUDGETS.instagramMetricCode],
  ['moySkladMetricCode', 'moysklad metric code', routes.moySkladMetric.codeGzip, PRODUCT_BUDGETS.moySkladMetricCode],
  ['metrikaMetricCode', 'metrika metric code', routes.metrikaMetric.codeGzip, PRODUCT_BUDGETS.metrikaMetricCode],
  ['telegramMetricCode', 'telegram metric code', routes.telegramMetric.codeGzip, PRODUCT_BUDGETS.telegramMetricCode],
  ['mentionsMetricCode', 'mentions metric code', routes.mentionsMetric.codeGzip, PRODUCT_BUDGETS.mentionsMetricCode],
];

printRoute('public boot', routes.boot);
printRoute('landing', routes.landing);
printRoute('auth', routes.auth);
printRoute('protected shell', routes.protected);
printRoute('tg overview', routes.overview);
printRoute('metric dispatcher', routes.metricDispatcher);
printRoute('generic metric', routes.genericMetric);
printRoute('instagram metric', routes.instagramMetric);
printRoute('moysklad metric', routes.moySkladMetric);
printRoute('metrika metric', routes.metrikaMetric);
printRoute('telegram metric', routes.telegramMetric);
printRoute('mentions metric', routes.mentionsMetric);
console.log(
  `${'public resources'.padEnd(19)} ${kb(bootResources)}KB incl. ${fontRows.length} fonts (${kb(fontGzip)}KB)`,
);

const heaviest = [
  ...routes.boot.jsRows,
  ...routes.boot.cssRows,
  ...fontRows,
].sort((a, b) => b.gzip - a.gzip).slice(0, 5);
console.log('top-5 public resources:');
for (const row of heaviest) {
  console.log(
    `  ${kb(row.raw).padStart(7)}KB raw / ${kb(row.gzip).padStart(6)}KB gzip · ${row.name}`,
  );
}

// Три числа на строку: факт, baseline и продуктовый потолок — видно и дрейф, и запас.
console.log('\nбюджеты (факт / baseline / потолок), KB:');
const problems = [];
const nextBaseline = {};
const shrunk = [];
for (const [key, label, actual, ceiling] of MEASURED) {
  nextBaseline[key] = actual;
  const base = baseline?.[key];
  const allowed = base == null ? null : base + Math.max(base * DRIFT_PCT, DRIFT_MIN);
  console.log(
    `  ${label.padEnd(24)} ${kb(actual).padStart(7)} / ${(base == null ? '—' : kb(base)).padStart(7)}` +
      ` / ${kb(ceiling).padStart(7)}`,
  );
  if (actual > ceiling) {
    problems.push(
      `${label}: ${kb(actual)}KB превышает ПРОДУКТОВЫЙ потолок ${kb(ceiling)}KB — это решение владельца, а не правка гейта`,
    );
  } else if (allowed != null && actual > allowed) {
    problems.push(
      `${label}: ${kb(actual)}KB против baseline ${kb(base)}KB (допуск ${kb(allowed)}KB). ` +
        'Объясни рост в описании PR и зафиксируй: npm run size-check -- --update-baseline',
    );
  } else if (base != null && actual < base - DRIFT_MIN) {
    shrunk.push(`${label}: ${kb(actual)}KB против baseline ${kb(base)}KB`);
  }
}
if (baseline == null) {
  console.log('\nbaseline не найден — создай его: npm run size-check -- --update-baseline');
}
if (shrunk.length > 0) {
  console.log('\nможно ужать baseline (npm run size-check -- --update-baseline):');
  for (const line of shrunk) console.log(`  ${line}`);
}
if (updateBaseline) {
  writeFileSync(baselinePath, `${JSON.stringify(nextBaseline, null, 2)}\n`, 'utf8');
  console.log(`\nbaseline записан: ${relative(root, baselinePath).replace(/\\/g, '/')}`);
}

// Graph contracts: protected code waits behind a successful AuthGate decision; metric families
// remain separate async entries and cannot silently re-aggregate.
const authGateKey = resolveManifestKey('src/AuthGate.tsx');
const protectedKey = resolveManifestKey('src/ProtectedApp.tsx');
const landingKey = resolveManifestKey('src/pages/Landing.tsx');
const authGateStatic = staticManifestClosure([authGateKey]);
const authGateDynamic = new Set(manifest[authGateKey].dynamicImports ?? []);
if (authGateStatic.has(protectedKey)) problems.push('ProtectedApp became a static AuthGate import');
if (authGateStatic.has(landingKey)) problems.push('Landing became a static AuthGate import');
if (!authGateDynamic.has(protectedKey)) problems.push('ProtectedApp is no longer an AuthGate dynamic import');
if (!authGateDynamic.has(landingKey)) problems.push('Landing is no longer an AuthGate dynamic import');

const metricRouteKey = resolveManifestKey('src/panels/MetricRoute.tsx');
const metricStatic = staticManifestClosure([metricRouteKey]);
const metricDynamic = new Set(manifest[metricRouteKey].dynamicImports ?? []);
const metricFamilies = [
  ['generic MetricPage', resolveManifestKey('src/panels/MetricPage.tsx')],
  ['Instagram IgMetricPage', resolveManifestKey('src/panels/IgMetricPage.tsx')],
  ['MoySklad MsMetricPage', resolveManifestKey('src/panels/sklad/MsMetricPage.tsx')],
  ['Metrika YmMetricPage', resolveManifestKey('src/panels/metrika/YmMetricPage.tsx')],
  ['Telegram TgMetricPage', resolveManifestKey('src/panels/TgMetricPage.tsx')],
  [
    'Mentions MentionsMetricPage',
    resolveManifestKey('src/panels/mentions/MentionsMetricPage.tsx'),
  ],
];
for (const [label, key] of metricFamilies) {
  if (metricStatic.has(key)) problems.push(`${label} became a static MetricRoute import`);
  if (!metricDynamic.has(key)) problems.push(`${label} is no longer a MetricRoute dynamic import`);
}
for (const [label, key] of metricFamilies) {
  const familyStatic = staticManifestClosure([key]);
  for (const [otherLabel, otherKey] of metricFamilies) {
    if (key !== otherKey && familyStatic.has(otherKey)) {
      problems.push(`${label} statically imports ${otherLabel}`);
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error('hint: inspect dist/.vite/manifest.json and the route summary above');
  process.exit(1);
}

console.log('bundle routes OK');
