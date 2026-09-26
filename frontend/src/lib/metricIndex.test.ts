import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'vite';
import { describe, expect, it } from 'vitest';
import { DRILL_KEYS } from '@/lib/kpiDerive';
import {
  METRIC_INDEX,
  METRIC_INDEX_ENTRIES,
  TG_CORE_METRIC_KEYS,
  WIDGET_METRIC_IDS,
  capabilitiesOf,
  kindOf,
  metricByRoute,
  metricEntry,
  metricRoute,
  type MetricViz,
} from '@/lib/metricIndex';
import { routeNetworkOwner } from '@/lib/networks';
import { WIDGET_METRICS } from '@/lib/widgetMetrics';
import { CAMPAIGN_METRIC_KEYS } from '@/panels/campaign/campaignMetricKeys';
import { CDEK_METRIC_KEYS } from '@/panels/cdek/cdekMetricKeys';
import { IG_CHART_METRIC_KEYS, IG_EXPLORER_METRIC_KEYS } from '@/panels/igMetricKeys';
import { MENTIONS_METRIC_KEYS } from '@/panels/mentions/mentionsMetricKeys';
import { YM_METRIC_KEYS } from '@/panels/metrika/ymMetricKeys';
import { RUSENDER_METRIC_KEYS } from '@/panels/rusender/rusenderMetricKeys';
import { MS_METRIC_KEYS } from '@/panels/sklad/msMetricKeys';
import { TG_EXTRA_METRIC_KEYS } from '@/panels/tgMetricKeys';

/** Каждый ключ маршрута — через ПУБЛИЧНЫЕ обёртки, которыми пользуются диспетчер и страницы. */
const METRICS_ROUTE_KEYS: readonly string[] = [
  ...DRILL_KEYS,
  ...TG_EXTRA_METRIC_KEYS,
  ...IG_EXPLORER_METRIC_KEYS,
  ...IG_CHART_METRIC_KEYS,
  ...MS_METRIC_KEYS,
  ...YM_METRIC_KEYS,
  ...CDEK_METRIC_KEYS,
  ...RUSENDER_METRIC_KEYS,
  ...MENTIONS_METRIC_KEYS,
];

const SOURCES = new Set(['tg', 'ig', 'ms', 'ym', 'cdek', 'rusender', 'multi']);
const KINDS = new Set(['flow', 'stock', 'ratio']);
const UNITS = new Set(['number', 'percent', 'posts', 'views', 'currency']);
const VIZ = new Set<MetricViz>([
  'kpi', 'line', 'bar', 'donut', 'list', 'rank', 'pivot', 'table', 'ledger', 'heatmap', 'scatter', 'funnel',
]);
const WINDOWS = new Set(['explorer', 'local', 'fixed', 'none']);
const COMPARE_ORDER = ['off', 'prev', 'year'];

const routed = METRIC_INDEX_ENTRIES.filter((entry) => entry.route != null);

/** Литерал `const <name> = { ключ: строка | boolean, … }` из исходника. Так индекс сверяется с
 *  константами страниц и резолвера, не импортируя сами React-модули в node-окружение тестов:
 *  поменяли константу там — тест здесь краснеет. */
/** Узел ESTree из `parseSync` (oxc внутри Vite). Компиляторного API у TypeScript 7 нет, поэтому
 *  исходники разбирает парсер, который уже есть в сборке. */
type AstNode = { type: string; start: number; end: number; [key: string]: unknown };

const isNode = (value: unknown): value is AstNode =>
  typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';

function walk(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(value)) for (const item of value) { if (isNode(item)) walk(item, visit); }
    else if (isNode(value)) walk(value, visit);
  }
}

function parseSource(file: string, source: string): AstNode {
  const { program, errors } = parseSync(file, source);
  if (errors.length > 0) throw new Error(`${file}: ${errors[0].message}`);
  return program as unknown as AstNode;
}

