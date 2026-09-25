#!/usr/bin/env node
// Гейт единообразия источников — регэксп-правила из guardrails программы унификации (PR 1.7).
//
// Сто сорок одно расхождение между шестью источниками выросло из копий: каждая вертикаль брала
// соседнюю и правила её по месту. Общие юниты (lib/comparison, lib/chartSeries, lib/periodWindow,
// components/metric, будущий lib/openDetail) закрывают расхождения по одному PR, но без гейта
// следующая вертикаль опять скопирует соседа — и закрытое расхождение откроется в новом файле.
//
// Долг НЕ чинится здесь: на текущем дереве нарушений сотни, их убирают фазы 2–7. Поэтому гейт
// работает по образцу scripts/lint-debt.mjs — трещоткой. Счётчик ведётся ПО ПРАВИЛУ И ПО ФАЙЛУ:
// общий счёт позволил бы починить пять нарушений в одном файле и завести пять в другом, а счёт по
// правилу — перенести копию из одной вертикали в другую. Пара (правило, файл) может только
// ужиматься; новое нарушение — ошибка. В фазе 8 (PR 8.3) baseline = 0 и гейт работает без него.
//
//   node scripts/consistency-lint.mjs                    → сверка с baseline, exit 1 при росте
//   node scripts/consistency-lint.mjs --list             → плюс каждая находка с номером строки
//   node scripts/consistency-lint.mjs --update-baseline  → зафиксировать текущее (в CI НИКОГДА)
//
// Правила регэксповые, и у них бывают ложные срабатывания (риск из плана 1.7). Для них —
// ALLOWLIST ниже: запись снимает ОДНО правило с ОДНОГО файла и без обоснования не принимается.
// Комментарии в исходниках правила не видят: они вырезаются до сверки (maskComments), иначе
// каждое «даунсэмплим через lttbDownsample» в пояснении считалось бы нарушением.
//
// Чего здесь нет осознанно (и где оно живёт):
//   • серверный гвард (isDayKey/parse*Period/res.status(401)/cacheGet в routes) — расширение
//     scripts/check-server-boundaries.mjs с 2.5, это не фронтенд;
//   • контракт ChartSection (ровно один из drillTo | expandList | noExpand) — AST-тест
//     chartSectionContract.test.ts с 4.2: спред-пропы регэкспом не разобрать;
//   • полнота каталога метрик — lib/metricIndex.test.ts (1.4);
//   • «Фильтры таблиц только через useTableUrlState» — только сортировка: состояние поиска/фильтра
//     (`[query, setQuery]`) регэкспом не отличить от поиска в палитре команд или пикере.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');
const BASELINE_PATH = join(root, 'scripts', 'consistency-lint-baseline.json');

// ── Разбор исходника ────────────────────────────────────────────────────────────────────────────

/**
 * Комментарии → пробелы, переводы строк и строки-литералы — как были.
 *
 * Номера строк и смещения сохраняются, поэтому находка указывает в исходник. Строки НЕ трогаются:
 * часть правил ищет именно литерал ('/metrics…'). Это не парсер TypeScript, а конечный автомат на
 * четыре состояния (код, строка, шаблон с `${}` любой вложенности, regex-литерал): его ошибка
 * стоит в худшем случае одной строки — строковый литерал обрывается на переводе строки.
 */
