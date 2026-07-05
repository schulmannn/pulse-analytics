// Design-token governance lint — the motion + type-scale half of the «Design tokens governance» card.
// The colour tokens have scripts/contrast-tokens.mjs; this guards the axes that are easy to re-type
// ad-hoc per component instead of pulling from a token:
//   node scripts/design-motion-lint.mjs      → report + exit 1 on canon violations
// Canon (see frontend/DESIGN_TOKENS.md):
//   • the house easing cubic-bezier(0.2, 0.7, 0.3, 1) must be var(--ease-standard), never inlined
//   • UI durations come from the --motion-* ladder; raw ms/s live only in index.css :root, in the
//     allow-listed bespoke illustration keyframes, or in framer on the landing
//   • the type scale is the Tailwind fontSize ladder — no magic text-[Npx]
//   • no arbitrary Tailwind motion values (duration-[…] / ease-[…] / delay-[…]) — use the scale/tokens
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');
const HOUSE_CURVE = 'cubic-bezier(0.2, 0.7, 0.3, 1)';

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(css|tsx|ts)$/.test(name)) yield p;
  }
}

// Bespoke surfaces outside the product-UI canon: the public marketing landing is its own framer
// system with hand-tuned display typography, and Legal is long-form prose. They are exempt from the
// type-scale rule (restyling them is a separate task, not token governance) — but NOT from the motion
// rules: the house easing stays canonical everywhere.
const BESPOKE_TYPE = ['src/pages/Landing.tsx', 'src/pages/Legal.tsx'];

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
    id: 'arbitrary-motion-util',
    hint: 'use the duration scale / --motion-* tokens',
    test: (line) => /\b(?:duration|ease|delay)-\[/.test(line),
  },
];

let violations = 0;
for (const file of walk(srcDir)) {
  const rel = relative(root, file).replace(/\\/g, '/');
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, i) => {
    for (const rule of rules) {
      if (rule.exempt?.(rel)) continue;
      if (rule.test(line)) {
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
console.log('Design-token motion/type canon clean — no inlined easings, magic sizes or arbitrary motion utils.');
