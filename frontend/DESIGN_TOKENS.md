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

### Chart series roles

Chart components consume **semantic role tokens** (`--chart-role-*` in `index.css`, bound as
`chart-role.*` in `tailwind.config.js`), never a raw `brand-*/chart-*` hue — so a widget can't invent
an ad-hoc colour and every series colour has one audited source. Each role aliases a deep/muted
palette token that already resolves per theme, so roles follow light/dark automatically. Colour-blind
safe: **primary** (blue) vs **comparison** (deep amber) is the Okabe-Ito high-contrast pair;
positive/negative never lean on hue alone (diverging bars use position around zero, delta pills use
↑/↓ + sign). Contrast (series↔surface, non-text 3.0) is gated per role in `scripts/contrast-tokens.mjs`.

| Role | Token | Aliases | Used by |
|---|---|---|---|
| Primary | `--chart-role-primary` | `--brand-iris` | line · area · points · bars · Breakdown fill · DivergingBars up |
| Comparison | `--chart-role-comparison` | `--chart-2` | dashed previous-period / baseline ghost |
| Positive | `--chart-role-positive` | `--brand-verdant` | gains / up emphasis (delta text) |
| Negative | `--chart-role-negative` | `--brand-ember` | losses / down (DivergingBars down · delta text) |
| Warning | `--chart-role-warning` | `--status-warn` | anomaly / caution markers |
| Neutral | `--chart-role-neutral` | `--muted-foreground` | target line · «Прочее» pie slice |
| Selection | `--chart-role-selection` | `--brand-iris` | hover point + crosshair (= the accent) |

The categorical **`--chart-1 … --chart-6`** (Okabe-Ito) stay for MULTI-series charts (pie slices,
multi-line); the roles above are the single-series semantic set. `DeltaPill` / `WidgetRenderer` keep
the canonical text tokens (`verdant` / `ember` / `status-warn` / `primary`) — those ARE the text side
of the positive / negative / warning / primary roles (tuned for AA 4.5 as text, with on-tint
variants), so they read role-consistent without duplicating a stroke token.

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

Header affordances (expand / menu / remove) share **one** quiet circular shape: `rounded-full` + hover
surface, sized `h-8 w-8` (32px touch target) on mobile and the quieter `h-7 w-7` (28px) at ≥sm where a
cursor is precise. See the `iconBtn` string in `ChartWidget.tsx`.

**Touch targets.** On mobile every primary control clears **32px** — icon buttons and the per-widget
period filter pills grow their hit area below `sm` (the compact desktop look returns at ≥sm). Gated by
`e2e/mobile-nav.spec.ts` at 360 / 390 / 430px (also asserts no horizontal page scroll). Inline text
links / ⓘ keep their text size — their tap area is the text and the same action has a full-size path in
the detail overlay.

## Content density (card ↔ detail)

Every widget reads at **one predictable density** per footprint — a card never grows an inner scrollbar
or clips; the extra content lives in «Развернуть». The contract, top to bottom:

- **Fixed tiles.** `third`/`half` cards lock to one height (`SIZE_H` in `ChartWidget.tsx`); the body is
  `overflow-hidden` (never `auto`), so content adapts to the tile instead of scrolling. `full` cards
  span the row and are content-height.
- **Fit-to-height lists.** `Breakdown` renders only the rows that FIT the measured body height plus a
  `+N ещё — полный список в «Развернуть»` line; the detail overlay (`ChartExpandedContext`) shows the
  full list. Value ledgers (`ValueLedger`) cap at 8 rows with the same «+N ещё».
- **Summary in card, proof in detail.** The story card leads with hero + delta + one caption; the terse
  source/quality meta is one truncating line with a ⓘ. The full «почему это число» panel
  (`MetricExplainPanel` — formula, source, sample, freshness, comparison) renders **only when expanded**
  (`WidgetRenderer`). Insights show statement + why + action in the card, evidence link inline.
- **Gate.** `e2e/dashboard.spec.ts` asserts no inner scrollbar / no runaway height across the whole TG
  feed (Обзор / Аналитика / Посты / Упоминания) + Отчёты, at every breakpoint. A widget that stops
  fitting its tile fails there.