export function maskComments(text) {
  const out = text.split('');
  const n = text.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  // Стек контекстов: 'tpl' — внутри шаблонной строки, число — глубина `{` внутри `${…}`.
  const stack = [];
  let prev = ''; // последний значимый символ кода — отличает regex-литерал от деления
  let word = ''; // последнее слово кода — `return /re/` тоже regex
  const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', ';', '+', '-', '*', '%', '>', '~', '^', '']);
  const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'yield', 'await']);
  let i = 0;
  while (i < n) {
    const c = text[i];
    const top = stack[stack.length - 1];
    if (top === 'tpl') {
      if (c === '\\') i += 2;
      else if (c === '`') {
        stack.pop();
        prev = '`';
        i += 1;
      } else if (c === '$' && text[i + 1] === '{') {
        stack.push(0);
        i += 2;
      } else i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      let end = text.indexOf('\n', i);
      if (end === -1) end = n;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      let end = text.indexOf('*/', i + 2);
      end = end === -1 ? n : end + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < n && text[k] !== c && text[k] !== '\n') k += text[k] === '\\' ? 2 : 1;
      i = k + 1;
      prev = c;
      word = '';
      continue;
    }
    if (c === '`') {
      stack.push('tpl');
      i += 1;
      continue;
    }
    if (c === '/' && (REGEX_AFTER.has(prev) || REGEX_AFTER_WORD.has(word))) {
      // regex-литерал: до неэкранированного `/` вне класса; перевод строки — это было деление
      let k = i + 1;
      let inClass = false;
      while (k < n && text[k] !== '\n') {
        if (text[k] === '\\') {
          k += 2;
          continue;
        }
        if (text[k] === '[') inClass = true;
        else if (text[k] === ']') inClass = false;
        else if (text[k] === '/' && !inClass) break;
        k += 1;
      }
      if (k < n && text[k] === '/') {
        i = k + 1;
        prev = ')';
        word = '';
        continue;
      }
    }
    if (typeof top === 'number') {
      if (c === '{') stack[stack.length - 1] = top + 1;
      else if (c === '}') {
        if (top === 0) {
          stack.pop();
          i += 1;
          continue;
        }
        stack[stack.length - 1] = top - 1;
      }
    }
    if (/[\w$]/.test(c)) {
      word = /[\w$]/.test(text[i - 1] ?? '') ? word + c : c;
      prev = c;
    } else if (!/\s/.test(c)) {
      prev = c;
      word = '';
    }
    i += 1;
  }
  return out.join('');
}

function lineAt(text, offset) {
  let line = 1;
  for (let k = 0; k < offset && k < text.length; k++) if (text.charCodeAt(k) === 10) line += 1;
  return line;
}

/** Статические import/export-from. `type` — весь оператор только про типы (в бандл не едет). */
function importStatements(text) {
  const out = [];
  const re = /\b(import|export)\s+(type\s+)?([^;'"`]*?)\s*\bfrom\s+(['"])([^'"]+)\4/g;
  for (const m of text.matchAll(re)) {
    const clause = m[3];
    const clauseAt = m.index + m[0].indexOf(clause, m[1].length);
    const specifiers = [];
    const braces = clause.indexOf('{');
    if (braces !== -1) {
      const inner = clause.slice(braces + 1, clause.lastIndexOf('}') === -1 ? clause.length : clause.lastIndexOf('}'));
      for (const s of inner.matchAll(/(type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+[A-Za-z_$][\w$]*)?/g)) {
        specifiers.push({ name: s[2], type: Boolean(s[1]), offset: clauseAt + braces + 1 + s.index });
      }
    }
    const lead = /^\s*([A-Za-z_$][\w$]*)/.exec(clause);
    if (m[1] === 'import' && lead && lead[1] !== 'type') specifiers.push({ name: lead[1], type: false, offset: clauseAt });
    const typeOnly = Boolean(m[2]) || (specifiers.length > 0 && specifiers.every((s) => s.type));
    out.push({
      from: m[5],
      typeOnly,
      specifiers,
      startLine: lineAt(text, m.index),
      endLine: lineAt(text, m.index + m[0].length),
    });
  }
  return out;
}

/** Атрибуты JSX-тега `<Name …>`: текст от имени до `>` на нулевой глубине фигурных скобок. */
function jsxTags(text, name) {
  const out = [];
  const re = new RegExp(`<${name}\\b`, 'g');
  for (const m of text.matchAll(re)) {
    let depth = 0;
    let k = m.index + m[0].length;
    while (k < text.length) {
      const c = text[k];
      if (c === '{') depth += 1;
      else if (c === '}') depth -= 1;
      else if ((c === "'" || c === '"') && depth === 0) {
        const close = text.indexOf(c, k + 1);
        k = close === -1 ? text.length : close;
      } else if (c === '>' && depth === 0) break;
      k += 1;
    }
    out.push({ start: m.index, attrs: text.slice(m.index, k) });
  }
  return out;
}

