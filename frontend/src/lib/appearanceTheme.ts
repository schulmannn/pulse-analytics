import { APPEARANCE_DEFAULT, type AppearanceSettings } from '@/lib/appearanceStorage';

/**
 * Палитры пользовательской темы и вывод CSS-переменных.
 *
 * ГЛАВНЫЙ ПРИНЦИП — «канон нельзя испортить выбором». Пользователь двигает ТОН (hue/насыщенность),
 * а СВЕТЛОТА поверхностей и чернил остаётся канонической: контраст текста к фону физически не может
 * уехать от того, что уже проверено `scripts/contrast-tokens.mjs`. Там, где светлота обязана
 * зависеть от тона (акцент, серии графиков — жёлтый на той же светлоте вдвое ярче синего), её
 * подбирает КОНТРАСТНЫЙ СОЛВЕР по тем же порогам, что и гейт: текст 4.5, штрих/кольцо 3.0.
 * Инвариант закреплён `appearanceTheme.test.ts` — там прогоняется вся матрица акцент × нейтраль.
 *
 * Что пользователю НЕ отдано (и не должно быть отдано):
 *  • зелёный/красный/янтарный оценочных дельт (--brand-verdant / --brand-ember / --status-warn) —
 *    это семантика «выросло/упало/риск», а не вкус;
 *  • тинты идентичности каналов (--chip-*) — они детерминированы хешем имени;
 *  • акценты карточек (--chart-N-accent) — их выбирает автор виджета, и шесть разных тонов там
 *    важнее общей палитры (поэтому при смене палитры данных они ПРИБИВАЮТСЯ к канону).
 */

export type Hsl = readonly [number, number, number];
type Rgb = [number, number, number];