## Layering (z-index)

Depth is **hairlines + z-index only** (no shadows / blur / glow), so the stack order must be explicit.
The floating/overlay layer pulls from **one** named ladder (`zIndex` in `tailwind.config.js`) — never
hand-pick a raw `z-40`/`z-50` for an overlay. Plain in-flow stacking *inside* a single component (a
`relative z-10` label over its own fill) stays untokenised; the scale governs cross-surface overlays.

| Token | Value | Layer |
|---|---|---|
| `z-sticky` | 20 | in-flow sticky chrome — topbar, page/section headers |
| `z-nav` | 30 | fixed app navigation — sidebar, mobile bottom nav |
| `z-popover` | 40 | transient triggers over content — ⋯ menus, dropdowns, reorder pill |
| `z-modal` | 50 | full overlays + their scrim — detail, dialogs, drawers, command palette |
| `z-toast` | 60 | notifications above modals (reserved) |
| `z-tooltip` | 70 | always-on-top hints (`InfoTooltip`) — must show even inside a modal |

Rules:
- **Portal strategy.** Full overlays (modals, drawers, command palette, tooltips) render into
  `document.body` via `createPortal`, so no ancestor's `overflow`/`transform` stacking context can clip
  or trap them; the token only orders them against each other.
- **Nested overlays** follow the ladder: a menu (`z-popover`) opens above sticky chrome; a dialog
  (`z-modal`) covers menus; a tooltip (`z-tooltip`) stays legible even over a dialog. A menu must never
  out-rank a dialog.
- **Sticky < nav**: a scrolled sticky header slides *under* the fixed rail, never over it.
- Escape / outside-click dismissal is owned per-overlay (`useFocusTrap` + capture-phase Escape in
  `DetailShell`); the z-scale governs paint order only, not closing.

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

**Overlays & mobile sheets.** Dialogs are borders-only (no shadow): a `bg-background/70` backdrop fades
in (`.detail-backdrop-in`, `--motion-press`) while the panel appears. On mobile the card **detail**
(`DetailShell` `panel`) drops its inset to a full-height, edge-to-edge sheet (`p-0 sm:p-4`,
`rounded-none sm:rounded`), and the **source switcher** opens as a bottom sheet that slides up
(`.sheet-in`, `--motion-reveal`) — both portal-rendered above the bottom nav, focus-trapped
(`useFocusTrap`), Escape/backdrop-dismissable, and bottom-padded with `env(safe-area-inset-bottom)` so
the last row clears the home indicator (the fixed bottom nav uses the same pad). Gated by
`e2e/mobile-nav.spec.ts`.

## Loading & layout stability (CLS)

Skeletons and loading rows must reserve the **same footprint** as the content they stand in for, so
nothing jumps when data resolves. Suspense fallbacks are layout-matching scaffolds, never spinners
(`App.tsx`); a status/row that only appears after data (e.g. the sidebar freshness line) reserves its
height while pending instead of `return null`→pop-in; a widget skeleton matches its loaded variant's
height. Budget: cumulative layout shift per core route stays under **0.1** (Google's "good" CLS
threshold) — gated by `e2e/layout-shift.spec.ts` across all four breakpoints. Add a new widget
variant's skeleton at its loaded height, or the route's CLS budget catches the jump.

## Governance

Run from `frontend/`:

- `node scripts/contrast-tokens.mjs` — WCAG contrast for the colour tokens (text 4.5 / non-text 3.0;
  hairlines warn-only). Pairs with the axe `e2e/a11y-contrast.spec.ts` gate (rendered text).
- `npm run lint:motion` (`node scripts/design-motion-lint.mjs`) — hard-fails on an inlined house easing,
  magic `text-[Npx]`, or arbitrary `duration-[…]/ease-[…]/delay-[…]` under `src/`. The public
  marketing landing (`pages/Landing.tsx`, its own framer system) and `pages/Legal.tsx` (long-form
  prose) are exempt from the **type-scale** rule only — the motion rules apply everywhere. Migrating
  those two surfaces onto the scale is a separate, deliberate task.