/** Значение атрибута `name={…}` со сбалансированными скобками, со смещением от начала тега. */
function jsxAttr(attrs, name) {
  const m = new RegExp(`(?<![\\w-])${name}=\\{`).exec(attrs);
  if (!m) return null;
  let depth = 1;
  let k = m.index + m[0].length;
  const from = k;
  while (k < attrs.length && depth > 0) {
    if (attrs[k] === '{') depth += 1;
    else if (attrs[k] === '}') depth -= 1;
    k += 1;
  }
  return { value: attrs.slice(from, k - 1), offset: m.index };
}

/**
 * Строки тела top-level объявления `function Name` — от него до следующего объявления с нулевой
 * колонки. Исходники отформатированы, так что соседнее объявление всегда начинается с колонки 0;
 * комментарии к этому моменту уже вырезаны и границу не сбивают.
 */
function declarationLines(lines, name) {
  const head = new RegExp(`^(?:export\\s+)?(?:default\\s+)?function\\s+${name}\\b`);
  const start = lines.findIndex((l) => head.test(l));
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !/^(?:export|function|const|let|class|interface|type|enum|async)\b/.test(lines[end])) end += 1;
  return { from: start + 1, to: end };
}

/** Находки по строкам: для каждой строки, где `test` верен, — одна находка. */
function byLine(lines, test, range = { from: 1, to: lines.length }) {
  const out = [];
  for (let i = range.from - 1; i < range.to; i++) if (test(lines[i], i + 1)) out.push({ line: i + 1 });
  return out;
}

// ── Правила ─────────────────────────────────────────────────────────────────────────────────────

const PANELS = (rel) => rel.startsWith('src/panels/');

/** Где разрешён вход в разбор (5.x). Файла пока нет — правило считает его разрешённым заранее. */
const OPEN_DETAIL = 'src/lib/openDetail.ts';

const CHROME_DEFINITION =
  /^\s*(?:export\s+)?(?:default\s+)?(?:function|const|let|class)\s+(\w*MetricShell|\w*ReportCard|\w*WindowBar|ComparisonReadout|No\w*Comparison|ChartTypeIcon)\b/;
const CHROME_IMPORTS = new Set(['RailWindowTotal', 'SegSelect', 'WindowBarShell', 'PeriodChips', 'MetricPageHeader']);

/** Графиковые компоненты — файлом целиком: весь их цвет обязан идти через chart-role токены. */
const CHART_FILES = new Set(
  [
    'BarChart',
    'LineChart',
    'MultiLineChart',
    'Sparkline',
    'SparklineSeries',
    'InlineSpark',
    'PieChart',
    'DivergingBars',
    'RankChart',
    'RadialGauge',
    'RadialShare',
    'GaugeArc',
    'ChartBand',
    'ChartFill',
    'ChartGapPattern',
    'ChartTooltip',
    'MorphingSeries',
    'ChartWidget',
    'HeatmapVerdict',
    'PivotTable',
  ]
    .map((name) => `src/components/${name}.tsx`)
    .concat(['src/panels/HeatmapSurface.tsx', 'src/panels/ActivityCalendar.tsx']),
);
/**
 * Тепловые сетки, живущие ВНУТРИ больших файлов страниц: сверяется только тело объявления —
 * кнопки и чипы той же страницы законно красятся bg-primary.
 */
const HEAT_GRIDS = {
  'src/panels/metrika/YmOverview.tsx': ['YmHourlyCard'],
  'src/panels/metrika/YmMetricPage.tsx': ['YmHourlyPage'],
  'src/panels/cdek/CdekOrders.tsx': ['RhythmHeatmap'],
  'src/panels/cdek/CdekImports.tsx': ['CoverageCalendar'],
  'src/components/instagram/audience.tsx': ['BestTimeHeatmap'],
  'src/panels/sklad/MsClients.tsx': ['MsCohortsTable'],
};
const RAW_CHART_COLOUR =
  /--brand-iris\b|\bbg-primary(?![\w-])|\b(?:text|bg|fill|stroke|border|ring|outline|from|via|to|decoration|accent|shadow)-(?:verdant|ember)\b|--(?:brand|color)-(?:verdant|ember)\b/;

