import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadMetricDetails, mergeMetricDetails, type MetricDetails } from '@/lib/metricDetails';
import { METRIC_INDEX, METRIC_INDEX_ENTRIES, type MetricIndexSource } from '@/lib/metricIndex';
import { getMetric } from '@/lib/widgetMetrics';

const SOURCES: MetricIndexSource[] = ['tg', 'ig', 'ms', 'ym', 'cdek', 'rusender', 'multi'];

async function loadAll(): Promise<Record<MetricIndexSource, MetricDetails>> {
  const loaded = await Promise.all(SOURCES.map((source) => loadMetricDetails(source)));
  return Object.fromEntries(SOURCES.map((source, i) => [source, loaded[i]])) as Record<MetricIndexSource, MetricDetails>;
}

/** Имена хуков, которые реально экспортирует слой запросов (`export function useX` / `export const useX =`). */
function exportedApiHooks(): Set<string> {
  const dir = fileURLToPath(new URL('../api', import.meta.url));
  const names = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!/\.tsx?$/.test(file) || /\.test\./.test(file)) continue;
    const source = readFileSync(join(dir, file), 'utf8');
    for (const match of source.matchAll(/^export\s+(?:function|const)\s+(use[A-Z]\w*)/gm)) names.add(match[1]);
  }
  return names;
}

describe('loadMetricDetails — полнота деталей', () => {
  it('детали каждого источника описывают только записи своего источника', async () => {
    const all = await loadAll();
    for (const source of SOURCES) {
      const { info, explorerSchema, deps } = all[source];
      for (const id of [...Object.keys(info), ...Object.keys(explorerSchema), ...Object.keys(deps)]) {
        expect(METRIC_INDEX[id], `${source}: ${id}`).toBeDefined();
        expect(METRIC_INDEX[id].source, `${source}: ${id}`).toBe(source);
      }
    }
  });

  it('у каждой записи индекса есть deps, у каждого маршрута — схема разбора, у каждого виджета — тексты ⓘ', async () => {
    const all = await loadAll();
    for (const entry of METRIC_INDEX_ENTRIES) {
      const details = all[entry.source];
      const deps = details.deps[entry.id];
      expect(deps, `deps ${entry.id}`).toBeDefined();
      if (entry.route) {
        expect(details.explorerSchema[entry.id], `schema ${entry.id}`).toBeDefined();
        expect(deps?.explorer?.length, `explorer deps ${entry.id}`).toBeGreaterThan(0);
      } else {
        expect(details.explorerSchema[entry.id], `schema ${entry.id}`).toBeUndefined();
        expect(deps?.explorer, `explorer deps ${entry.id}`).toBeUndefined();
      }
      if (entry.widgetId) {
        expect(deps?.widget, `widget deps ${entry.id}`).toBeDefined();
        expect(details.info[entry.id]?.label, `info ${entry.id}`).toBeTruthy();
      } else {
        expect(deps?.widget, `widget deps ${entry.id}`).toBeUndefined();
      }
    }
  });

  it('тексты ⓘ — те же, что у каталога виджетов (один источник текста)', async () => {
    const all = await loadAll();
    for (const entry of METRIC_INDEX_ENTRIES.filter((item) => item.widgetId)) {
      const info = all[entry.source].info[entry.id];
      const def = getMetric(entry.id);
      expect(def, entry.id).toBeDefined();
      expect(info).toEqual({
        label: def?.label,
        ...(def?.glossaryLabel ? { glossaryLabel: def.glossaryLabel } : {}),
        ...(def?.formula ? { formula: def.formula } : {}),
        ...(def?.included ? { included: def.included } : {}),
        ...(def?.sourceNote ? { sourceNote: def.sourceNote } : {}),
      });
    }
  });

  it('deps называют хуки, которые слой api/* действительно экспортирует', async () => {
    const all = await loadAll();
    const hooks = exportedApiHooks();
    expect(hooks.has('useTgFull')).toBe(true);
    for (const source of SOURCES) {
      for (const [id, deps] of Object.entries(all[source].deps)) {
        for (const hook of [...(deps.widget ?? []), ...(deps.explorer ?? [])]) {
          expect(hooks.has(hook), `${id}: ${hook}`).toBe(true);
        }
      }
    }
  });
});

