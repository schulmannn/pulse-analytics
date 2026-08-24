// Route-closure bundle gate. Run after `vite build`:
//   node scripts/check-bundle-size.mjs
//
// `dist/index.html` is the real browser bootstrap (including classic scripts, CSS and local fonts).
// Vite's manifest then extends that set with every transitive STATIC import for an addressed route.
// Dynamic imports are added only when that route actually crosses the boundary. This catches both
// size regressions and accidental graph re-merges (for example MetricRoute importing both generic
// and Instagram explorers again).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = join(root, 'dist');
const indexHtml = join(distDir, 'index.html');
const manifestPath = join(distDir, '.vite', 'manifest.json');
const KB = 1024;

// Tight post-audit ceilings, all measured with gzip. Font subsets are also tracked separately:
// code budgets stay comparable across routes, while the resource budget prevents fonts escaping.
const BUDGETS = {
  entryRaw: 50 * KB,
  publicBootJs: 100 * KB,
  publicBootCode: 130 * KB,
  publicBootResources: 205 * KB,
  landingCode: 150 * KB,
  landingResources: 225 * KB,
  authCode: 175 * KB,
  protectedJs: 220 * KB,
  protectedCode: 250 * KB,
  // +5KB к виджет-несущим маршрутам (2026-07-27): осознанные фичи владельца — контекстное меню
  // карточек (@radix-ui/react-context-menu в замыкании ChartSection) и hover-превью строк таблиц
  // (@radix-ui/react-hover-card: упоминания + кампании). Бюджеты подняты ровно на прирост.
  // 2026-08-14: +2KB — pending-состояние общей кнопки (loader-канон в ~20 сабмитах). Button
  //   лежит в КАЖДОМ роут-чанке, поэтому +0.3KB ложится на все маршруты сразу; точки уже
  //   инлайнены разметкой (без импорта ui/loader и Slottable), дешевле не сделать. Берём 2KB,
  //   потому что оба этих бюджета стояли впритык ЕЩЁ ДО правки (запас был 0.8KB и 0.2KB) и
  //   ломали бы любой следующий PR.
  // 2026-08-14: +3KB на все чарт-маршруты — волна полировки графиков по референсу владельца:
  //   пилюля текущей метки оси X + буквенная ось короткого окна (Sparkline/BarChart/LineChart),
  //   плавающий ChartTooltip у линейных искр, скруглённые верхи баров (общий stackSegmentPath).
  //   Семья графиков лежит в чанках каждого маршрута; замер — +1.1–1.2KB на маршрут, берём 3KB,
  //   потому что ВСЕ чарт-бюджеты снова стояли впритык (mentions 318.9/320.0, метрика 327.8/329.0)
  //   и следующий PR лёг бы на кромку.
  // 2026-08-18: +2KB на все чарт-маршруты — цифровой морф KPI (KpiNumber: парсер + Suspense-
  //   обёртка; сам @number-flow/react — ЛЕНИВЫЙ чанк вне статического графа, грабля #451) и
  //   строка «Мин · Макс» у оконных карточек (range в ChartCardBody + seriesRange). Замер —
  //   +1.0–1.3KB на маршрут; берём 2KB, потому что IG (348.2/348.0) уже перелез, а МойСклад
  //   (370.7/371.0) и Обзор (354.1/355.0) снова стояли впритык.
  overviewCode: 359 * KB,
  metricDispatcherCode: 272 * KB,
  genericMetricCode: 347 * KB,
  // 2026-08-24: +2KB — новый источник «СДЭК» в ОБЩЕМ реестре сетей (запись NETWORKS + глиф +
  //   иконка nav + три семьи ключей запросов). Реестр по построению общий для всех маршрутов,
  //   поэтому источник, которым IG-пользователь не пользуется, всё равно стоит ему ~0.7KB; сами
  //   запросы и страница СДЭКа лежат в своих чанках (api/cdek.ts + ленивый CdekImports) и в этот
  //   бюджет не входят. Берём 2KB, а не 1: до правки запас был 0.1KB (349.9/350.0), и следующий
  //   PR лёг бы на кромку так же, как этот.
  instagramMetricCode: 354 * KB,
  // 2026-07-28: +1KB — View Transitions навигация (viewTransitionNavigate в замыкании
  // useChartSectionModel; волна B). CI-сборка на ~0.3KB тяжелее локальной — с запасом.
  // 2026-07-29: +8KB — @tanstack/react-virtual (виртуализация RFM-аудитории и остатков склада;
  // manualChunks сознательно держит его ВНЕ shell-vendor — платит только этот маршрут).
  // 2026-07-29: +5KB — source-scoped фильтр каналов в explorer rail: SearchField + официальный
  // Radix Checkbox загружаются только вместе с полной страницей МойСклада, не с compact-карточкой.
  // 2026-08-11: +2KB — сверка «О метрике» с кодом: 22 текста formula/included/sourceNote
  //   переписаны под то, что реально считают резолверы (ym.users предупреждал о завышении,
  //   которого нет; ig.formats звался распределением публикаций, а суммировал взаимодействия).
  //   Замеренный рост — 1.1KB на чарт-маршрут; берём 2KB, потому что все четыре бюджета опять
  //   стояли впритык. Урезать правдивый текст ради 300 байт — ложная экономия.
  // 2026-08-14: +2KB — та же pending-кнопка, см. overviewCode.
  // 2026-08-14: +3KB — волна полировки графиков (см. overviewCode).
  // 2026-08-18: +2KB — цифровой морф KPI + «Мин · Макс» (см. overviewCode).
  // 2026-08-24: +2KB — раздел «Обзор» источника СДЭК в ОБЩЕМ реестре сетей (вторая запись nav +
  //   ленивый импорт панели в реестре лент). Реестр общий для всех маршрутов по построению,
  //   поэтому ~0.1KB ложится и сюда; сама панель и её запросы лежат в своих чанках. Берём 2KB:
  //   оба бюджета стояли на кромке (373.1/373.0 и 345.0/345.0) и ломали бы следующий PR.
  // 2026-08-25: +2KB — раздел «Заказы» СДЭКа в общем реестре сетей (третья запись nav +
  //   ленивая ветка панели). Та же неизбежная доля общей оболочки, что у соседних
  //   бюджетов выше; сама лента и её запросы лежат в своём чанке.
  moySkladMetricCode: 377 * KB,
  // 2026-07-29: +1KB — общая token-based подсветка активного drag-resize входит в route CSS.
  // 2026-08-11: +1KB — честность графиков: робастный домен искры (robustDomain) + подсветка
  //   пропусков штриховкой в LineChart/BarChart. Замер: маршрут рос на 0.5KB, оба бюджета стояли
  //   впритык (mentions 316.8/317.0). Берём 1KB, чтобы следующая правка снова не легла на кромку.
  // 2026-08-11: +2KB — сверка «О метрике» с кодом: 22 текста formula/included/sourceNote
  //   переписаны под то, что реально считают резолверы (ym.users предупреждал о завышении,
  //   которого нет; ig.formats звался распределением публикаций, а суммировал взаимодействия).
  //   Замеренный рост — 1.1KB на чарт-маршрут; берём 2KB, потому что все четыре бюджета опять
  //   стояли впритык. Урезать правдивый текст ради 300 байт — ложная экономия.
  // 2026-08-14: +3KB — волна полировки графиков (см. overviewCode).
  // 2026-08-18: +2KB — цифровой морф KPI + «Мин · Макс» (см. overviewCode).
  metrikaMetricCode: 336 * KB,
  // 2026-07-28: +1KB — та же волна B (см. выше).
  // 2026-07-29: +1KB — общая token-based подсветка активного drag-resize входит в route CSS.
  // 2026-08-11: +1KB — канон моторики P1: рунга --motion-exit + утилита anim-dur-exit на восьми
  //   оверлеях и press-дип на общем Button. Общий route-CSS вырос на ~0.1KB, бюджет стоял впритык
  //   (337.1/337.0). Берём килобайт, чтобы следующая правка снова не легла на кромку.
  // 2026-08-11: +2KB — сверка «О метрике» с кодом: 22 текста formula/included/sourceNote
  //   переписаны под то, что реально считают резолверы (ym.users предупреждал о завышении,
  //   которого нет; ig.formats звался распределением публикаций, а суммировал взаимодействия).
  //   Замеренный рост — 1.1KB на чарт-маршрут; берём 2KB, потому что все четыре бюджета опять
  //   стояли впритык. Урезать правдивый текст ради 300 байт — ложная экономия.
  // 2026-08-14: +3KB — волна полировки графиков (см. overviewCode).
  // 2026-08-18: +2KB — цифровой морф KPI + «Мин · Макс» (см. overviewCode).
  // 2026-08-25: +2KB — семья метрик `cdek-*` в ОБЩЕМ диспетчере /metrics (реестр ключей +
  //   ленивая ветка страницы). Диспетчер один на все метрик-маршруты, поэтому новая семья
  //   стоит каждому из них ~0.1–1.1KB; сама страница СДЭКа лежит в своём чанке и грузится
  //   только по своему ключу. Без этой семьи разворот карточек СДЭКа падал в инлайновый
  //   оверлей вместо страницы метрики — источник вёл себя не как соседние.
  telegramMetricCode: 349 * KB,
  // 2026-07-28: +1KB — sync-hover графиков (chartHoverSync в LineChart/Sparkline, волна D).
  // 2026-07-29: +1KB — официальный Radix ToggleGroup заменил самописную механику SegmentedControl.
  // 2026-08-11: +1KB — честность графиков: робастный домен искры (robustDomain) + подсветка
  //   пропусков штриховкой в LineChart/BarChart. Замер: маршрут рос на 0.5KB, оба бюджета стояли
  //   впритык (mentions 316.8/317.0). Берём 1KB, чтобы следующая правка снова не легла на кромку.
  // 2026-08-11: гейт (hover: hover) and (pointer: fine) для hover-МОТОРИКИ добавляет ~0.1KB общего
  //   route-CSS (разделение :hover/:focus-visible в сайдбаре + два @custom-variant). Ложится в тот
  //   же килобайт выше, отдельного запаса не берём — фактический замер после ребейза ниже потолка.
  // 2026-08-11: +2KB — сверка «О метрике» с кодом: 22 текста formula/included/sourceNote
  //   переписаны под то, что реально считают резолверы (ym.users предупреждал о завышении,
  //   которого нет; ig.formats звался распределением публикаций, а суммировал взаимодействия).
  //   Замеренный рост — 1.1KB на чарт-маршрут; берём 2KB, потому что все четыре бюджета опять
  //   стояли впритык. Урезать правдивый текст ради 300 байт — ложная экономия.
  // 2026-08-14: +3KB — волна полировки графиков (см. overviewCode).
  // 2026-08-18: +2KB — цифровой морф KPI + «Мин · Макс» (см. overviewCode).
  mentionsMetricCode: 327 * KB,
};

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