/** Общий слой, который обязан оставаться лёгким (импорт-гвард бандла). */
const SHARED_LAYER_FILES = new Set([
  OPEN_DETAIL,
  'src/lib/chartSeries.ts',
  'src/lib/periodWindow.ts',
  'src/lib/comparison.ts',
  'src/lib/metricIndex.ts',
]);
const SOURCE_MODULE = /(?:^|\/)panels\/|(?:^|\/)api\/(?:ms|ym|cdek|rusender)(?:\.ts)?$/;

export const RULES = [
  {
    id: 'no-direct-metric-nav',
    hint: `в разбор ведёт один вход — ${OPEN_DETAIL} (5.x): он засевает окно и канал сам`,
    applies: (rel) => rel !== OPEN_DETAIL,
    check({ text, lines }) {
      // Засев окна руками: переменная, связанная с usePeriod(), и её setDays/setRange.
      const seeders = [...text.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*usePeriod\(\s*\)/g)].map((m) =>
        m[1].replace(/\$/g, '\\$'),
      );
      const seed = new RegExp(`(?:\\busePeriod\\(\\s*\\)${seeders.map((s) => `|(?<![\\w$])${s}`).join('')})\\.(?:setDays|setRange)\\(`);
      return byLine(
        lines,
        (l) =>
          /\b(?:vtNavigate|navigate)\(\s*['"`]\/metrics\b/.test(l) ||
          // `to=` у Link и у обёрток, которые рендерят Link (карточки отчёта, QuietLink)
          /\bto=\{?\s*['"`]\/metrics\b/.test(l) ||
          /\b(?:vtNavigate|navigate)\(\s*drillTo\b/.test(l) ||
          seed.test(l),
      );
    },
  },
  {
    id: 'no-local-explorer-chrome',
    hint: 'хром разбора — из components/metric (MetricReportCard/ExplorerShell), а не своя копия в панели',
    applies: PANELS,
    check({ text, lines }) {
      const out = byLine(lines, (l) => CHROME_DEFINITION.test(l));
      for (const stmt of importStatements(text)) {
        if (stmt.typeOnly) continue;
        for (const s of stmt.specifiers) {
          if (!s.type && CHROME_IMPORTS.has(s.name)) out.push({ line: lineAt(text, s.offset), key: s.name });
        }
      }
      return out;
    },
  },
  {
    id: 'no-local-downsample',
    hint: 'кап и прореживание ряда — только prepareChartSeries (lib/chartSeries), а не LTTB/порог по месту',
    applies: (rel) => rel !== 'src/lib/chartSeries.ts' && rel !== 'src/lib/downsample.ts',
    check({ text, lines }) {
      const importLines = new Set();
      for (const stmt of importStatements(text)) for (let l = stmt.startLine; l <= stmt.endLine; l++) importLines.add(l);
      return byLine(lines, (l, no) => {
        if (importLines.has(no)) return false;
        if (/\bfunction\s+(?:lttbDownsample|pickIndexes|strideEvery)\b/.test(l)) return false;
        return (
          /\b(?:lttbDownsample|pickIndexes|strideEvery)\s*(?:<[^<>()]*>)?\s*\(/.test(l) ||
          /\bCHART_MAX_POINTS\b/.test(l) ||
          /\b[A-Z][A-Z0-9_]*(?:MAX_POINTS|POINTS_MAX|MAX_PTS)[A-Z0-9_]*\s*=\s*\d/.test(l)
        );
      });
    },
  },
  {
    id: 'no-null-to-zero',
    hint: 'пропуск — это null и разрыв линии, а не 0: не глушите его `?? 0` в рядах и нормализаторах',
    applies: () => true,
    check: ({ lines }) =>
      byLine(
        lines,
        (l) =>
          /\bNumber\(\s*[^()]*?\?\?\s*0\s*\)/.test(l) ||
          // значения и призрак, которые уходят в примитив графика
          /\b(?:values|ghost)\s*[:=](?![=>])[^;]*?\?\?\s*0(?![\d.])/.test(l),
      ),
  },
  {
    id: 'no-local-explorer-state',
    hint: 'окно, тип графика и сравнение разбора живут в URL через useExplorerState; сортировка таблиц — useTableUrlState',
    applies: (rel) => PANELS(rel) || rel.startsWith('src/components/'),
    check({ rel, lines }) {
      const explorer = /^src\/panels\/(?:.*\/)?\w*MetricPage\.tsx$/.test(rel);
      return byLine(
        lines,
        (l) =>
          (explorer &&
            (/\buseState<\s*PeriodDays\s*>/.test(l) ||
              /\buseState\(\s*30\s*\)/.test(l) ||
              /\buseState<\s*(['"])(?:line|bar)\1\s*\|\s*(['"])(?:line|bar)\2\s*>/.test(l) ||
              /\bconst\s*\[\s*(?:kind|chartKind|viz|cmp|compare|compareMode)\s*,\s*[\w$]+\s*\]\s*=\s*useState\b/.test(l) ||
              /\bsetSearchParams\s*\(/.test(l))) ||
          /\bconst\s*\[\s*(?:sort|sortKey|sortBy|sortDir|sortOrder|order|orderBy)\s*,\s*[\w$]+\s*\]\s*=\s*useState\b/.test(l),
      );
    },
  },
  {
    id: 'no-inline-delta',
    hint: 'дельта к базе — compareWindows/formatDelta из lib/comparison: одно правило базы ≤ 0 и «±» для нуля',
    applies: (rel) => rel !== 'src/lib/comparison.ts',
    check: ({ lines }) =>
      byLine(lines, (l) => {
        for (const m of l.matchAll(/\(\s*([\w$.?[\]]+)\s*-\s*([\w$.?[\]]+)\s*\)\s*\/\s*(?:Math\.abs\(\s*)?([\w$.?[\]]+)/g)) {
          if (m[3] === m[2]) return true;
        }
        return /\b(?:delta|diff|change)\w*\s*\/\s*(?:Math\.abs\(\s*)?(?:prev|previous|base|baseline)\w*\b/.test(l);
      }),
  },
  {
    id: 'no-raw-kpi-format',
    hint: 'число карточки — formatMetricNumber(…, headline) из lib/metricNumber, процент — через lib/format',
    applies: (rel) => rel !== 'src/lib/format.ts' && rel !== 'src/lib/metricNumber.ts',
    check({ rel, text, lines }) {
      const out = byLine(lines, (l) => /\.toFixed\([^()]*\)\s*\}?\s*(?:\+\s*)?['"`]?\s*%/.test(l));
      for (const tag of ['KpiValue', 'ChartCardBody']) {
        for (const { start, attrs } of jsxTags(text, tag)) {
          const value = jsxAttr(attrs, 'value');
          if (value && /\bfmt\.(?:short|num|kpi)\s*\(/.test(value.value)) {
            out.push({ line: lineAt(text, start + value.offset), key: tag });
          }
        }
      }
      if (rel.startsWith('src/lib/widgetResolver/')) {
        out.push(...byLine(lines, (l) => /\bout\.value\s*=(?!=)[^;]*\bfmt\.(?:short|num|kpi)\s*\(/.test(l)));
      }
      return out;
    },
  },
  {
    id: 'no-raw-chart-colour',
    hint: 'график и тепловая сетка красятся chart-role токенами (--chart-role-*), а не --brand-iris/bg-primary/verdant/ember',
    applies: (rel) => CHART_FILES.has(rel) || rel in HEAT_GRIDS,
    check({ rel, lines }) {
      if (CHART_FILES.has(rel)) return byLine(lines, (l) => RAW_CHART_COLOUR.test(l));
      const out = [];
      for (const name of HEAT_GRIDS[rel]) {
        const range = declarationLines(lines, name);
        if (range) out.push(...byLine(lines, (l) => RAW_CHART_COLOUR.test(l), range));
      }
      return out;
    },
  },
  {
    id: 'shared-layer-imports',
    hint: 'общий слой не тянет panels/** и api/<source>.ts — иначе вертикаль источника едет в общий чанк',
    applies: (rel) => rel.startsWith('src/components/metric/') || SHARED_LAYER_FILES.has(rel),
    check({ text }) {
      return importStatements(text)
        .filter((stmt) => !stmt.typeOnly && SOURCE_MODULE.test(stmt.from))
        .map((stmt) => ({ line: stmt.startLine, key: stmt.from }));
    },
  },
];

/**
 * Ложные срабатывания — ПО ФАЙЛУ и ПО ПРАВИЛУ, с обоснованием. Запись снимает с файла одно правило
 * целиком, поэтому `why` обязан объяснить, почему совпадение в этом файле — не то, что правило
 * запрещает. Настоящий долг сюда не кладётся: для него есть baseline, который может только убывать.
 */
export const ALLOWLIST = [
  {
    rule: 'no-local-downsample',
    file: 'src/components/LineChart.tsx',
    why: 'RING_MAX_POINTS — порог показа колец на точках короткого ряда, а не кап прореживания',
  },
  {
    rule: 'no-local-downsample',
    file: 'src/lib/useMorphValues.ts',
    why: 'CHART_MAX_POINTS здесь — бюджет анимации (длинный ряд не морфится покадрово), ряд не прореживается',
  },
  {
    rule: 'no-inline-delta',
    file: 'src/lib/demoMsFixtures.ts',
    why: 'демо-фикстура воспроизводит серверный deltaPct ответа /api/ms/top-products, а не считает дельту для экрана',
  },
];

/** Ошибки самого allowlist: неизвестное правило, путь вне src/, пустое обоснование. */
export function allowlistErrors(allowlist = ALLOWLIST, rules = RULES) {
  const ids = new Set(rules.map((r) => r.id));
  const errors = [];
  for (const entry of allowlist) {
    if (!ids.has(entry.rule)) errors.push(`allowlist: неизвестное правило «${entry.rule}» (${entry.file})`);
    if (typeof entry.file !== 'string' || !entry.file.startsWith('src/')) errors.push(`allowlist: путь «${entry.file}» не от src/`);
    if (typeof entry.why !== 'string' || entry.why.trim().length < 20) {
      errors.push(`allowlist: у записи ${entry.rule} → ${entry.file} нет обоснования (why)`);
    }
  }
  return errors;
}

// ── Прогон ──────────────────────────────────────────────────────────────────────────────────────

/** Находки одного файла: [{ rule, file, line, snippet }], уже без allowlist. */
export function lintSource(rel, raw, { rules = RULES, allowlist = ALLOWLIST, suppressed } = {}) {
  const text = maskComments(raw);
  const lines = text.split('\n');
  const rawLines = raw.split('\n');
  const findings = [];
  for (const rule of rules) {
    if (!rule.applies(rel)) continue;
    const allowed = allowlist.find((a) => a.rule === rule.id && a.file === rel);
    const seen = new Set();
    for (const f of rule.check({ rel, text, lines }).sort((a, b) => a.line - b.line)) {
      const key = `${f.line}:${f.key ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (allowed) {
        suppressed?.add(allowed);
        continue;
      }
      findings.push({ rule: rule.id, file: rel, line: f.line, snippet: (rawLines[f.line - 1] ?? '').trim() });
    }
  }
  return findings;
}

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !name.endsWith('.d.ts')) yield p;
  }
}

/** { [rule]: { [file]: n } } — ровно та форма, что лежит в baseline.rules[*].files. */
export function countFindings(findings) {
  const counts = {};
  for (const f of findings) {
    counts[f.rule] ??= {};
    counts[f.rule][f.file] = (counts[f.rule][f.file] ?? 0) + 1;
  }
  return counts;
}

// Порядок по кодовым единицам, а не localeCompare: baseline не должен переупорядочиваться от
// локали машины, на которой его обновили.
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function toBaseline(counts, rules = RULES) {
  const out = { total: 0, rules: {} };
  for (const { id } of rules) {
    const files = Object.fromEntries(Object.entries(counts[id] ?? {}).sort(([a], [b]) => byCode(a, b)));
    const total = Object.values(files).reduce((a, b) => a + b, 0);
    out.rules[id] = { total, files };
    out.total += total;
  }
  return out;
}

/** Сверка по паре (правило, файл): рост — ошибка, убыль — повод ужать baseline. */
export function compareToBaseline(counts, baseline) {
  const grown = [];
  const shrunk = [];
  const ruleIds = new Set([...Object.keys(counts), ...Object.keys(baseline.rules ?? {})]);
  for (const rule of ruleIds) {
    const now = counts[rule] ?? {};
    const was = baseline.rules?.[rule]?.files ?? {};
    for (const file of new Set([...Object.keys(now), ...Object.keys(was)])) {
      const n = now[file] ?? 0;
      const w = was[file] ?? 0;
      if (n > w) grown.push({ rule, file, was: w, now: n });
      else if (n < w) shrunk.push({ rule, file, was: w, now: n });
    }
  }
  const order = (a, b) => byCode(a.rule, b.rule) || byCode(a.file, b.file);
  return { grown: grown.sort(order), shrunk: shrunk.sort(order) };
}

function main(argv) {
  const update = argv.includes('--update-baseline');
  const list = argv.includes('--list');

  const listErrors = allowlistErrors();
  if (listErrors.length) {
    for (const e of listErrors) console.error(e);
    process.exit(1);
  }

  const suppressed = new Set();
  const findings = [];
  let scanned = 0;
  for (const file of walk(srcDir)) {
    const rel = relative(root, file).replace(/\\/g, '/');
    findings.push(...lintSource(rel, readFileSync(file, 'utf8'), { suppressed }));
    scanned += 1;
  }
  // Пустой обход прошёл бы «зелёным» ни на чём — а он же признак сломанного пути.
  if (scanned === 0) {
    console.error('consistency-lint: не найдено ни одного исходника в src/ — гейт не может судить.');
    process.exit(1);
  }
  for (const entry of ALLOWLIST) {
    if (!suppressed.has(entry)) console.log(`  allowlist: ${entry.rule} → ${entry.file} больше ничего не гасит — запись можно удалить`);
  }

  const counts = countFindings(findings);
  if (list) {
    for (const f of findings) console.log(`  ${f.file}:${f.line}  [${f.rule}]  ${f.snippet}`);
  }

  if (update) {
    const baseline = toBaseline(counts);
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`baseline записан — нарушений в долге: ${baseline.total}, правил: ${Object.keys(baseline.rules).length}`);
    for (const [id, r] of Object.entries(baseline.rules)) console.log(`  ${id}  ${r.total}`);
    process.exit(0);
  }

  if (!existsSync(BASELINE_PATH)) {
    console.error('consistency-lint: нет baseline. Запустите `npm run lint:consistency -- --update-baseline`.');
    process.exit(1);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
  const { grown, shrunk } = compareToBaseline(counts, baseline);

  for (const { rule, file, was, now } of shrunk) console.log(`  ужалось: [${rule}] ${file}  ${was} → ${now}`);
  if (shrunk.length) console.log('  зафиксировать: npm run lint:consistency -- --update-baseline\n');

  if (grown.length) {
    const hints = Object.fromEntries(RULES.map((r) => [r.id, r.hint]));
    console.error('Новые нарушения единообразия источников:\n');
    for (const { rule, file, was, now } of grown) {
      console.error(`  [${rule}] ${file}  ${was} → ${now}  (+${now - was})`);
      console.error(`      ${hints[rule] ?? ''}`);
      for (const f of findings.filter((x) => x.rule === rule && x.file === file)) {
        console.error(`      ${f.file}:${f.line}  ${f.snippet}`);
      }
    }
    console.error(
      '\nДолг может только убывать: новое нарушение чинится через общий юнит из подсказки.' +
        '\nЛожное срабатывание регэкспа — запись в ALLOWLIST (scripts/consistency-lint.mjs) с обоснованием.' +
        '\nОсознанный рост — `npm run lint:consistency -- --update-baseline` и объяснение в описании PR.',
    );
    process.exit(1);
  }

  const total = findings.length;
  console.log(`единообразие источников — долг: ${total} (потолок ${baseline.total}), новых нарушений нет`);
  for (const { id } of RULES) console.log(`  ${id}  ${Object.values(counts[id] ?? {}).reduce((a, b) => a + b, 0)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
