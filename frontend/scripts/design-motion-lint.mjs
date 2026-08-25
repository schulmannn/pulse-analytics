// Design-token governance lint — the motion + type-scale half of the «Design tokens governance» card.
// The colour tokens have scripts/contrast-tokens.mjs; this guards the axes that are easy to re-type
// ad-hoc per component instead of pulling from a token:
//   node scripts/design-motion-lint.mjs      → report + exit 1 on canon violations
// Canon (see frontend/DESIGN_TOKENS.md):
//   • the house easing cubic-bezier(0.23, 1, 0.32, 1) must be var(--ease-standard), never inlined
//   • UI durations come from the --motion-* ladder. In .ts/.tsx that means the dur-* / ease-house
//     utilities (index.css) — never a numeric `duration-300` or a bare `ease-out`. Raw ms/s live in
//     index.css only: the :root ladder and the allow-listed bespoke illustration/landing keyframes.
//     (index.css itself is NOT scanned by the duration/easing-utility rules — it is
//     where the exceptions legitimately live; the house-easing rule still applies to it.)
//   • never `transition-all` — it animates layout-triggering properties (width/height/padding) too,
//     which drops frames on a busy main thread. Enumerate: transition-[width] / transition-colors.
//   • the type scale is the Tailwind fontSize ladder — no magic text-[Npx]
//   • no arbitrary Tailwind motion values (duration-[…] / ease-[…] / delay-[…]) — use the scale/tokens
//   • selected chips painted with bg-primary/10 use text-accent-foreground, whose composite
//     contrast is gated by contrast-tokens.mjs; text-primary is only for neutral surfaces
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');
const HOUSE_CURVE = 'cubic-bezier(0.23, 1, 0.32, 1)';

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(css|tsx|ts)$/.test(name)) yield p;
  }
}

// Bespoke surfaces outside the product-UI canon: the public marketing landing owns a CSS-native
// motion system with hand-tuned display typography, and Legal is long-form prose. They are exempt from the
// type-scale rule (restyling them is a separate task, not token governance) — but NOT from the motion
// rules: the house easing stays canonical everywhere.
const BESPOKE_TYPE = ['src/pages/Landing.tsx', 'src/pages/Legal.tsx'];

/**
 * A transitioned property that forces the browser to re-layout every frame.
 *
 * Box-model and inset properties, including their directional longhands (padding-bottom,
 * margin-inline-start, …) — writing the longhand is the easiest way to slip past a naive list, so
 * the shorthands are generated rather than enumerated. Durations in CSS always come from the
 * ladder, so `<prop> var(--motion-…)` marks a transitioned property without parsing multi-line
 * transition lists.
 */
const SIDE = '(?:-(?:top|right|bottom|left|inline|block|start|end))';
const LAYOUT_PROP_TRANSITION = new RegExp(
  String.raw`^\s*(?:transition:\s*)?(?:` +
    [
      String.raw`(?:min-|max-)?(?:width|height)`,
      String.raw`(?:padding|margin|inset)${SIDE}{0,2}`,
      String.raw`(?:row-|column-)?gap`,
      String.raw`(?:top|right|bottom|left)`,
      String.raw`flex-basis`,
    ].join('|') +
    String.raw`)\s+var\(--motion-`,
);

/**
 * Does the CSS rule block containing this line carry an opt-out marker?
 *
 * Scans backwards to the block's opening brace, so a marker written above the declaration (or in
 * the block's doc comment) applies to that block and nothing else — a note left on one rule cannot
 * silently excuse the next one. Bounded by the file start; the `{` terminator makes it cheap.
 */
function blockHasMarker({ lines, index }, marker) {
  if (lines[index].includes(marker)) return true;
  for (let i = index - 1; i >= 0; i--) {
    if (lines[i].includes(marker)) return true;
    if (lines[i].includes('{')) return false;
  }
  return false;
}