function printRoute(label, route, codeLimit, jsLimit) {
  const limits = [
    jsLimit ? `JS≤${kb(jsLimit)}KB` : null,
    codeLimit ? `code≤${kb(codeLimit)}KB` : null,
  ].filter(Boolean).join(' · ');
  console.log(
    `${label.padEnd(19)} ${route.jsRows.length} JS + ${route.cssRows.length} CSS · ` +
      `${kb(route.jsGzip)}KB JS / ${kb(route.codeGzip)}KB code${limits ? ` · ${limits}` : ''}`,
  );
}

printRoute('public boot', routes.boot, BUDGETS.publicBootCode, BUDGETS.publicBootJs);
console.log(
  `${'public resources'.padEnd(19)} ${kb(bootResources)}KB incl. ${fontRows.length} fonts ` +
    `(${kb(fontGzip)}KB) · total≤${kb(BUDGETS.publicBootResources)}KB`,
);
printRoute('landing', routes.landing, BUDGETS.landingCode);
console.log(
  `${'landing resources'.padEnd(19)} ${kb(landingResources)}KB incl. fonts · ` +
    `total≤${kb(BUDGETS.landingResources)}KB`,
);
printRoute('auth', routes.auth, BUDGETS.authCode);
printRoute('protected shell', routes.protected, BUDGETS.protectedCode, BUDGETS.protectedJs);
printRoute('tg overview', routes.overview, BUDGETS.overviewCode);
printRoute('metric dispatcher', routes.metricDispatcher, BUDGETS.metricDispatcherCode);
printRoute('generic metric', routes.genericMetric, BUDGETS.genericMetricCode);
printRoute('instagram metric', routes.instagramMetric, BUDGETS.instagramMetricCode);
printRoute('moysklad metric', routes.moySkladMetric, BUDGETS.moySkladMetricCode);
printRoute('metrika metric', routes.metrikaMetric, BUDGETS.metrikaMetricCode);
printRoute('telegram metric', routes.telegramMetric, BUDGETS.telegramMetricCode);
printRoute('mentions metric', routes.mentionsMetric, BUDGETS.mentionsMetricCode);
console.log(
  `entry chunk         ${kb(entryRaw)}KB raw / ${kb(entryGzip)}KB gzip · ` +
    `raw≤${kb(BUDGETS.entryRaw)}KB · ${relative(root, entryPath).replace(/\\/g, '/')}`,
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

const problems = [];
const check = (actual, limit, label) => {
  if (actual > limit) problems.push(`${label}: ${kb(actual)}KB · limit ${kb(limit)}KB`);
};
check(entryRaw, BUDGETS.entryRaw, 'entry raw too large');
check(routes.boot.jsGzip, BUDGETS.publicBootJs, 'public boot JS too large');
check(routes.boot.codeGzip, BUDGETS.publicBootCode, 'public boot code too large');
check(bootResources, BUDGETS.publicBootResources, 'public boot resources too large');
check(routes.landing.codeGzip, BUDGETS.landingCode, 'landing code too large');
check(landingResources, BUDGETS.landingResources, 'landing resources too large');
check(routes.auth.codeGzip, BUDGETS.authCode, 'auth route code too large');
check(routes.protected.jsGzip, BUDGETS.protectedJs, 'protected shell JS too large');
check(routes.protected.codeGzip, BUDGETS.protectedCode, 'protected shell code too large');
check(routes.overview.codeGzip, BUDGETS.overviewCode, 'TG overview route code too large');
check(
  routes.metricDispatcher.codeGzip,
  BUDGETS.metricDispatcherCode,
  'metric dispatcher route code too large',
);
check(routes.genericMetric.codeGzip, BUDGETS.genericMetricCode, 'generic metric route code too large');
check(
  routes.instagramMetric.codeGzip,
  BUDGETS.instagramMetricCode,
  'Instagram metric route code too large',
);
check(
  routes.moySkladMetric.codeGzip,
  BUDGETS.moySkladMetricCode,
  'MoySklad metric route code too large',
);
check(
  routes.metrikaMetric.codeGzip,
  BUDGETS.metrikaMetricCode,
  'Metrika metric route code too large',
);
check(
  routes.telegramMetric.codeGzip,
  BUDGETS.telegramMetricCode,
  'Telegram extra metric route code too large',
);
check(
  routes.mentionsMetric.codeGzip,
  BUDGETS.mentionsMetricCode,
  'Mentions metric route code too large',
);

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
