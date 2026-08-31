import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * SOURCE-КОНТРАКТ на длину подписей карточек Rusender (образец Connect.touch-targets.test).
 *
 * ЗАЧЕМ. У `ChartCardBody` колонка с числом — `shrink-0`, а плот — `flex-1 min-w-0`. Значит
 * длинная `caption` не переносится «под» график, а ФИЗИЧЕСКИ ВЫТЕСНЯЕТ его: на проде карточка
 * «Открытия» с подписью в 210 символов нарисовала столбцы полоской у самого правого края, и ни
 * один юнит-тест этого не увидел — вёрстка ломается только при реальной ширине.
 *
 * Поэтому предел жёсткий и проверяется по исходнику: объяснения живут в абзаце ПОД карточками,
 * где на них есть место, а подпись остаётся короткой меткой.
 */

const PANELS = ['RusenderOverview.tsx', 'RusenderAudience.tsx'] as const;

/** Значение каждого `caption={…}` — до закрывающей скобки того же выражения. */
function captions(source: string): string[] {
  const out: string[] = [];
  const re = /caption=\{/g;
  let m: RegExpExecArray | null = re.exec(source);
  while (m) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < source.length && depth > 0) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') depth -= 1;
      i += 1;
    }
    out.push(source.slice(m.index + m[0].length, i - 1));
    m = re.exec(source);
  }
  return out;
}

describe('Подписи карточек Rusender не вытесняют график', () => {
  for (const file of PANELS) {
    it(`${file}: каждая caption короче 80 символов`, () => {
      const source = readFileSync(fileURLToPath(new URL(`./${file}`, import.meta.url)), 'utf8');
      const found = captions(source);
      expect(found.length).toBeGreaterThan(0);
      for (const caption of found) {
        // Считаем ТЕКСТ подписи, а не выражение: интерполяции и тернарники сами по себе длинные,
        // но в UI дают короткую строку. Поэтому меряем самый длинный строковый литерал внутри.
        const literals = caption.match(/['"`]([^'"`]*)['"`]/g) ?? [];
        const longest = literals.reduce((max, lit) => Math.max(max, lit.length - 2), 0);
        expect(longest, `слишком длинная подпись: ${caption.slice(0, 120)}`).toBeLessThan(80);
      }
    });
  }
});