function readConstObject(relPath: string, name: string): Record<string, string | boolean> {
  const file = fileURLToPath(new URL(relPath, import.meta.url));
  const source = readFileSync(file, 'utf8');
  const hits: Array<Record<string, string | boolean>> = [];
  walk(parseSource(file, source), (node) => {
    const id = node.id as AstNode | undefined;
    const init = node.init as AstNode | null | undefined;
    if (
      node.type !== 'VariableDeclarator' ||
      id?.type !== 'Identifier' ||
      id.name !== name ||
      init?.type !== 'ObjectExpression'
    ) {
      return;
    }
    const out: Record<string, string | boolean> = {};
    for (const prop of init.properties as AstNode[]) {
      const keyNode = prop.key as AstNode | undefined;
      const valueNode = prop.type === 'Property' && !prop.computed ? (prop.value as AstNode) : null;
      const key = keyNode?.type === 'Identifier'
        ? (keyNode.name as string)
        : keyNode?.type === 'Literal' && typeof keyNode.value === 'string'
          ? keyNode.value
          : null;
      const raw = valueNode?.type === 'Literal' ? valueNode.value : undefined;
      const value = typeof raw === 'string' || typeof raw === 'boolean' ? raw : undefined;
      if (valueNode == null || key == null || value === undefined) {
        throw new Error(`${relPath} ${name}: не литерал — ${source.slice(prop.start, prop.end)}`);
      }
      out[key] = value;
    }
    hits.push(out);
  });
  if (hits.length !== 1) throw new Error(`${relPath}: ${name} найден ${hits.length} раз`);
  return hits[0];
}

describe('metricIndex — полнота', () => {
  it('у каждого ключа маршрута /metrics/* есть запись, и других /metrics-записей нет', () => {
    for (const key of METRICS_ROUTE_KEYS) {
      const entry = metricByRoute(key);
      expect(entry, `route key ${key}`).toBeDefined();
      expect(entry?.route).toEqual({ scope: 'metrics', key });
    }
    const indexed = routed.filter((entry) => entry.route?.scope === 'metrics').map((entry) => entry.route?.key);
    expect([...indexed].sort()).toEqual([...METRICS_ROUTE_KEYS].sort());
  });

  it('у каждого ключа разбора кампании есть запись в своей области маршрутов', () => {
    for (const key of CAMPAIGN_METRIC_KEYS) {
      expect(metricByRoute(key, 'campaign')?.route, key).toEqual({ scope: 'campaign', key });
      // Ключ кампании не маршрут /metrics/*: там 'sources'/'formats' никто не открывает.
      expect(metricByRoute(key)).toBeUndefined();
    }
  });

  it('TG core — те же шесть ключей, что kpiDerive.DRILL_KEYS', () => {
    expect([...TG_CORE_METRIC_KEYS]).toEqual([...DRILL_KEYS]);
  });

  it('у каждого widget id есть запись с той же структурой, что у каталога виджетов', () => {
    expect(WIDGET_METRICS.map((metric) => metric.id)).toEqual([...WIDGET_METRIC_IDS]);
    for (const metric of WIDGET_METRICS) {
      const entry = METRIC_INDEX[metric.id];
      expect(entry, metric.id).toBeDefined();
      expect(entry.widgetId).toBe(metric.id);
      expect(entry.widget?.shape).toBe(metric.kind);
      expect(entry.unit).toBe(metric.unit);
      expect(entry.source).toBe(metric.source);
      expect([...(entry.widget?.supportedViz ?? [])]).toEqual(metric.supportedViz);
      expect(entry.widget?.defaultViz).toBe(metric.defaultViz);
    }
    // И наоборот: widget-фасет есть только у метрик каталога виджетов.
    const withWidget = METRIC_INDEX_ENTRIES.filter((entry) => entry.widget).map((entry) => entry.id);
    expect(withWidget.sort()).toEqual([...WIDGET_METRIC_IDS].sort());
  });

  it('ids уникальны, пространство имён совпадает с источником', () => {
    const ids = METRIC_INDEX_ENTRIES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of METRIC_INDEX_ENTRIES) {
      const [space] = entry.id.split('.');
      const expected = space === 'mentions' ? 'tg' : space === 'campaign' ? 'multi' : space;
      expect(entry.source, entry.id).toBe(expected);
    }
  });

  it('метрика без маршрута — только виджет Главной', () => {
    const unrouted = METRIC_INDEX_ENTRIES.filter((entry) => entry.route == null);
    for (const entry of unrouted) expect(entry.widgetId, entry.id).toBe(entry.id);
    expect(unrouted.map((entry) => entry.id).sort()).toEqual([
      'ig.erv',
      'ig.netFollowers',
      'tg.erv',
      'tg.netGrowth',
      'tg.topPosts',
      'tg.virality',
      'tg.weeklyTable',
    ]);
  });
});

