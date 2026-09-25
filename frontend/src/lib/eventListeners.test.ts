import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Регресс, который стоил пяти утечек: Tailwind-codemod v3→v4 переписал `blur` → `blur-sm` внутри
 * JS-строки, и `removeEventListener('blur-sm', clear)` во всех графиках навсегда стал no-op —
 * замыкания копились на window при каждом hover. Имя события — обычная строка, типами не ловится,
 * поэтому проверяем статически по исходникам: тест node-окружения, jsdom в проекте нет.
 */

const SRC = fileURLToPath(new URL('..', import.meta.url));

// Только литералы: имена событий в кодовой базе всегда строковые константы (переменных нет).
const LISTENER_CALL = /\b(add|remove)EventListener\(\s*(['"])([^'"]+)\2/g;

/** Графики с hover-тултипом: слушатели вешаются на время наведения и обязаны сниматься.
    Хитмапы (TG-активность в panels/Charts, почасовые Метрики) делят useHeatmapTip —
    контракт проверяется в его домашнем файле ChartTooltip.tsx. */
const HOVER_CHARTS = [
  'components/LineChart.tsx',
  'components/BarChart.tsx',
  'components/PieChart.tsx',
  'components/DivergingBars.tsx',
  'components/ChartTooltip.tsx',
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('window/document listeners', () => {
  it('снимает ровно те события, которые вешает', () => {
    const mismatches: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const code = readFileSync(file, 'utf8');
      const added = new Set<string>();
      const removed = new Set<string>();
      for (const [, verb, , event] of code.matchAll(LISTENER_CALL)) {
        (verb === 'add' ? added : removed).add(event);
      }
      for (const event of removed) {
        if (!added.has(event)) {
          mismatches.push(`${relative(SRC, file)}: removeEventListener('${event}') без парного addEventListener`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('графики снимают hover-слушатели scroll и blur', () => {
    for (const chart of HOVER_CHARTS) {
      const code = readFileSync(join(SRC, chart), 'utf8');
      for (const event of ['scroll', 'blur']) {
        expect(code, `${chart}: не вешает ${event}`).toMatch(
          new RegExp(`addEventListener\\('${event}', clear`),
        );
        expect(code, `${chart}: не снимает ${event}`).toMatch(
          new RegExp(`removeEventListener\\('${event}', clear`),
        );
      }
    }
  });
});
