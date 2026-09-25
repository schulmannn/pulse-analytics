import { describe, expect, it } from 'vitest';
import {
  ALLOWLIST,
  RULES,
  allowlistErrors,
  compareToBaseline,
  countFindings,
  lintSource,
  maskComments,
  toBaseline,
} from './consistency-lint.mjs';

/**
 * Гейт единообразия источников сам по себе — регэкспы, и регресс в них молча отключил бы правило:
 * пустой обход проходит «зелёным». Поэтому каждое правило здесь ловит подложенное нарушение, а
 * соседняя чистая строка (или файл вне области правила) остаётся без находки.
 */

/** Номера строк находок одного правила. */
function hits(rule, rel, code, opts) {
  return lintSource(rel, code, opts)
    .filter((f) => f.rule === rule)
    .map((f) => f.line);
}

describe('каждое правило ловит подложенное нарушение', () => {
  it('no-direct-metric-nav: navigate/Link к /metrics, navigate(drillTo) и засев окна — вне lib/openDetail', () => {
    const code = [
      "onDrill={() => navigate('/metrics/views')}",
      'run: () => navigate(`/metrics/${key}`),',
      '<Link key={k} to={`/metrics/${k}`}>',
      'onValueClick={() => navigate(drillTo)}',
      'const explorer = usePeriod();',
      'explorer.setDays(7);',
      "navigate('/posts');",
    ].join('\n');
    expect(hits('no-direct-metric-nav', 'src/panels/Foo.tsx', code)).toEqual([1, 2, 3, 4, 6]);
    expect(hits('no-direct-metric-nav', 'src/lib/openDetail.ts', code)).toEqual([]);
  });

  it('no-local-explorer-chrome: своё определение хрома и прямой импорт — только в panels/**', () => {
    const code = [
      "import { SegSelect } from '@/components/metric/SegSelect';",
      'import {',
      '  MetricColumns,',
      '  WindowBarShell,',
      "} from '@/components/metric/shared';",
      'function FooMetricShell() {}',
      'function FooChart() {}',
    ].join('\n');
    expect(hits('no-local-explorer-chrome', 'src/panels/foo/FooMetricPage.tsx', code)).toEqual([1, 4, 6]);
    expect(hits('no-local-explorer-chrome', 'src/components/metric/Explorer.tsx', code)).toEqual([]);
  });

  it('no-local-downsample: LTTB, pickIndexes и порог точек — только в lib/chartSeries', () => {
    const code = [
      "import { CHART_MAX_POINTS, lttbDownsample } from '@/lib/downsample';",
      'const shown = lttbDownsample(rows, CHART_MAX_POINTS, (r) => r.value);',
      'if (n <= CHART_MAX_POINTS) return n;',
      'const SPARK_MAX_POINTS = 48;',
      'const total = rows.length;',
    ].join('\n');
    expect(hits('no-local-downsample', 'src/panels/Foo.tsx', code)).toEqual([2, 3, 4]);
    expect(hits('no-local-downsample', 'src/lib/chartSeries.ts', code)).toEqual([]);
  });

  it('no-null-to-zero: `?? 0` в рядах для примитива и Number(x ?? 0)', () => {
    const code = [
      '<BarChart values={values.map((v) => v ?? 0)} />',
      'ghost: prev.map((d) => d.value ?? 0),',
      'const reach = Number(p.reach ?? 0);',
      'const count = rows.length ?? 0;',
      'values={values}',
    ].join('\n');
    expect(hits('no-null-to-zero', 'src/panels/Foo.tsx', code)).toEqual([1, 2, 3]);
  });

  it('no-local-explorer-state: окно/вид/сравнение в *MetricPage и сортировка таблиц — не useState', () => {
    const page = [
      'const [days, setDays] = useState<PeriodDays>(30);',
      "const [kind, setKind] = useState<'line' | 'bar'>('line');",
      "const [cmp, setCmp] = useState<'off' | 'prev'>('prev');",
      'setSearchParams(next, { replace: true });',
      "const [sort, setSort] = useState<SortKey>('reach');",
      'const [open, setOpen] = useState(false);',
    ].join('\n');
    expect(hits('no-local-explorer-state', 'src/panels/sklad/FooMetricPage.tsx', page)).toEqual([1, 2, 3, 4, 5]);
    // Вне страниц разбора остаётся только сортировка таблиц.
    expect(hits('no-local-explorer-state', 'src/panels/Foo.tsx', page)).toEqual([5]);
  });

  it('no-inline-delta: деление разницы на её же базу — только в lib/comparison', () => {
    const code = [
      'const d = ((cur - prev) / prev) * 100;',
      'const e = ((current - previous) / Math.abs(previous)) * 100;',
      'const pct = (delta / previousTotal) * 100;',
      'const share = (part / whole) * 100;',
      'const mid = (a - b) / 2;',
    ].join('\n');
    expect(hits('no-inline-delta', 'src/panels/Foo.tsx', code)).toEqual([1, 2, 3]);
    expect(hits('no-inline-delta', 'src/lib/comparison.ts', code)).toEqual([]);
  });

  it('no-raw-kpi-format: toFixed(…)%, fmt.* в value= у KpiValue/ChartCardBody и в out.value резолвера', () => {
    const code = [
      'const label = `${pct.toFixed(1)}%`;',
      '<KpiValue',
      '  size="md"',
      '  value={fmt.short(total)}',
      '/>',
      "<KpiValue value={formatMetricNumber(total, 'count', 'headline')} />",
      '<Row data-value={fmt.kpi(x)} value={fmt.kpi(x)} />',
    ].join('\n');
    expect(hits('no-raw-kpi-format', 'src/panels/Foo.tsx', code)).toEqual([1, 4]);
    expect(hits('no-raw-kpi-format', 'src/lib/widgetResolver/tg.ts', 'out.value = fmt.num(sum);')).toEqual([1]);
    expect(hits('no-raw-kpi-format', 'src/lib/tg.ts', 'out.value = fmt.num(sum);')).toEqual([]);
  });

  it('no-raw-chart-colour: сырой цвет в графике и в теле тепловой сетки, но не в остальной странице', () => {
    const chart = ['stroke="hsl(var(--brand-iris))"', "fill: 'hsl(var(--chart-role-primary))',", "className={up ? 'text-verdant' : 'text-ember'}"].join('\n');
    expect(hits('no-raw-chart-colour', 'src/components/LineChart.tsx', chart)).toEqual([1, 3]);
    expect(hits('no-raw-chart-colour', 'src/components/Toolbar.tsx', chart)).toEqual([]);

    const page = [
      'function RhythmHeatmap() {',
      '  return <div className="h-4 bg-primary" />;',
      '}',
      '',
      'function OrdersToolbar() {',
      '  return <button className="bg-primary" />;',
      '}',
    ].join('\n');
    expect(hits('no-raw-chart-colour', 'src/panels/cdek/CdekOrders.tsx', page)).toEqual([2]);
  });

  it('shared-layer-imports: общий слой не импортирует panels/** и api/<source>.ts (типы можно)', () => {
    const code = [
      "import { MS_METRIC_KEYS } from '@/panels/sklad/msMetricKeys';",
      "import type { DrillKey } from '@/panels/tgMetricKeys';",
      "import { useMsSummary } from '@/api/ms';",
      "import { fmt } from '@/lib/format';",
    ].join('\n');
    expect(hits('shared-layer-imports', 'src/lib/comparison.ts', code)).toEqual([1, 3]);
    expect(hits('shared-layer-imports', 'src/components/metric/shared.tsx', code)).toEqual([1, 3]);
    expect(hits('shared-layer-imports', 'src/panels/Foo.tsx', code)).toEqual([]);
  });

  it('у каждого правила есть тест выше — новое правило без него не проходит', () => {
    const covered = [
      'no-direct-metric-nav',
      'no-local-explorer-chrome',
      'no-local-downsample',
      'no-null-to-zero',
      'no-local-explorer-state',
      'no-inline-delta',
      'no-raw-kpi-format',
      'no-raw-chart-colour',
      'shared-layer-imports',
    ];
    expect(RULES.map((r) => r.id).sort()).toEqual([...covered].sort());
  });
});