describe('loadMetricDetails — схема разбора согласована с индексом', () => {
  it('дефолт параметра — одно из допустимых значений', async () => {
    const all = await loadAll();
    for (const source of SOURCES) {
      for (const [id, schema] of Object.entries(all[source].explorerSchema)) {
        for (const [param, spec] of Object.entries(schema.url)) {
          if (spec.values && spec.defaultValue != null) {
            expect(spec.values, `${id}?${param}`).toContain(spec.defaultValue);
          }
          if (spec.values) expect(new Set(spec.values).size, `${id}?${param}`).toBe(spec.values.length);
        }
      }
    }
  });

  it('вид, грануляция и база сравнения в URL — ровно те, что записаны в индексе', async () => {
    const all = await loadAll();
    for (const entry of METRIC_INDEX_ENTRIES.filter((item) => item.route)) {
      const { url } = all[entry.source].explorerSchema[entry.id];
      const caps = entry.capabilities;
      if (url.chart?.values) expect([...url.chart.values].sort(), entry.id).toEqual([...entry.supportedViz].sort());
      if (url.grain?.values) expect([...url.grain.values].sort(), entry.id).toEqual([...caps.grain].sort());
      else expect(caps.grain.length === 0 || url.grain != null, `grain ${entry.id}`).toBe(true);
      const compareParam = url.compare ?? url.cmp;
      if (compareParam?.values) {
        expect([...compareParam.values].sort(), entry.id).toEqual([...caps.compare].sort());
      }
    }
  });

  it('каждый переключатель разбора живёт либо в URL, либо записан как локальный (SHELL-4)', async () => {
    const all = await loadAll();
    for (const entry of METRIC_INDEX_ENTRIES.filter((item) => item.route)) {
      const { url, local } = all[entry.source].explorerSchema[entry.id];
      const caps = entry.capabilities;
      const has = (control: string, ...params: string[]) =>
        local.includes(control) || params.some((param) => param in url);
      const chartChoice = entry.supportedViz.filter((viz) => viz === 'line' || viz === 'bar').length > 1;
      if (chartChoice) expect(has('chart', 'chart'), `chart ${entry.id}`).toBe(true);
      if (caps.compare.includes('off')) expect(has('compare', 'compare', 'cmp'), `compare ${entry.id}`).toBe(true);
      if (caps.window === 'local') expect(local, `window ${entry.id}`).toContain('window');
      if (caps.goal) expect(local, `goal ${entry.id}`).toContain('goal');
      if (caps.target) expect(local, `target ${entry.id}`).toContain('target');
      if (caps.split.length > 0) expect(has('split', 'view'), `split ${entry.id}`).toBe(true);
    }
  });
});

describe('детали — только лениво', () => {
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(full));
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it('модули *MetricDetails никто не импортирует статически; import() — только в lib/metricDetails.ts', () => {
    const src = fileURLToPath(new URL('..', import.meta.url));
    const loader = fileURLToPath(new URL('./metricDetails.ts', import.meta.url));
    const staticImports: string[] = [];
    const dynamicImports: string[] = [];
    for (const file of sourceFiles(src)) {
      const text = readFileSync(file, 'utf8');
      if (/\bfrom\s+'[^']*MetricDetails'/.test(text)) staticImports.push(file);
      if (/\bimport\(\s*'[^']*MetricDetails'\s*\)/.test(text)) dynamicImports.push(file);
    }
    expect(staticImports).toEqual([]);
    expect(dynamicImports).toEqual([loader]);
  });
});

describe('loadMetricDetails — загрузка', () => {
  afterEach(() => {
    vi.doUnmock('@/panels/cdek/cdekMetricDetails');
    vi.resetModules();
  });

  it('кеширует промис источника', () => {
    expect(loadMetricDetails('ms')).toBe(loadMetricDetails('ms'));
  });

  it('сливает детали нескольких модулей источника (Telegram + упоминания)', async () => {
    const tg = await loadMetricDetails('tg');
    expect(tg.explorerSchema['tg.views']).toBeDefined();
    expect(tg.explorerSchema['mentions.timeline']).toBeDefined();
    const merged = mergeMetricDetails([
      { info: { a: { label: 'A' } }, explorerSchema: {}, deps: { a: { widget: [] } } },
      { info: {}, explorerSchema: { b: { url: {}, local: [] } }, deps: { b: { explorer: ['useTgFull'] } } },
    ]);
    expect(Object.keys(merged.info)).toEqual(['a']);
    expect(Object.keys(merged.explorerSchema)).toEqual(['b']);
    expect(Object.keys(merged.deps)).toEqual(['a', 'b']);
  });

  it('неудачная загрузка не застревает в кеше — следующий вызов пробует снова', async () => {
    vi.resetModules();
    let fail = true;
    vi.doMock('@/panels/cdek/cdekMetricDetails', () => {
      if (fail) throw new Error('chunk load failed');
      return { details: { info: {}, explorerSchema: {}, deps: {} } };
    });
    const fresh = await import('@/lib/metricDetails');
    await expect(fresh.loadMetricDetails('cdek')).rejects.toThrow();
    fail = false;
    await expect(fresh.loadMetricDetails('cdek')).resolves.toEqual({ info: {}, explorerSchema: {}, deps: {} });
  });
});
