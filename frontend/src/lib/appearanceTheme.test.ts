import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  APPEARANCE_DEFAULT,
  parseAppearance,
  type AppearanceSettings,
} from '@/lib/appearanceStorage';
import {
  ACCENTS,
  BASES,
  FONTS,
  RADII,
  appearanceCss,
  appearanceCssPretty,
  contrast,
  contrastOnTint,
  resolveAppearance,
  shuffleAppearance,
  type Hsl,
} from '@/lib/appearanceTheme';

/**
 * Контрактный гейт пользовательских тем.
 *
 * Кастомизация не имеет права опустить контраст ниже того, что уже проверяет
 * `scripts/contrast-tokens.mjs` для канона. Поэтому тест НЕ повторяет палитру руками: он читает
 * `src/index.css`, накладывает сгенерированные переопределения ровно так, как это сделает браузер
 * (включая `var()`-алиасы вроде `--chart-role-primary`), и прогоняет по всей матрице
 * акцент × нейтраль × тема те же пары, что и гейт. Новый акцент, который не держит AA, роняет
 * прогон здесь — до того, как его увидит пользователь.
 */

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(srcDir, 'index.css'), 'utf8');

/** Литеральные `--name: H S% L%` из ОДНОГО блока (первого, совпавшего с селектором). */
function literals(selector: RegExp): Record<string, Hsl> {
  const start = css.search(selector);
  if (start < 0) throw new Error(`палитра не найдена: ${selector}`);
  const open = css.indexOf('{', start);
  const block = css.slice(open + 1, css.indexOf('}', open));
  const tokens: Record<string, Hsl> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/g)) {
    tokens[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return tokens;
}

/** Все `--name: var(--target)` файла — они и есть семантический слой (роли графиков, алиасы). */
const ALIASES = [...css.matchAll(/--([a-z0-9-]+):\s*var\(--([a-z0-9-]+)\)\s*;/g)].map(
  (m) => [m[1], m[2]] as const,
);

const LIGHT = literals(/:root,\s*\n\s*\.force-light/);
const DARK = literals(/\.dark \{/);

type Theme = 'light' | 'dark';

/** Итоговая палитра темы: канон → переопределения студии → разрешение алиасов. */
function palette(theme: Theme, settings: AppearanceSettings): Record<string, Hsl> {
  const resolved = resolveAppearance(settings);
  const overrides: Record<string, Hsl> = {};
  for (const [token, value] of [...resolved.light.tokens, ...(theme === 'dark' ? resolved.dark.tokens : [])]) {
    const m = value.match(/^([\d.]+) ([\d.]+)% ([\d.]+)%$/);
    if (m) overrides[token] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  const base = theme === 'light' ? { ...LIGHT } : { ...LIGHT, ...DARK };
  const explicit = new Set([...Object.keys(base), ...Object.keys(overrides)]);
  const tokens = { ...base, ...overrides };
  for (const [name, target] of ALIASES) {
    if (!explicit.has(name) && tokens[target]) tokens[name] = tokens[target];
  }
  return tokens;
}

// [подпись, чернила, поле, порог] — подмножество гейта, которое кастомизация физически двигает.
const TEXT_PAIRS: Array<[string, string, string]> = [
  ['muted на карточке', 'muted-foreground', 'card'],
  ['muted на холсте', 'muted-foreground', 'background'],
  ['muted на строке-ховере', 'muted-foreground', 'hover-row'],
  ['muted во всплывашке', 'muted-foreground', 'popover'],
  ['ink2 на карточке', 'ink2', 'card'],
  ['ink3 на карточке', 'ink3', 'card'],
  ['текст на карточке', 'foreground', 'card'],
  ['текст на холсте', 'foreground', 'background'],
  ['ссылка/актив на карточке', 'primary', 'card'],
  ['подпись на кнопке', 'primary-foreground', 'primary'],
  ['подпись на тинте акцента', 'accent-foreground', 'accent'],
  ['рост на карточке', 'brand-verdant', 'card'],
  ['падение на карточке', 'brand-ember', 'card'],
  ['риск на карточке', 'status-warn', 'card'],
  ['разрушительное на карточке', 'destructive', 'card'],
];

const STROKE_PAIRS: Array<[string, string, string]> = [
  ['фокус-кольцо на карточке', 'ring', 'card'],
  ['фокус-кольцо на холсте', 'ring', 'background'],
  ['линия серии на карточке', 'brand-iris', 'card'],
  ['роль primary на карточке', 'chart-role-primary', 'card'],
  ['роль primary на холсте', 'chart-role-primary', 'background'],
  ['роль сравнения на карточке', 'chart-role-comparison', 'card'],
  ['роль нейтрали на карточке', 'chart-role-neutral', 'card'],
  ...Array.from({ length: 6 }, (_, i): [string, string, string] => [
    `chart-${i + 1} на карточке`,
    `chart-${i + 1}`,
    'card',
  ]),
  ...Array.from({ length: 6 }, (_, i): [string, string, string] => [
    `категориальный ${i + 1} на карточке`,
    `chart-${i + 1}-cat`,
    'card',
  ]),
  ...Array.from({ length: 5 }, (_, i): [string, string, string] => [
    `ступень ${i + 1} на карточке`,
    `chart-seq-${i + 1}`,
    'card',
  ]),
];

function check(theme: Theme, settings: AppearanceSettings, label: string) {
  const tokens = palette(theme, settings);
  for (const [pair, fg, bg] of TEXT_PAIRS) {
    expect(tokens[fg], `${label} · ${pair}: нет токена ${fg}`).toBeDefined();
    expect(
      contrast(tokens[fg], tokens[bg]),
      `${label} · ${theme} · ${pair} — текст обязан держать AA 4.5`,
    ).toBeGreaterThanOrEqual(4.5);
  }
  for (const [pair, fg, bg] of STROKE_PAIRS) {
    expect(tokens[fg], `${label} · ${pair}: нет токена ${fg}`).toBeDefined();
    expect(
      contrast(tokens[fg], tokens[bg]),
      `${label} · ${theme} · ${pair} — штрих обязан держать 3.0 (WCAG 1.4.11)`,
    ).toBeGreaterThanOrEqual(3.0);
  }
  // Выбранная пилюля периода: подпись `accent-foreground` на 10%-м размыве акцента по холсту —
  // ровно та пара, которую отдельно считает scripts/contrast-tokens.mjs.
  const onWash = contrastOnTint(tokens['accent-foreground'], tokens.primary, tokens.background, 0.1);
  expect(
    onWash,
    `${label} · ${theme} — подпись выбранной пилюли на 10%-м размыве акцента`,
  ).toBeGreaterThanOrEqual(4.5);
}

describe('канон не меняется, пока пользователь его не тронул', () => {
  it('канонический выбор не печатает ни одной переменной', () => {
    expect(appearanceCss(APPEARANCE_DEFAULT)).toBe('');
    const resolved = resolveAppearance(APPEARANCE_DEFAULT);
    expect(resolved.light.tokens).toHaveLength(0);
    expect(resolved.dark.tokens).toHaveLength(0);
    expect(resolved.rules).toHaveLength(0);
  });

  it('копия CSS для канона объясняет пустоту, а не отдаёт пустую строку', () => {
    expect(appearanceCssPretty(APPEARANCE_DEFAULT)).toContain('канон');
  });
});

describe('контраст держится на всей матрице акцент × нейтраль', () => {
  for (const accent of ACCENTS) {
    for (const base of BASES) {
      const settings: AppearanceSettings = {
        ...APPEARANCE_DEFAULT,
        accent: accent.key,
        base: base.key,
      };
      it(`${accent.label} на нейтрали «${base.label}»`, () => {
        check('light', settings, `${accent.label}/${base.label}`);
        check('dark', settings, `${accent.label}/${base.label}`);
      });
    }
  }
});

describe('палитра данных держит штрих-порог на всех нейтралях', () => {
  const options = ['accent', ...ACCENTS.map((item) => item.key)];
  for (const chart of options) {
    it(`палитра «${chart}»`, () => {
      for (const base of BASES) {
        const settings: AppearanceSettings = {
          ...APPEARANCE_DEFAULT,
          accent: chart === 'accent' ? 'amber' : 'canon',
          base: base.key,
          chart,
        };
        check('light', settings, `график ${chart}/${base.label}`);
        check('dark', settings, `график ${chart}/${base.label}`);
      }
    });
  }

  it('акценты карточек остаются шестью разными тонами, а не оттенками палитры', () => {
    const settings: AppearanceSettings = { ...APPEARANCE_DEFAULT, chart: 'rose' };
    const light = palette('light', settings);
    const hues = new Set(Array.from({ length: 6 }, (_, i) => light[`chart-${i + 1}-accent`][0]));
    expect(hues.size).toBe(6);
  });
});

describe('слоистость тёмных поверхностей переживает смену нейтрали', () => {
  for (const base of BASES) {
    it(`«${base.label}»: холст < таблица < карточка < всплывашка`, () => {
      const tokens = palette('dark', { ...APPEARANCE_DEFAULT, base: base.key });
      expect(tokens.background[2]).toBeLessThan(tokens['surface-table'][2]);
      expect(tokens['surface-table'][2]).toBeLessThan(tokens.card[2]);
      expect(tokens.card[2]).toBeLessThan(tokens.popover[2]);
    });
  }
});

describe('каскад: светлый блок не течёт в тёмную тему', () => {
  // Наш <style> живёт ВНЕ каскадных слоёв, поэтому `:root` из него перебивает даже `.dark` из
  // `@layer base`. Значит любой ЦВЕТОВОЙ токен, напечатанный только в светлом блоке, молча
  // перекрасил бы тёмную тему. Инвариант: цветовые наборы блоков совпадают.
  const themeAgnostic = new Set(['radius', 'radius-xl', 'radius-2xl', 'radius-3xl', 'font-sans']);
  it('каждый цветовой токен :root имеет пару в .dark', () => {
    for (const accent of ACCENTS) {
      for (const base of BASES) {
        for (const chart of ['canon', 'accent', 'rose']) {
          const resolved = resolveAppearance({
            accent: accent.key,
            base: base.key,
            chart,
            radius: 'md',
            font: 'mono',
          });
          const dark = new Set(resolved.dark.tokens.map(([token]) => token));
          for (const [token] of resolved.light.tokens) {
            if (themeAgnostic.has(token)) continue;
            expect(
              dark.has(token),
              `--${token} печатается только в :root и перекрасит тёмную тему`,
            ).toBe(true);
          }
        }
      }
    }
  });
});

describe('форма и текст', () => {
  it('радиус пересчитывает всё семейство, канон совпадает с нынешними 4/12/16/24px', () => {
    const canon = RADII.find((item) => item.key === 'canon');
    expect(canon?.value).toBe('0.25rem');
    const tokens = Object.fromEntries(
      resolveAppearance({ ...APPEARANCE_DEFAULT, radius: 'md' }).light.tokens,
    );
    expect(tokens.radius).toBe('0.5rem');
    expect(tokens['radius-xl']).toBe('calc(0.5rem + 8px)');
    expect(tokens['radius-2xl']).toBe('calc(0.5rem + 12px)');
  });

  it('шрифт печатает и переменную, и правило body — иначе канон в @layer base перебьёт выбор', () => {
    const resolved = resolveAppearance({ ...APPEARANCE_DEFAULT, font: 'mono' });
    const tokens = Object.fromEntries(resolved.light.tokens);
    expect(tokens['font-sans']).toContain('ui-monospace');
    expect(resolved.rules).toContain('body{font-family:var(--font-sans)}');
  });

  it('каждое семейство шрифтов заканчивается родовым именем (нечего скачивать)', () => {
    for (const font of FONTS) {
      if (!font.stack) continue;
      expect(font.stack).toMatch(/(sans-serif|serif|monospace)$/);
      expect(font.stack).not.toContain('url(');
    }
  });
});

describe('вход из хранилища и аккаунта санируется', () => {
  it('мусор превращается в канон, а не в мусорный CSS', () => {
    expect(parseAppearance(null)).toEqual(APPEARANCE_DEFAULT);
    expect(parseAppearance('нет')).toEqual(APPEARANCE_DEFAULT);
    expect(parseAppearance({ accent: 'red;}body{display:none' })).toEqual(APPEARANCE_DEFAULT);
    expect(parseAppearance({ accent: 42, base: 'slate' })).toEqual({
      ...APPEARANCE_DEFAULT,
      base: 'slate',
    });
  });

  it('неизвестный ключ палитры не печатает переменных', () => {
    expect(appearanceCss({ ...APPEARANCE_DEFAULT, accent: 'unknown-hue' })).toBe('');
  });

  it('«случайно» выдаёт только известные ключи и не трогает шрифт', () => {
    let seed = 0;
    const random = () => {
      seed += 0.137;
      return seed % 1;
    };
    for (let i = 0; i < 40; i++) {
      const next = shuffleAppearance({ ...APPEARANCE_DEFAULT, font: 'serif' }, random);
      expect(ACCENTS.some((item) => item.key === next.accent)).toBe(true);
      expect(BASES.some((item) => item.key === next.base)).toBe(true);
      expect(RADII.some((item) => item.key === next.radius)).toBe(true);
      expect(next.font).toBe('serif');
    }
  });
});