describe('комментарии не считаются, строки и код после них — считаются', () => {
  it('вырезает строчные, блочные и JSX-комментарии, сохраняя строки и переводы строк', () => {
    const code = [
      "// navigate('/metrics/views') — пример в комментарии",
      '/* lttbDownsample(rows, CHART_MAX_POINTS) */',
      '{/* ((cur - prev) / prev) */}',
      "const url = 'https://t.me/x'; navigate('/metrics/er');",
      'const re = /\\/\\//; navigate(drillTo);',
    ].join('\n');
    const masked = maskComments(code);
    expect(masked.split('\n')).toHaveLength(5);
    expect(lintSource('src/panels/Foo.tsx', code).map((f) => [f.rule, f.line])).toEqual([
      ['no-direct-metric-nav', 4],
      ['no-direct-metric-nav', 5],
    ]);
  });

  it('шаблонная строка с вложенным ${…} не сбивает разбор', () => {
    const code = ['const s = `a ${`b ${x}`} // не комментарий`;', "navigate('/metrics/x'); // хвост"].join('\n');
    expect(maskComments(code).split('\n')[0]).toBe('const s = `a ${`b ${x}`} // не комментарий`;');
    expect(hits('no-direct-metric-nav', 'src/panels/Foo.tsx', code)).toEqual([2]);
  });
});