describe('metricIndex — форма записей', () => {
  it('у каждой записи есть kind, unit, capabilities, zeroBased и evaluative из словаря', () => {
    for (const entry of METRIC_INDEX_ENTRIES) {
      expect(SOURCES.has(entry.source), `source ${entry.id}`).toBe(true);
      expect(KINDS.has(entry.kind), `kind ${entry.id}`).toBe(true);
      expect(UNITS.has(entry.unit), `unit ${entry.id}`).toBe(true);
      expect(typeof entry.zeroBased, `zeroBased ${entry.id}`).toBe('boolean');
      expect(typeof entry.evaluative, `evaluative ${entry.id}`).toBe('boolean');
      expect(entry.supportedViz.length, `viz ${entry.id}`).toBeGreaterThan(0);
      expect(entry.supportedViz.every((viz) => VIZ.has(viz)), `viz vocab ${entry.id}`).toBe(true);
      expect(new Set(entry.supportedViz).size, `viz dupes ${entry.id}`).toBe(entry.supportedViz.length);
      expect(WINDOWS.has(entry.capabilities.window), `window ${entry.id}`).toBe(true);
    }
  });

  it('ratio несёт числитель и знаменатель, остальные — нет', () => {
    for (const entry of METRIC_INDEX_ENTRIES) {
      if (entry.kind === 'ratio') {
        expect(entry.ratio?.num, entry.id).toBeTruthy();
        expect(entry.ratio?.den, entry.id).toBeTruthy();
        expect(entry.ratio?.num).not.toBe(entry.ratio?.den);
      } else {
        expect(entry.ratio, entry.id).toBeUndefined();
      }
    }
  });

  it('stock рисуется только линией: столбцов нет ни в разборе, ни у виджета', () => {
    const stocks = METRIC_INDEX_ENTRIES.filter((entry) => entry.kind === 'stock');
    expect(stocks.length).toBeGreaterThan(0);
    for (const entry of stocks) {
      expect(entry.supportedViz, entry.id).not.toContain('bar');
      if (entry.widget?.shape === 'series') expect(entry.widget.supportedViz, entry.id).toEqual(['line']);
    }
    // Уровни, которые сегодня рисуются столбцами на своей странице (CHARTS-13), по канону — линия.
    expect(METRIC_INDEX['rusender.contacts'].supportedViz).toEqual(['line']);
    expect(METRIC_INDEX['rusender.unsubscribed'].supportedViz).toEqual(['line']);
  });

  it('kind не спорит с текущей агрегацией корзин виджета', () => {
    for (const entry of METRIC_INDEX_ENTRIES) {
      if (entry.widget?.seriesAgg === 'level') expect(entry.kind, entry.id).toBe('stock');
      if (entry.widget?.seriesAgg === 'mean') expect(entry.kind, entry.id).toBe('ratio');
    }
    // Средний чек — отношение, хотя виджет пока берёт последний день корзины (PERIOD-6).
    expect(kindOf('ms.avgCheck')).toBe('ratio');
    expect(METRIC_INDEX['ms.avgCheck'].ratio).toEqual({ num: 'revenue', den: 'orders' });
    expect(METRIC_INDEX['ms.avgCheck'].widget?.bucketAggOverride).toBe('level');
  });

  it('корзины виджета — ровно сегодняшние: seriesAgg каталога плюс докласификация резолвера', () => {
    // resolveWidgetMetric: getMetric(id)?.seriesAgg ?? SERIES_AGG_OVERRIDES[id] ?? 'flow'.
    const overrides = readConstObject('./resolveWidgetMetric.ts', 'SERIES_AGG_OVERRIDES');
    const recorded = Object.fromEntries(
      METRIC_INDEX_ENTRIES.flatMap((entry) =>
        entry.widget?.bucketAggOverride ? [[entry.id, entry.widget.bucketAggOverride] as const] : [],
      ),
    );
    expect(recorded).toEqual(overrides);
    for (const id of Object.keys(recorded)) {
      // Override работает только там, где каталог молчит, и в MetricDef не выносится.
      expect(METRIC_INDEX[id].widget?.seriesAgg, id).toBeUndefined();
      expect(WIDGET_METRICS.find((metric) => metric.id === id)?.seriesAgg, id).toBeUndefined();
    }
  });

  it('база оси Y — канон: уровни подогнаны под диапазон, потоки и отношения от нуля', () => {
    for (const entry of METRIC_INDEX_ENTRIES) {
      expect(entry.zeroBased, entry.id).toBe(entry.kind !== 'stock');
    }
    // Шесть KPI TG — то же, что MetricPage.ZERO_BASED (читается из самой страницы).
    const zeroBased = readConstObject('../panels/MetricPage.tsx', 'ZERO_BASED');
    expect(Object.keys(zeroBased).sort()).toEqual([...TG_CORE_METRIC_KEYS].sort());
    for (const key of TG_CORE_METRIC_KEYS) expect(metricByRoute(key)?.zeroBased, key).toBe(zeroBased[key]);
  });

  it('нейтральна только метрика упоминаний', () => {
    const neutral = METRIC_INDEX_ENTRIES.filter((entry) => !entry.evaluative).map((entry) => entry.id);
    expect(neutral.sort()).toEqual(['mentions.sources', 'mentions.timeline']);
  });

  it('OD-4 не решён: «Чистый прирост» TG и IG записан как есть — столбцы по умолчанию, линия вариантом', () => {
    for (const id of ['tg.netGrowth', 'ig.netFollowers']) {
      const entry = METRIC_INDEX[id];
      expect(entry.kind, id).toBe('flow');
      expect(entry.widget?.defaultViz, id).toBe('bar');
      expect(entry.widget?.supportedViz, id).toEqual(['bar', 'line']);
      expect(entry.supportedViz, id).toEqual(['bar', 'line']);
    }
  });
});