const rules = [
  {
    id: 'house-easing-inlined',
    hint: 'use var(--ease-standard)',
    // The only allowed literal is the token definition itself.
    test: (line) => line.includes(HOUSE_CURVE) && !line.includes('--ease-standard:'),
  },
  {
    id: 'magic-type-size',
    hint: 'use the Tailwind type scale (text-2xs … text-hero)',
    test: (line) => /text-\[\d+(px|rem)\]/.test(line),
    exempt: (rel) => BESPOKE_TYPE.includes(rel),
  },
  {
    id: 'hero-number-recipe-retyped',
    hint: 'render the card headline through components/chartWidget/KpiValue',
    // Рецепт крупного числа карточки был скопирован в четыре места, и копии разошлись: канон
    // давно чинил line-box на leading-[1.15] («глиф-бокс дисплейного начертания выше line-box,
    // leading-none клипал цифры в фикс-тайле»), а две копии остались на leading-none. Одинаковые
    // 44px с разной высотой строки читаются как две разные системы. Размер героя живёт в одном
    // компоненте; нужен другой — он появляется там вариантом, а не строкой классов на месте.
    test: (line) => /\btext-hero\b/.test(line),
    exempt: (rel) => rel.endsWith('.css') || rel.endsWith('components/chartWidget/KpiValue.tsx'),
  },
  {
    id: 'arbitrary-motion-util',
    hint: 'use the duration scale / --motion-* tokens',
    test: (line) => /\b(?:duration|ease|delay)-\[/.test(line),
  },
  {
    id: 'raw-duration-util',
    hint: 'use dur-press / dur-fast / dur-base / dur-reveal (or anim-dur-fast)',
    // Tailwind's numeric scale (duration-300) is off-ladder by construction: it re-types a number
    // that already has a token. `duration-0` is exempt — it is the «disable this transition» idiom
    // (motion-reduce:duration-0), not a timing choice. index.css owns the raw values, so it is
    // skipped: that is where the ladder and the bespoke illustration loops are defined.
    test: (line) => /\b(?:duration|delay)-(?!0\b|\[)\d/.test(line),
    exempt: (rel) => rel.endsWith('.css'),
  },
  {
    id: 'raw-ease-util',
    hint: 'use ease-house (= var(--ease-standard))',
    // Same reasoning: ease-out / ease-in-out are Tailwind's built-ins, not the house curve. The
    // bespoke illustration keyframes (cartograph / connect / starfield / jiggle) legitimately use
    // their own curves and live in index.css, which this rule skips.
    test: (line) => /\bease-(?:in|out|linear|in-out)\b/.test(line),
    exempt: (rel) => rel.endsWith('.css'),
  },
  {
    id: 'transition-all',
    hint: 'enumerate the properties — transition-all animates layout (width/height/padding) too',
    test: (line) => /\btransition-all\b/.test(line),
  },
  {
    id: 'layout-animating-transition',
    hint: 'animate transform/opacity — or mark the block «layout-anim-ok: why» if the reflow IS the effect',
    // The CSS half of the transition-all rule. Transitioning width/height/padding/inset makes the
    // browser re-layout on every frame, which drops frames the moment the main thread is busy —
    // Emil Kowalski's first performance rule, and the one violation `transition-all` could not see
    // because hand-written CSS names its properties explicitly.
    //
    // This is a WARNING WITH AN ESCAPE HATCH, not a ban: three surfaces here animate layout on
    // purpose (a layout-pushing sidebar rail cannot be a transform — the content must reflow). Those
    // carry a `layout-anim-ok:` note in their rule block, so each one is a decision someone wrote
    // down rather than a habit that slipped in.
    //
    // Durations in CSS always come from the ladder, so `<prop> var(--motion-…)` identifies a
    // transitioned property without having to parse multi-line transition lists.
    test: (line, ctx) => LAYOUT_PROP_TRANSITION.test(line) && !blockHasMarker(ctx, 'layout-anim-ok'),
  },
  {
    id: 'arbitrary-z-index',
    hint: 'use the layering scale (z-sticky … z-tooltip) — see DESIGN_TOKENS «Layering»',
    // Arbitrary z-index (z-[999]) side-steps the ladder and reintroduces the tie-fights the scale
    // exists to prevent. Named/numeric utilities (z-modal, z-10) are fine; only bracketed values fail.
    // The bespoke marketing landing owns its own CSS-native hero stacking — exempt like the type rule.
    test: (line) => /\bz-\[/.test(line),
    exempt: (rel) => rel === 'src/pages/Landing.tsx',
  },
  {
    id: 'primary-tint-ink',
    hint: 'use text-accent-foreground on bg-primary/10 (AA composite); reserve text-primary for neutral surfaces',
    // The safe hover recipe may keep a base `text-primary` while switching BOTH the hover
    // background and ink (`hover:bg-primary/10 hover:text-accent-foreground`) on the same line.
    test: (line) =>
      line.includes('bg-primary/10') &&
      line.includes('text-primary') &&
      !line.includes('text-accent-foreground'),
  },
];

let violations = 0;
for (const file of walk(srcDir)) {
  const rel = relative(root, file).replace(/\\/g, '/');
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const rule of rules) {
      if (rule.exempt?.(rel)) continue;
      if (rule.test(line, { lines, index: i, rel })) {
        violations++;
        console.log(`  ${rel}:${i + 1}  [${rule.id}] ${rule.hint}`);
        console.log(`      ${line.trim()}`);
      }
    }
  });
}

if (violations > 0) {
  console.error(`\n${violations} design-token violation(s). Move the value into a token (see frontend/DESIGN_TOKENS.md).`);
  process.exit(1);
}
console.log('Design-token canon clean — no inlined easings, magic sizes, arbitrary motion utils or low-contrast primary tint ink.');
