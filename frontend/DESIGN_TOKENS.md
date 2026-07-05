# Atlavue design tokens — the canon

One place that names every design decision, so components consume tokens instead of re-typing
magic values ("каждый компонент сам по себе"). Definitions live in **`src/index.css` `:root`** (colour,
surface, radius, motion) and **`tailwind.config.js`** (type scale, radius bindings, colour bindings).
Two scripts guard the canon (see [Governance](#governance)).

> Philosophy: *Refined Technical* — warm paper canvas, warm ink scale, hairlines instead of card
> chrome, **one** blue accent (`#2d6be0`), only two weights (400/500), no shadows / blur / glow.
> Hierarchy comes from **size + ink shade**, never weight or elevation.

## Colour & surfaces

All colours are HSL channels in `src/index.css` (`:root, .force-light` = light, `.dark` = dark) and
bound to Tailwind utilities in `tailwind.config.js`. Never hardcode a hex/hsl in a component — use the
semantic token.

| Role | Token(s) | Notes |
|---|---|---|
| Canvas / ink | `--background` `--foreground` | warm paper `#faf9f6` / ink `#1a1a17` |
| Panel surface | `--card` `--popover` | `#fff` panels used **sparingly** — sections are hairline-delimited |
| Secondary/tertiary ink | `--muted-foreground` `--ink2` `--ink3` | text hierarchy by shade, not weight |
| Accent (single hue) | `--primary` `--accent` `--accent-foreground` | `--accent-foreground` is AA-calibrated for ink on the blue tints |
| Deltas | `--brand-verdant` (up) `--brand-ember` / `-strong` (down) | deepened to clear AA 4.5 as text + on 10% tint |
| Status | `--status-warn` | risk / demo / stale collector |
| Hairline | `--border` `--input` | decorative separators (the *only* borders in the system) |
| Categorical series | `--chart-1 … --chart-6` | Okabe-Ito, colour-blind-safe; series always carry a label too |
| Identity chips | `--chip-{1..6}-{bg,ink}` | deterministic per channel-name hash |

## Type scale

**One** ladder, in `tailwind.config.js` `fontSize`. No magic `text-[Npx]` — the lint hard-fails on it.
Keep ≲4 steps on a single screen.

`text-2xs` 11 (meta · axis ticks) · `text-xs` 12 (caption) · `text-sm` 14 (body/default) ·
`text-base` 16 (card titles) · `text-lg` 18 (sub-heading, sparingly) · `text-2xl` 24 (page/modal
titles) · `text-3xl` 30 (secondary metric) · `text-hero` 44 (primary KPI hero).

Fonts: `font-sans` = Inter (everything); `font-mono` = Roboto Mono (scoped to timestamps / collector
version / API status only).

## Radius

`--radius: 0.25rem` (4px) — panels. Tailwind binds `rounded-lg/md/sm` to it (`var(--radius)` and −2/−4px).
Cards use `rounded-xl` (12px) and pill controls use `rounded-full` — both intentional, above the panel
radius. Icon buttons are `rounded-full`.

## Border / hairline opacity

Hairlines are `--border`. Soft over-surface tints use a small, deliberate opacity set rather than
arbitrary values: `foreground / 0.06` (hover wash), `ink3 / 0.25` (edit-mode card edge),
`white / 0.06` (dark card edge). Keep to these; don't invent new alphas per component.

## Icon buttons

Header affordances (expand / menu / remove) share **one** quiet circular shape: `h-7 w-7` (28px hit
target) + `rounded-full` + hover surface. See the `iconBtn` string in `ChartWidget.tsx`.

## Motion

The house easing + a small duration ladder, defined once in `src/index.css` `:root` (theme-agnostic).
UI motion pulls from these; components must not inline a duration/easing.

| Token | Value | Use |
|---|---|---|
| `--ease-standard` | `cubic-bezier(0.2, 0.7, 0.3, 1)` | the house entrance / settle ease-out — **the only** hand-authored easing |
| `--motion-press` | 140ms | tactile press feedback (button dip) |
| `--motion-fast` | 200ms | quick opacity / colour fades |
| `--motion-base` | 240ms | standard control transition (mode swap · icon · hover→active) |
| `--motion-glide` | 260ms | FLIP reorder glide · icon stroke draw-on |
| `--motion-reveal` | 300ms | larger reveals (add-widget rise) |
| `--motion-entrance` | 350ms | card mount rise |

Tailwind's `duration-{100,200,300}` + `ease-out` utilities are an accepted part of the scale;
arbitrary `duration-[…]` / `ease-[…]` are **not** (lint hard-fails). CSS custom props resolve inside
inline `style.transition` too, so JS-driven transitions use `var(--motion-glide) var(--ease-standard)`
(see the reorder FLIP in `ChartWidget.tsx`).

**Reduced motion.** A global safety net in `index.css` collapses every animation/transition to 0.01ms
under `prefers-reduced-motion: reduce`, so token-driven rules never need a per-rule guard. Infinite
loops (reorder jiggle, starfield twinkle) and readability-critical reveals additionally carry explicit
`animation: none`. JS motion (framer on the landing) gates in-component via `useReducedMotion`.

**Bespoke (not canon).** Illustration loops keep their own timings on purpose and are allow-listed by
the lint: cartograph (error/404/empty), the `/connect` orbital hub + starfield, and the reorder jiggle.
Framer on the public landing is its own system (`EASE` constant + per-variant durations).

## Governance

Run from `frontend/`:

- `node scripts/contrast-tokens.mjs` — WCAG contrast for the colour tokens (text 4.5 / non-text 3.0;
  hairlines warn-only). Pairs with the axe `e2e/a11y-contrast.spec.ts` gate (rendered text).
- `npm run lint:motion` (`node scripts/design-motion-lint.mjs`) — hard-fails on an inlined house easing,
  magic `text-[Npx]`, or arbitrary `duration-[…]/ease-[…]/delay-[…]` under `src/`. The public
  marketing landing (`pages/Landing.tsx`, its own framer system) and `pages/Legal.tsx` (long-form
  prose) are exempt from the **type-scale** rule only — the motion rules apply everywhere. Migrating
  those two surfaces onto the scale is a separate, deliberate task.