describe('metricIndex — возможности разбора', () => {
  it('у метрики без маршрута всё выключено', () => {
    for (const entry of METRIC_INDEX_ENTRIES.filter((item) => item.route == null)) {
      const caps = entry.capabilities;
      expect(caps.compare, entry.id).toEqual([]);
      expect(caps.grain, entry.id).toEqual([]);
      expect(caps.pin || caps.target || caps.goal || caps.allowAll || caps.customRange, entry.id).toBe(false);
      expect(caps.window, entry.id).toBe('none');
    }
  });

  it('сравнение в каноническом порядке и всегда с «Пред. периодом»', () => {
    for (const entry of routed) {
      const { compare } = entry.capabilities;
      expect([...compare], entry.id).toEqual(COMPARE_ORDER.filter((mode) => compare.includes(mode as never)));
      if (compare.length > 0) expect(compare, entry.id).toContain('prev');
    }
    // Rusender сравнивает всегда — переключателя «Выкл» нет.
    expect(capabilitiesOf('rusender.opens')?.compare).toEqual(['prev']);
  });

  it('грануляция, пин и цель — только у рядов с линией или столбцами', () => {
    for (const entry of routed) {
      const caps = entry.capabilities;
      const timeSeries = entry.supportedViz.includes('line') || entry.supportedViz.includes('bar');
      if (caps.grain.length > 0 || caps.pin || caps.target) expect(timeSeries, entry.id).toBe(true);
      if (caps.grain.length > 0) expect(caps.grain[0], entry.id).toBe('day');
    }
  });

  it('измерения rank/pivot есть только там, где есть сами проекции', () => {
    for (const entry of METRIC_INDEX_ENTRIES) {
      const projections = entry.supportedViz.includes('rank') || entry.supportedViz.includes('pivot');
      expect(entry.capabilities.dims.length > 0, entry.id).toBe(projections);
    }
  });

  it('«Всё» и «Свой период» бывают только у окна; потолки — только у Метрики и Rusender (IG — без потолка, OD-13)', () => {
    for (const entry of routed) {
      const caps = entry.capabilities;
      if (caps.customRange) expect(caps.window, entry.id).toBe('explorer');
      if (caps.allowAll) expect(['explorer', 'local'], entry.id).toContain(caps.window);
    }
    const capped = Object.fromEntries(
      routed.filter((entry) => entry.capabilities.maxRangeDays != null).map((entry) => [entry.id, entry.capabilities.maxRangeDays]),
    );
    for (const [id, days] of Object.entries(capped)) {
      const source = METRIC_INDEX[id].source;
      expect(days, id).toBe(400);
      expect(['ym', 'rusender'], id).toContain(source);
    }
    // Instagram читает архив ig_daily: окно не упирается в живые 90 дней Graph.
    expect(capabilitiesOf('ig.er')?.maxRangeDays).toBeNull();
    expect(capabilitiesOf('ig.formats')?.maxRangeDays).toBeNull();
    // Окно разбора Метрики и Rusender режет сервер (YM_RANGE_MAX_DAYS, RANGE_MAX_DAYS).
    expect(capabilitiesOf('ym.sources')?.maxRangeDays).toBe(400);
    expect(capabilitiesOf('rusender.contacts')?.maxRangeDays).toBe(400);
    // Дневной ряд Метрики — своё окно поверх полного архива, без потолка.
    expect(capabilitiesOf('ym.visits')?.maxRangeDays).toBeNull();
  });

  it('цель атрибуции — ровно у разрезов Метрики с селектором цели', () => {
    const withGoal = routed.filter((entry) => entry.capabilities.goal).map((entry) => entry.route?.key);
    expect(withGoal.sort()).toEqual(['ym-devices', 'ym-landings', 'ym-sources', 'ym-utm']);
  });

  it('разрез ряда: каналы МС и измерения СДЭКа (у среднего чека — без товара)', () => {
    expect(capabilitiesOf('ms.channels')?.split).toEqual(['channel']);
    expect(capabilitiesOf('cdek.revenue')?.split).toEqual(['channel', 'status', 'product', 'carrier']);
    expect(capabilitiesOf('cdek.avgCheck')?.split).not.toContain('product');
  });

  it('под разбивкой — только линия (канон U05); сравнение и цель — как страница рисует их сегодня', () => {
    for (const entry of METRIC_INDEX_ENTRIES) {
      const { split, splitView, compare, target } = entry.capabilities;
      expect(splitView != null, entry.id).toBe(split.length > 0);
      if (!splitView) continue;
      expect(splitView.viz, entry.id).toEqual(['line']);
      for (const viz of splitView.viz) expect(entry.supportedViz, entry.id).toContain(viz);
      if (splitView.compare) expect(compare.length, entry.id).toBeGreaterThan(0);
      if (splitView.target) expect(target, entry.id).toBe(true);
    }
    // МС: chart=bar в разбивке приводится к line; итог окна в рейле сравнивается и дальше.
    expect(capabilitiesOf('ms.channels')?.splitView).toEqual({ viz: ['line'], compare: true, target: false });
    // СДЭК: под разбивкой «Пред. период» и линия цели гаснут.
    for (const id of ['cdek.revenue', 'cdek.orders', 'cdek.avgCheck', 'cdek.units', 'cdek.price']) {
      expect(capabilitiesOf(id)?.splitView, id).toEqual({ viz: ['line'], compare: false, target: false });
    }
  });
});