describe('allowlist по файлу с обоснованием', () => {
  const code = ['const RING_MAX_POINTS = 10;', "navigate('/metrics/x');"].join('\n');
  const allowlist = [{ rule: 'no-local-downsample', file: 'src/components/Ring.tsx', why: 'порог колец на точках, а не кап ряда' }];

  it('снимает ровно одно правило с ровно одного файла', () => {
    const suppressed = new Set();
    const found = lintSource('src/components/Ring.tsx', code, { allowlist, suppressed });
    expect(found.map((f) => f.rule)).toEqual(['no-direct-metric-nav']);
    expect(suppressed.has(allowlist[0])).toBe(true);
    expect(hits('no-local-downsample', 'src/components/Other.tsx', code, { allowlist })).toEqual([1]);
  });

  it('запись без обоснования или с чужим правилом — ошибка самого гейта', () => {
    expect(allowlistErrors([{ rule: 'no-local-downsample', file: 'src/a.ts', why: '' }])).toHaveLength(1);
    expect(allowlistErrors([{ rule: 'no-such-rule', file: 'src/a.ts', why: 'достаточно длинное обоснование записи' }])).toHaveLength(1);
    expect(allowlistErrors([{ rule: 'no-null-to-zero', file: 'a.ts', why: 'достаточно длинное обоснование записи' }])).toHaveLength(1);
  });

  it('боевой allowlist валиден', () => {
    expect(allowlistErrors(ALLOWLIST)).toEqual([]);
  });
});

describe('сверка с baseline по паре (правило, файл)', () => {
  const findings = (spec) =>
    Object.entries(spec).flatMap(([key, n]) => {
      const [rule, file] = key.split(' ');
      return Array.from({ length: n }, (_, i) => ({ rule, file, line: i + 1, snippet: '' }));
    });
  const baseline = toBaseline(countFindings(findings({ 'no-null-to-zero src/a.ts': 2, 'no-inline-delta src/b.ts': 1 })));

  it('baseline хранит итог и счёт по файлам', () => {
    expect(baseline.total).toBe(3);
    expect(baseline.rules['no-null-to-zero']).toEqual({ total: 2, files: { 'src/a.ts': 2 } });
    expect(baseline.rules['no-raw-chart-colour']).toEqual({ total: 0, files: {} });
  });

  it('рост в файле — ошибка', () => {
    const { grown } = compareToBaseline(countFindings(findings({ 'no-null-to-zero src/a.ts': 3, 'no-inline-delta src/b.ts': 1 })), baseline);
    expect(grown).toEqual([{ rule: 'no-null-to-zero', file: 'src/a.ts', was: 2, now: 3 }]);
  });

  it('перенос нарушения в другой файл — тоже рост, хотя итог правила тот же', () => {
    const { grown, shrunk } = compareToBaseline(
      countFindings(findings({ 'no-null-to-zero src/a.ts': 1, 'no-null-to-zero src/c.ts': 1, 'no-inline-delta src/b.ts': 1 })),
      baseline,
    );
    expect(grown).toEqual([{ rule: 'no-null-to-zero', file: 'src/c.ts', was: 0, now: 1 }]);
    expect(shrunk).toEqual([{ rule: 'no-null-to-zero', file: 'src/a.ts', was: 2, now: 1 }]);
  });

  it('убыль проходит и подсказывает ужать baseline', () => {
    const { grown, shrunk } = compareToBaseline(countFindings(findings({ 'no-null-to-zero src/a.ts': 1 })), baseline);
    expect(grown).toEqual([]);
    expect(shrunk).toEqual([
      { rule: 'no-inline-delta', file: 'src/b.ts', was: 1, now: 0 },
      { rule: 'no-null-to-zero', file: 'src/a.ts', was: 2, now: 1 },
    ]);
  });

  it('без изменений — ни роста, ни убыли', () => {
    expect(compareToBaseline(countFindings(findings({ 'no-null-to-zero src/a.ts': 2, 'no-inline-delta src/b.ts': 1 })), baseline)).toEqual({
      grown: [],
      shrunk: [],
    });
  });
});
