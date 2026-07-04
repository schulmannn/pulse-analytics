// Token-level contrast review — the non-text half of the «Color contrast audit» roadmap card.
// axe (e2e/a11y-contrast.spec.ts) gates rendered TEXT; no automated rule covers WCAG 1.4.11
// non-text contrast (chart strokes, focus ring, UI boundaries), so this script recomputes the
// ratios straight from the palettes in src/index.css on every run:
//   node scripts/contrast-tokens.mjs        → table + exit 1 on hard failures
// Hard-fail classes: text pairs < 4.5 (AA), chart strokes / focus ring < 3.0 (1.4.11).
// Hairline borders are reported but never fail: they are decorative separators by design
// (the design canon delimits sections with hairlines, not functional boundaries).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'index.css'), 'utf8');

/** Extract `--name: H S% L%;` tokens from a css block (first block matching `selector`). */
function palette(selectorRe) {
  const start = css.search(selectorRe);
  if (start < 0) throw new Error(`palette not found: ${selectorRe}`);
  const block = css.slice(css.indexOf('{', start) + 1, css.indexOf('}', css.indexOf('{', start)));
  const tokens = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/g)) {
    tokens[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  }
  return tokens;
}

function hslToRgb([h, s, l]) {
  s /= 100;
  l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

const lum = (rgb) =>
  rgb
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)))
    .reduce((acc, c, i) => acc + c * [0.2126, 0.7152, 0.0722][i], 0);

const ratio = (fg, bg) => {
  const [l1, l2] = [lum(fg), lum(bg)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
};

/** Composite fg over bg with alpha (for strokes drawn at opacity < 1). */
const over = (fg, bg, alpha) => fg.map((c, i) => c * alpha + bg[i] * (1 - alpha));

const light = palette(/:root,\s*\n\s*\.force-light/);
const dark = palette(/\.dark \{/);

// [label, fgToken, bgToken, target, kind, alpha?] — kind: text | stroke | ring | border(warn-only)
const PAIRS = [
  ['muted text on card', 'muted-foreground', 'card', 4.5, 'text'],
  ['muted text on canvas', 'muted-foreground', 'background', 4.5, 'text'],
  ['muted text on hover-row', 'muted-foreground', 'hover-row', 4.5, 'text'],
  ['muted text on popover', 'muted-foreground', 'popover', 4.5, 'text'],
  ['ink2 on card', 'ink2', 'card', 4.5, 'text'],
  ['ink3 on card', 'ink3', 'card', 4.5, 'text'],
  ['link/accent text on card', 'primary', 'card', 4.5, 'text'],
  ['button label on primary', 'primary-foreground', 'primary', 4.5, 'text'],
  ['delta up (verdant) on card', 'brand-verdant', 'card', 4.5, 'text'],
  ['delta up on green tint', 'brand-verdant', 'green-tint', 4.5, 'text'],
  ['delta down (ember) on card', 'brand-ember', 'card', 4.5, 'text'],
  ['delta down strong on amber tint', 'brand-ember-strong', 'amber-tint', 4.5, 'text'],
  ['status-warn on card', 'status-warn', 'card', 4.5, 'text'],
  ['status-warn on amber tint', 'status-warn', 'amber-tint', 4.5, 'text'],
  ['accent-foreground on accent', 'accent-foreground', 'accent', 4.5, 'text'],
  ['destructive text on card', 'destructive', 'card', 4.5, 'text'],
  ['chip 1 ink on bg', 'chip-1-ink', 'chip-1-bg', 4.5, 'text'],
  ['chip 2 ink on bg', 'chip-2-ink', 'chip-2-bg', 4.5, 'text'],
  ['chip 3 ink on bg', 'chip-3-ink', 'chip-3-bg', 4.5, 'text'],
  ['chip 4 ink on bg', 'chip-4-ink', 'chip-4-bg', 4.5, 'text'],
  ['chip 5 ink on bg', 'chip-5-ink', 'chip-5-bg', 4.5, 'text'],
  ['chip 6 ink on bg', 'chip-6-ink', 'chip-6-bg', 4.5, 'text'],

  ['focus ring on card', 'ring', 'card', 3.0, 'ring'],
  ['focus ring on canvas', 'ring', 'background', 3.0, 'ring'],

  ['series line (iris) on card', 'brand-iris', 'card', 3.0, 'stroke'],
  ['chart-1 on card', 'chart-1', 'card', 3.0, 'stroke'],
  ['chart-2 on card', 'chart-2', 'card', 3.0, 'stroke'],
  ['chart-3 on card', 'chart-3', 'card', 3.0, 'stroke'],
  ['chart-4 on card', 'chart-4', 'card', 3.0, 'stroke'],
  ['chart-5 on card', 'chart-5', 'card', 3.0, 'stroke'],
  ['chart-6 on card', 'chart-6', 'card', 3.0, 'stroke'],
  ['ghost line (chart-2 @0.8) on card', 'chart-2', 'card', 3.0, 'stroke', 0.8],

  ['hairline on card', 'border', 'card', 3.0, 'border'],
  ['hairline on canvas', 'border', 'background', 3.0, 'border'],
  ['hairline on blue tint', 'border', 'blue-tint', 3.0, 'border'],
  ['hairline on amber tint', 'border', 'amber-tint', 3.0, 'border'],
];

let failures = 0;
for (const [themeName, tokens] of [
  ['light', light],
  ['dark', dark],
]) {
  console.log(`\n=== ${themeName} ===`);
  for (const [label, fgTok, bgTok, target, kind, alpha] of PAIRS) {
    if (!tokens[fgTok] || !tokens[bgTok]) {
      console.log(`  ?     ${label} — token missing (${fgTok} / ${bgTok})`);
      continue;
    }
    const bg = hslToRgb(tokens[bgTok]);
    let fg = hslToRgb(tokens[fgTok]);
    if (alpha != null) fg = over(fg, bg, alpha);
    const r = ratio(fg, bg);
    const pass = r >= target;
    const hard = kind !== 'border';
    if (!pass && hard) failures++;
    const mark = pass ? 'ok  ' : hard ? 'FAIL' : 'warn';
    console.log(`  ${mark}  ${r.toFixed(2).padStart(5)} (need ${target})  ${label}${kind === 'border' ? ' [decorative]' : ''}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} hard contrast failure(s).`);
  process.exit(1);
}
console.log('\nAll text/stroke/ring token pairs pass.');