describe('metricIndex — навигация', () => {
  it('маршрут /metrics/* принадлежит той же сети, что и запись (networkStore не спорит с индексом)', () => {
    for (const entry of routed.filter((item) => item.route?.scope === 'metrics')) {
      expect(routeNetworkOwner(`/metrics/${entry.route?.key}`), entry.id).toBe(entry.source);
    }
  });

  it('metricRoute строит путь разбора, metricByRoute — обратное отображение', () => {
    for (const entry of routed.filter((item) => item.route?.scope === 'metrics')) {
      const path = metricRoute(entry.id);
      expect(path).toBe(`/metrics/${entry.route?.key}`);
      expect(metricByRoute(path?.slice('/metrics/'.length))).toBe(entry);
    }
    expect(metricRoute('ms.revenue')).toBe('/metrics/ms-revenue');
    expect(metricRoute('tg.views')).toBe('/metrics/views');
    // Нет своего маршрута или он требует контекста.
    expect(metricRoute('tg.netGrowth')).toBeNull();
    expect(metricRoute('campaign.timeline')).toBeNull();
    expect(metricRoute('nope.metric')).toBeNull();
  });

  it('поиск устойчив к ключам прототипа и пустому вводу', () => {
    for (const probe of ['toString', 'constructor', '__proto__', '', 'hasOwnProperty']) {
      expect(metricEntry(probe), probe).toBeUndefined();
      expect(metricByRoute(probe), probe).toBeUndefined();
      expect(kindOf(probe), probe).toBeUndefined();
      expect(capabilitiesOf(probe), probe).toBeUndefined();
    }
    expect(metricEntry(null)).toBeUndefined();
    expect(metricByRoute(undefined)).toBeUndefined();
  });

  it('виджет с разбором и его разбор — одна запись (цель «Полный разбор»)', () => {
    const pairs: Array<[string, string]> = [
      ['tg.views', 'views'],
      ['tg.churn', 'tg-churn'],
      ['tg.viewsByType', 'tg-reach-by-type'],
      ['tg.formatPerf', 'tg-erv-by-format'],
      ['tg.engagementComposition', 'tg-engagement-mix'],
      ['tg.newFollowersBySource', 'tg-followers-by-source'],
      ['ig.followers', 'ig-follows'],
      ['ig.formats', 'ig-format-engagement'],
      ['ig.hours', 'ig-best-time'],
      ['ms.avgCheck', 'ms-aov'],
      ['ym.visits', 'ym-visits'],
    ];
    for (const [id, key] of pairs) expect(metricByRoute(key)?.id, key).toBe(id);
    // У IG ER страницы и виджета разные знаменатели — это две метрики.
    expect(metricByRoute('ig-er')?.id).toBe('ig.er');
    expect(METRIC_INDEX['ig.erv'].route).toBeNull();
  });
});

describe('metricIndex — модуль общего чанка', () => {
  const file = fileURLToPath(new URL('./metricIndex.ts', import.meta.url));
  const source = readFileSync(file, 'utf8');

  it('не содержит текстов для людей: ни одной кириллической строки вне комментариев', () => {
    const literals: string[] = [];
    walk(parseSource(file, source), (node) => {
      if (node.type === 'Literal' && typeof node.value === 'string') literals.push(node.value);
      if (node.type === 'TemplateElement') literals.push((node.value as { cooked: string | null; raw: string }).cooked ?? '');
    });
    // Сам сканер работает: ключи маршрутов в выборке есть.
    expect(literals).toContain('ms-revenue');
    expect(literals.filter((text) => /[А-Яа-яЁё]/.test(text))).toEqual([]);
  });

  it('импортирует только типы и ничего из panels/** и api/**', () => {
    const imports = [...source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm)];
    for (const [statement, typeOnly, path] of imports) {
      expect(typeOnly, statement).toBeTruthy();
      expect(path.startsWith('@/panels/') || path.startsWith('@/api/'), statement).toBe(false);
    }
    expect(source).not.toMatch(/\bimport\s*\(/);
  });
});