// ── Цветовая математика (та же, что в scripts/contrast-tokens.mjs) ────────────────────────────
function hslToRgb([h, s, l]: Hsl): Rgb {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

const luminance = (rgb: Rgb): number =>
  rgb
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((acc, c, i) => acc + c * [0.2126, 0.7152, 0.0722][i], 0);

const ratioRgb = (a: Rgb, b: Rgb): number => {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
};

/** Контраст двух токенов палитры (WCAG 1.4.3 / 1.4.11). */
export const contrast = (fg: Hsl, bg: Hsl): number => ratioRgb(hslToRgb(fg), hslToRgb(bg));

/** Цвет, нарисованный под альфой поверх фона (тинты, размывы, призрачные штрихи). */
const blend = (fg: Hsl, bg: Hsl, alpha: number): Rgb => {
  const back = hslToRgb(bg);
  return hslToRgb(fg).map((c, i) => c * alpha + back[i] * (1 - alpha)) as Rgb;
};

/** Контраст такого размытого цвета к его же фону. */
export const contrastOver = (fg: Hsl, bg: Hsl, alpha: number): number =>
  ratioRgb(blend(fg, bg, alpha), hslToRgb(bg));

/** Контраст чернил к ПОЛЮ «цвет под альфой поверх фона» — выбранная пилюля периода, чип. */
export const contrastOnTint = (ink: Hsl, tint: Hsl, field: Hsl, alpha: number): number =>
  ratioRgb(hslToRgb(ink), blend(tint, field, alpha));

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const round1 = (value: number) => Math.round(value * 10) / 10;

/** Каналы HSL в том виде, в каком их ждёт `hsl(var(--token))`. */
export const fmtHsl = ([h, s, l]: Hsl): string =>
  `${round1(((h % 360) + 360) % 360)} ${round1(clamp(s, 0, 100))}% ${round1(clamp(l, 0, 100))}%`;

export const cssColor = (hsl: Hsl): string => `hsl(${fmtHsl(hsl)})`;

/**
 * Ищет светлоту шагом 0.5 в заданную сторону, пока цвет не наберёт `target` ко ВСЕМ поверхностям.
 * Если не набирает нигде — возвращает крайнее значение (это ловится тестом, а не молча живёт).
 */
function solveL(
  h: number,
  s: number,
  from: number,
  to: number,
  target: number,
  surfaces: Rgb[],
): number {
  const step = to > from ? 0.5 : -0.5;
  const steps = Math.abs(to - from) / 0.5;
  let l = from;
  for (let i = 0; i <= steps; i++) {
    l = from + step * i;
    const rgb = hslToRgb([h, s, l]);
    if (surfaces.every((surface) => ratioRgb(rgb, surface) >= target)) return l;
  }
  return to;
}

// ── Нейтраль: одна лестница светлот, тон и насыщенность задаёт выбор ───────────────────────────
interface Rung {
  token: string;
  /** Сдвиг тона от базового — канон «теплеет» к чернилам, лестница это сохраняет. */
  dh: number;
  s: number;
  l: number;
}

/** Светлая лестница = канон при (h 45, k 1) буква в букву. */
const LIGHT_BASE: readonly Rung[] = [
  { token: 'background', dh: 0, s: 28, l: 97 },
  { token: 'card', dh: 0, s: 0, l: 100 },
  { token: 'popover', dh: 0, s: 0, l: 100 },
  { token: 'secondary', dh: 0, s: 20, l: 95 },
  { token: 'muted', dh: 0, s: 20, l: 95 },
  { token: 'border', dh: 3, s: 16, l: 88 },
  { token: 'input', dh: 3, s: 16, l: 88 },
  { token: 'hover-row', dh: 2, s: 31, l: 94 },
  { token: 'avatar', dh: 0, s: 21, l: 89 },
  { token: 'muted-foreground', dh: 4, s: 5, l: 40 },
  { token: 'ink3', dh: 4, s: 5, l: 40 },
  { token: 'ink2', dh: 8, s: 5, l: 29 },
  { token: 'foreground', dh: 15, s: 6, l: 10 },
  { token: 'card-foreground', dh: 15, s: 6, l: 10 },
  { token: 'popover-foreground', dh: 15, s: 6, l: 10 },
  { token: 'secondary-foreground', dh: 15, s: 6, l: 10 },
];

/** Тёмная лестница = канон при (h 228, k 1); `--surface-table` там свой шаг, не алиас фона. */
const DARK_BASE: readonly Rung[] = [
  { token: 'background', dh: 0, s: 4, l: 3 },
  { token: 'surface-table', dh: 0, s: 6, l: 5 },
  { token: 'card', dh: 0, s: 6, l: 8 },
  { token: 'popover', dh: 0, s: 6, l: 14 },
  { token: 'secondary', dh: 0, s: 5, l: 15 },
  { token: 'muted', dh: 0, s: 5, l: 15 },
  { token: 'border', dh: 12, s: 5, l: 16 },
  { token: 'input', dh: 12, s: 5, l: 16 },
  { token: 'hover-row', dh: 0, s: 5, l: 18 },
  { token: 'avatar', dh: 0, s: 0, l: 22 },
  // 59, а не канонические 58: у ненасыщенной нейтрали строка-ховер светлее, и на 58 подпись
  // не добирала AA (поймано appearanceTheme.test.ts). Канон эту лестницу не печатает.
  { token: 'muted-foreground', dh: 0, s: 0, l: 59 },
  { token: 'ink3', dh: 0, s: 0, l: 55 },
  { token: 'ink2', dh: 0, s: 0, l: 72 },
  { token: 'foreground', dh: 0, s: 0, l: 95 },
  { token: 'card-foreground', dh: 0, s: 0, l: 95 },
  { token: 'popover-foreground', dh: 0, s: 0, l: 95 },
  { token: 'secondary-foreground', dh: 0, s: 0, l: 95 },
];

export interface BaseDef {
  key: string;
  label: string;
  /** Тон светлой темы. */
  h: number;
  /** Тон тёмной темы — канон намеренно тёплый на бумаге и холодный на почти-чёрном. */
  hDark: number;
  /** Множитель насыщенности лестницы: 0 = чистая шкала серого. */
  k: number;
}

export const BASES: readonly BaseDef[] = [
  { key: 'canon', label: 'Тёплая', h: 45, hDark: 228, k: 1 },
  { key: 'neutral', label: 'Нейтральная', h: 0, hDark: 0, k: 0 },
  { key: 'stone', label: 'Камень', h: 28, hDark: 28, k: 0.55 },
  { key: 'gray', label: 'Графит', h: 220, hDark: 220, k: 0.5 },
  { key: 'slate', label: 'Сланец', h: 212, hDark: 220, k: 1 },
  { key: 'zinc', label: 'Цинк', h: 264, hDark: 264, k: 0.3 },
];

const baseDef = (key: string): BaseDef => BASES.find((item) => item.key === key) ?? BASES[0];

function baseTokens(key: string, theme: Theme): Record<string, Hsl> {
  const def = baseDef(key);
  const hue = theme === 'light' ? def.h : def.hDark;
  const ladder = theme === 'light' ? LIGHT_BASE : DARK_BASE;
  const tokens: Record<string, Hsl> = {};
  for (const rung of ladder) tokens[rung.token] = [hue + rung.dh, rung.s * def.k, rung.l];
  return tokens;
}

// ── Акцент: тон задан, светлота подобрана под контраст ────────────────────────────────────────
export interface AccentDef {
  key: string;
  label: string;
  h: number;
  s: number;
  sDark: number;
  /** Светлота канона задана БУКВОЙ: смена нейтрали не имеет права двигать фирменный синий. */
  l?: number;
  lDark?: number;
  /** Стартовая светлота подписи на тинте — солвер уходит от неё, только если контраст не набран. */
  fgL?: number;
  fgLDark?: number;
  tint?: Hsl;
  tintDark?: Hsl;
  blueTintDark?: Hsl;
  /** Слот стори-карточки (--accent-card). У канона это ровно нынешний --chart-1-accent. */
  card?: Hsl;
  cardDark?: Hsl;
  cardDeepDark?: Hsl;
}

export const ACCENTS: readonly AccentDef[] = [
  {
    key: 'canon',
    label: 'Atlavue',
    h: 219,
    s: 74,
    sDark: 80,
    l: 53,
    lDark: 68,
    fgL: 49.5,
    fgLDark: 78,
    tint: [220, 79, 96],
    tintDark: [219, 40, 22],
    blueTintDark: [219, 40, 20],
    card: [218, 48, 48],
    cardDark: [216, 86, 86],
    cardDeepDark: [216, 72, 38],
  },
  { key: 'indigo', label: 'Индиго', h: 245, s: 62, sDark: 70 },
  { key: 'violet', label: 'Фиолетовый', h: 268, s: 58, sDark: 66 },
  { key: 'fuchsia', label: 'Пурпурный', h: 300, s: 52, sDark: 62 },
  { key: 'rose', label: 'Розовый', h: 340, s: 62, sDark: 72 },
  { key: 'red', label: 'Красный', h: 8, s: 64, sDark: 74 },
  { key: 'orange', label: 'Оранжевый', h: 26, s: 72, sDark: 82 },
  { key: 'amber', label: 'Янтарный', h: 42, s: 80, sDark: 88 },
  { key: 'lime', label: 'Лаймовый', h: 82, s: 55, sDark: 62 },
  { key: 'emerald', label: 'Изумрудный', h: 152, s: 55, sDark: 62 },
  { key: 'teal', label: 'Бирюзовый', h: 182, s: 58, sDark: 66 },
  { key: 'sky', label: 'Небесный', h: 200, s: 70, sDark: 78 },
];

const accentDef = (key: string): AccentDef => ACCENTS.find((item) => item.key === key) ?? ACCENTS[0];

/** Пороги — те же, что печатает гейт: текст 4.5, штрих/кольцо 3.0 (берём с запасом на округление). */
const TEXT_MIN = 4.55;
const STROKE_MIN = 3.05;

function accentTokens(key: string, theme: Theme, base: Record<string, Hsl>): Record<string, Hsl> {
  const def = accentDef(key);
  const card = base.card;
  const canvas = base.background;
  const light = theme === 'light';
  const s = light ? def.s : def.sDark;

  // --primary одновременно ссылка/актив (ТЕКСТ на карточке) и заливка кнопки, а контраст
  // симметричен: пройдя 4.5 к карточке, он тем же числом проходит для подписи на себе.
  const primaryL = light
    ? (def.l ?? solveL(def.h, s, 62, 24, TEXT_MIN, [hslToRgb(card)]))
    : (def.lDark ?? solveL(def.h, s, 50, 88, TEXT_MIN, [hslToRgb(card)]));
  const primary: Hsl = [def.h, s, primaryL];

  const tint: Hsl = light
    ? (def.tint ?? [def.h, clamp(s * 0.7, 24, 88), 96])
    : (def.tintDark ?? [def.h, clamp(s * 0.5, 24, 55), 22]);
  // Подпись на тинте живёт на ДВУХ полях: собственно --accent и 10%-й размыв primary по холсту
  // (поле выбранной пилюли/чипа). Гейт проверяет оба — солвер подбирает по обоим сразу и стартует
  // с канонического значения, так что смена ОДНОЙ нейтрали не перекрашивает подпись без нужды.
  const fields = [hslToRgb(tint), blend(primary, canvas, 0.1)];
  const fgStart = (light ? def.fgL : def.fgLDark) ?? primaryL;
  const accentForegroundL = solveL(def.h, s, fgStart, light ? 18 : 92, 4.5, fields);

  // Стори-карточка (`defaultColor` хоста). В тёмной теме это ОДНОВРЕМЕННО линия серии, крупное
  // число и — через свою «глубокую» пару — тональная подложка под ними, поэтому светлота обеих
  // решается вместе: подложка = deep под 26% поверх карточки, число обязано держать на ней AA.
  const cardDeep: Hsl = light
    ? (def.card ?? primary)
    : (def.cardDeepDark ?? [def.h, clamp(s * 0.9, 40, 78), 36]);
  const tonal = light ? hslToRgb(card) : blend(cardDeep, card, 0.26);
  const accentCard: Hsl = light
    ? (def.card ?? primary)
    : (def.cardDark ?? [
        def.h,
        clamp(s * 0.95, 45, 90),
        solveL(def.h, clamp(s * 0.95, 45, 90), 74, 94, TEXT_MIN, [tonal, hslToRgb(card)]),
      ]);

  return {
    primary,
    'primary-foreground': light ? [0, 0, 100] : [0, 0, 4],
    'accent-card': accentCard,
    'accent-card-deep': cardDeep,
    ring: primary,
    accent: tint,
    'blue-tint': light ? tint : (def.blueTintDark ?? tint),
    'accent-foreground': [def.h, s, accentForegroundL],
    'brand-iris': light ? primary : [def.h, s, clamp(primaryL + 2, 0, 88)],
    'brand-iris-soft': [def.h, s, clamp(primaryL + (light ? 11 : 8), 0, 92)],
    'card-tint': light ? [def.h, 22, 46] : [def.h, 26, 62],
  };
}

// ── Палитра данных: одна семья тона вместо категориального набора Okabe-Ito ────────────────────
/**
 * Канонические акценты карточек. Их приходится печатать ЯВНО при смене палитры данных, и в обеих
 * темах: наш `:root` живёт вне каскадных слоёв, а значит перебивает даже `.dark` из `@layer base`
 * — без тёмной копии светлый «прибитый» акцент утёк бы в тёмную тему.
 */
const CANON_ACCENT_LIGHT: readonly Hsl[] = [
  [218, 48, 48],
  [38, 62, 34],
  [166, 48, 31],
  [20, 58, 44],
  [328, 30, 50],
  [202, 46, 47],
];

const CANON_ACCENT_DARK: readonly Hsl[] = [
  [216, 86, 86],
  [67, 72, 64],
  [137, 48, 86],
  [18, 75, 83],
  [260, 64, 81],
  [205, 60, 84],
];

const CANON_ACCENT_DEEP_DARK: readonly Hsl[] = [
  [216, 72, 38],
  [66, 72, 28],
  [140, 58, 32],
  [18, 68, 36],
  [260, 55, 41],
  [205, 68, 36],
];

/** Шесть ступеней одного тона: светлота корректируется по каждой ступени до штрих-порога 3.0. */
function chartRamp(h: number, s: number, theme: Theme, card: Hsl, shift = 0): Hsl[] {
  const light = theme === 'light';
  return Array.from({ length: 6 }, (_, i) => {
    const hue = h + (i - 2.5) * 5;
    const sat = clamp(s * (0.8 - i * 0.04), 24, 78);
    const start = light ? 34 + i * 5.5 + shift : 72 - i * 5.5 + shift;
    const l = light
      ? solveL(hue, sat, clamp(start, 18, 66), 18, STROKE_MIN, [hslToRgb(card)])
      : solveL(hue, sat, clamp(start, 40, 88), 88, STROKE_MIN, [hslToRgb(card)]);
    return [hue, sat, l] as Hsl;
  });
}

/** Пять ступеней той же семьи для состава целого (RadialShare). */
function chartSequence(h: number, s: number, theme: Theme, card: Hsl): Hsl[] {
  const light = theme === 'light';
  return Array.from({ length: 5 }, (_, i) => {
    const sat = clamp(s * (0.78 - i * 0.05), 24, 76);
    const start = light ? 30 + i * 7.75 : 76 - i * 8.75;
    const l = light
      ? solveL(h, sat, clamp(start, 18, 64), 18, STROKE_MIN, [hslToRgb(card)])
      : solveL(h, sat, clamp(start, 38, 86), 88, STROKE_MIN, [hslToRgb(card)]);
    return [h, sat, l] as Hsl;
  });
}

/** Ключ палитры данных → тон. `accent` следует за выбранным акцентом, `canon` не трогает канон. */
function chartHue(chart: string, accent: string): AccentDef | null {
  if (chart === 'canon') return null;
  if (chart === 'accent') return accentDef(accent);
  const found = ACCENTS.find((item) => item.key === chart);
  return found ?? null;
}

// ── Радиус и шрифт ────────────────────────────────────────────────────────────────────────────
export interface RadiusDef {
  key: string;
  label: string;
  value: string;
}

/**
 * `--radius` держит только мелкое семейство (`rounded-sm/md/lg`), а карточки живут на
 * `rounded-xl/2xl`. Чтобы ручка меняла форму ВСЕГО, семейство пересчитывается от неё же —
 * смещения подобраны так, что канонические 4px дают ровно нынешние 12/16/24px.
 */
export const RADII: readonly RadiusDef[] = [
  { key: 'none', label: '0', value: '0rem' },
  { key: 'canon', label: '4', value: '0.25rem' },
  { key: 'md', label: '8', value: '0.5rem' },
  { key: 'lg', label: '12', value: '0.75rem' },
  { key: 'xl', label: '16', value: '1rem' },
];

/**
 * Стек с системным запасным вариантом того же класса: пока variable-файл едет (или если не доехал),
 * текст стоит на системном шрифте той же природы, а не на дефолтной засечке браузера.
 */
const FALLBACK = {
  sans: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif",
  serif: "ui-serif, Georgia, 'Times New Roman', Times, serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
} as const;

const font = (family: string, kind: keyof typeof FALLBACK = 'sans') =>
  `'${family}', ${FALLBACK[kind]}`;

export interface FontDef {
  key: string;
  /** Настоящее имя семейства — имя собственное, поэтому НЕ переводится. */
  label: string;
  /** Полный стек. `null` = канон (Geist), ничего не печатаем. */
  stack: string | null;
  /** Раздаём сами (`@fontsource-variable`) и грузим по требованию — см. lib/appearanceFonts. */
  webfont?: true;
  group: 'Без загрузки' | 'Гротеск' | 'Антиква' | 'Моноширинные';
}

/**
 * Семейства студии. Все — с КИРИЛЛИЦЕЙ: интерфейс русский, а шрифт без кириллического подмножества
 * оставил бы почти весь текст на запасном варианте, то есть выбор не работал бы (по этой причине
 * из списка shadcn выпали Outfit, Figtree, DM Sans, Space Grotesk и прочая латиница).
 * Каждое семейство — variable-начертание: один файл на всю ось веса вместо четырёх статических.
 */
export const FONTS: readonly FontDef[] = [
  { key: 'canon', label: 'Geist', stack: null, group: 'Без загрузки' },
  {
    key: 'system',
    label: 'System',
    stack: "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif",
    group: 'Без загрузки',
  },
  { key: 'inter', label: 'Inter', stack: font('Inter Variable'), webfont: true, group: 'Гротеск' },
  { key: 'manrope', label: 'Manrope', stack: font('Manrope Variable'), webfont: true, group: 'Гротеск' },
  { key: 'montserrat', label: 'Montserrat', stack: font('Montserrat Variable'), webfont: true, group: 'Гротеск' },
  { key: 'open-sans', label: 'Open Sans', stack: font('Open Sans Variable'), webfont: true, group: 'Гротеск' },
  { key: 'roboto', label: 'Roboto', stack: font('Roboto Variable'), webfont: true, group: 'Гротеск' },
  { key: 'nunito', label: 'Nunito', stack: font('Nunito Variable'), webfont: true, group: 'Гротеск' },
  { key: 'rubik', label: 'Rubik', stack: font('Rubik Variable'), webfont: true, group: 'Гротеск' },
  { key: 'raleway', label: 'Raleway', stack: font('Raleway Variable'), webfont: true, group: 'Гротеск' },
  { key: 'source-sans-3', label: 'Source Sans 3', stack: font('Source Sans 3 Variable'), webfont: true, group: 'Гротеск' },
  { key: 'ibm-plex-sans', label: 'IBM Plex Sans', stack: font('IBM Plex Sans Variable'), webfont: true, group: 'Гротеск' },
  { key: 'golos-text', label: 'Golos Text', stack: font('Golos Text Variable'), webfont: true, group: 'Гротеск' },
  { key: 'lora', label: 'Lora', stack: font('Lora Variable', 'serif'), webfont: true, group: 'Антиква' },
  {
    key: 'playfair-display',
    label: 'Playfair Display',
    stack: font('Playfair Display Variable', 'serif'),
    webfont: true,
    group: 'Антиква',
  },
  {
    key: 'jetbrains-mono',
    label: 'JetBrains Mono',
    stack: font('JetBrains Mono Variable', 'mono'),
    webfont: true,
    group: 'Моноширинные',
  },
  {
    key: 'roboto-mono',
    label: 'Roboto Mono',
    stack: font('Roboto Mono Variable', 'mono'),
    webfont: true,
    group: 'Моноширинные',
  },
];

export const fontDef = (key: string): FontDef | undefined =>
  FONTS.find((item) => item.key === key);

// ── Сборка ────────────────────────────────────────────────────────────────────────────────────
export type Theme = 'light' | 'dark';

export interface ResolvedTheme {
  /** Токены, которые нужно напечатать (пусто, если выбор канонический). */
  tokens: Array<[string, string]>;
}

export interface ResolvedAppearance {
  light: ResolvedTheme;
  dark: ResolvedTheme;
  /** Правила помимо переменных — сейчас только семейство шрифта на <body>. */
  rules: string[];
}

function resolveTheme(settings: AppearanceSettings, theme: Theme): ResolvedTheme {
  // Неизвестный ключ (старый blob, чужая версия) читается как канон и НИЧЕГО не печатает —
  // молчаливый откат к канону честнее, чем случайная палитра.
  const chosenBase = BASES.find((item) => item.key === settings.base && item.key !== 'canon');
  const chosenAccent = ACCENTS.find((item) => item.key === settings.accent && item.key !== 'canon');
  const base = baseTokens(chosenBase?.key ?? 'canon', theme);
  const tokens: Array<[string, string]> = [];
  const push = (token: string, value: Hsl) => tokens.push([token, fmtHsl(value)]);

  if (chosenBase) {
    for (const rung of theme === 'light' ? LIGHT_BASE : DARK_BASE) push(rung.token, base[rung.token]);
  }

  // Акцент пересчитывается и тогда, когда сменилась ТОЛЬКО нейтраль: подпись на тинте и на
  // размыве считается от холста, а холст только что уехал (иначе AA теряется на пол-единицы).
  if (chosenAccent || chosenBase) {
    const accent = accentTokens(chosenAccent?.key ?? 'canon', theme, base);
    for (const [token, value] of Object.entries(accent)) push(token, value);
  }

  const hue = chartHue(settings.chart, settings.accent);
  if (hue) {
    const s = theme === 'light' ? hue.s : hue.sDark;
    const ramp = chartRamp(hue.h, s, theme, base.card);
    ramp.forEach((value, i) => push(`chart-${i + 1}`, value));
    chartSequence(hue.h, s, theme, base.card).forEach((value, i) =>
      push(`chart-seq-${i + 1}`, value),
    );
    if (theme === 'light') {
      // В светлой теме и акценты карточек, и категориальные слоты — АЛИАСЫ `var(--chart-N)`.
      // Категориальные должны следовать выбору, а акценты карточек обязаны остаться шестью
      // разными тонами (это идентичность виджета), поэтому их прибиваем к канону явно.
      CANON_ACCENT_LIGHT.forEach((value, i) => {
        push(`chart-${i + 1}-accent`, value);
        push(`chart-${i + 1}-accent-deep`, value);
      });
    } else {
      CANON_ACCENT_DARK.forEach((value, i) => push(`chart-${i + 1}-accent`, value));
      CANON_ACCENT_DEEP_DARK.forEach((value, i) => push(`chart-${i + 1}-accent-deep`, value));
      // В тёмной теме категориальные слоты заданы явно — печатаем свою ступень выше линии серии.
      chartRamp(hue.h, s, theme, base.card, 5).forEach((value, i) =>
        push(`chart-${i + 1}-cat`, value),
      );
    }
  }

  return { tokens };
}

export function resolveAppearance(settings: AppearanceSettings): ResolvedAppearance {
  const light = resolveTheme(settings, 'light');
  const dark = resolveTheme(settings, 'dark');
  const rules: string[] = [];

  const radius = RADII.find((item) => item.key === settings.radius);
  if (radius && radius.key !== 'canon') {
    const v = radius.value;
    for (const [token, value] of [
      ['radius', v],
      ['radius-xl', `calc(${v} + 8px)`],
      ['radius-2xl', `calc(${v} + 12px)`],
      ['radius-3xl', `calc(${v} + 20px)`],
    ] as const) {
      light.tokens.push([token, value]);
    }
  }

  const font = FONTS.find((item) => item.key === settings.font);
  if (font?.stack) {
    light.tokens.push(['font-sans', font.stack]);
    // `body` в @layer base печатает семейство буквой, а не переменной, — правило без слоя его
    // перекрывает и заодно делает выбор видимым сразу, без перезагрузки.
    rules.push('body{font-family:var(--font-sans)}');
  }

  return { light, dark, rules };
}

const block = (selector: string, tokens: Array<[string, string]>, pretty: boolean): string => {
  if (tokens.length === 0) return '';
  const body = tokens.map(([token, value]) => `--${token}:${value}`);
  return pretty
    ? `${selector} {\n${body.map((line) => `  ${line};`).join('\n')}\n}`
    : `${selector}{${body.join(';')}}`;
};

function serialize(settings: AppearanceSettings, pretty: boolean): string {
  const resolved = resolveAppearance(settings);
  const parts = [
    block(':root', resolved.light.tokens, pretty),
    block('.dark', resolved.dark.tokens, pretty),
    ...resolved.rules.map((rule) => (pretty ? rule.replace('{', ' {\n  ').replace('}', ';\n}') : rule)),
  ].filter(Boolean);
  return parts.join(pretty ? '\n\n' : '');
}

/** CSS для вставки в документ и в localStorage-кэш прерисовочного бутстрапа. */
export const appearanceCss = (settings: AppearanceSettings): string => serialize(settings, false);

/** Тот же CSS, но читаемый — для «Скопировать CSS». */
export const appearanceCssPretty = (settings: AppearanceSettings): string =>
  serialize(settings, true) || ':root {\n  /* канон Atlavue — переменные не переопределяются */\n}';

// ── Образцы для интерфейса студии ─────────────────────────────────────────────────────────────
export function accentSwatch(key: string, theme: Theme): string {
  const base = baseTokens('canon', theme);
  return cssColor(accentTokens(key === 'canon' ? 'canon' : key, theme, base).primary);
}

export function baseSwatch(key: string, theme: Theme): string {
  const def = baseDef(key);
  const hue = theme === 'light' ? def.h : def.hDark;
  return cssColor([hue, 14 * def.k, theme === 'light' ? 62 : 46]);
}

/** Шесть образцов палитры данных — и для канона тоже (там это Okabe-Ito из index.css). */
export function chartSwatches(chart: string, accent: string, theme: Theme): string[] {
  const hue = chartHue(chart, accent);
  if (!hue) {
    return Array.from({ length: 6 }, (_, i) => `hsl(var(--chart-${i + 1}))`);
  }
  const base = baseTokens('canon', theme);
  return chartRamp(hue.h, theme === 'light' ? hue.s : hue.sDark, theme, base.card).map(cssColor);
}

// ── Пресеты и «случайно» ──────────────────────────────────────────────────────────────────────
export interface PresetDef {
  key: string;
  label: string;
  settings: AppearanceSettings;
}

export const PRESETS: readonly PresetDef[] = [
  { key: 'canon', label: 'Atlavue', settings: APPEARANCE_DEFAULT },
  {
    key: 'midnight',
    label: 'Полночь',
    settings: { accent: 'indigo', base: 'zinc', chart: 'accent', radius: 'md', font: 'canon' },
  },
  {
    key: 'terminal',
    label: 'Терминал',
    settings: { accent: 'emerald', base: 'neutral', chart: 'accent', radius: 'none', font: 'mono' },
  },
  {
    key: 'paper',
    label: 'Бумага',
    settings: { accent: 'amber', base: 'stone', chart: 'canon', radius: 'lg', font: 'serif' },
  },
  {
    key: 'bloom',
    label: 'Цветение',
    settings: { accent: 'fuchsia', base: 'slate', chart: 'rose', radius: 'xl', font: 'canon' },
  },
  {
    key: 'graphite',
    label: 'Графит',
    settings: { accent: 'sky', base: 'gray', chart: 'canon', radius: 'canon', font: 'system' },
  },
];

const pick = <T>(items: readonly T[], random: () => number): T =>
  items[Math.floor(random() * items.length) % items.length];

/** «Случайно»: тон и форма перебираются, шрифт остаётся выбранным — он про читаемость, не про вкус. */
export function shuffleAppearance(
  current: AppearanceSettings,
  random: () => number = Math.random,
): AppearanceSettings {
  const accent = pick(ACCENTS, random).key;
  return {
    accent,
    base: pick(BASES, random).key,
    chart: pick(['canon', 'accent', ...ACCENTS.map((item) => item.key)], random),
    radius: pick(RADII, random).key,
    font: current.font,
  };
}
