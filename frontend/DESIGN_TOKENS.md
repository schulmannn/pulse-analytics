# Atlavue design tokens — the canon

One place that names every design decision, so components consume tokens instead of re-typing
magic values ("каждый компонент сам по себе"). Definitions live in **`src/index.css` `:root`** (colour,
surface, radius, motion) and the **`@theme` block in `src/index.css`** (type scale, radius bindings, colour bindings — Tailwind v4, no JS config).
Two scripts guard the canon (see [Governance](#governance)).

> Philosophy: *Refined Technical* — near-black desktop dark theme is the primary product surface;
> the maintained light theme uses warm paper and ink. Hierarchy comes from size, ink shade,
> hairlines and restrained surface contrast. One calm blue is the action accent; data series use the
> canonical categorical palette. A single subtle card shadow and the chart tooltip shadow are
> allowed for separation; decorative glow, blur-heavy chrome and arbitrary elevation are not.

## Colour & surfaces

All colours are HSL channels in `src/index.css` (`:root, .force-light` = light, `.dark` = dark) and
bound to Tailwind utilities in the `@theme` block (`src/index.css`). Never hardcode a hex/hsl in a component — use the
semantic token.

| Role | Token(s) | Notes |
|---|---|---|
| Canvas / ink | `--background` `--foreground` | warm paper `#faf9f6` / ink `#1a1a17` |
| Panel surface | `--card` `--popover` | `#fff` panels used **sparingly** — sections are hairline-delimited |
| Secondary/tertiary ink | `--muted-foreground` `--ink2` `--ink3` | text hierarchy by shade, not weight |
| Accent (single hue) | `--primary` `--accent` `--accent-foreground` | `--primary` is link/action ink on neutral surfaces; selected chips with `bg-primary/10` use the deeper `--accent-foreground`, AA-gated on that composite tint |
| Deltas | `--brand-verdant` (up) `--brand-ember` / `-strong` (down) | CHART roles (DivergingBars), status surfaces, and the evaluated Δ of the **metric explorer** (`/metrics/*`) — cards, tables and modals stay muted; see «One voice for deltas» below |
| Status | `--status-warn` | risk / demo / stale collector |
| Hairline | `--border` `--input` | decorative separators (the *only* borders in the system) |
| Categorical series | `--chart-1 … --chart-6` | Muted/refined (Steep-noble), Okabe-Ito-ordered for colour-blind safety; light stays deep enough for non-text 3.0 on white, dark goes softer; series always carry a label too |
| Identity chips | `--chip-{1..6}-{bg,ink}` | deterministic per channel-name hash |

**One voice for deltas.** Direction always lives in the GLYPH (`↑ ↓` / `▲ ▼ ±` / `+ − ±`) **and, where
the glyph is `aria-hidden`, in an `sr-only` word** — never in hue alone (WCAG 1.4.1). Colour is
decoration on top of a sign that already reads without it.

The one surface that takes that decoration is the **metric explorer** (`/metrics/*` of every
vertical) — the drill-down whose entire job is «сравнить и оценить». Inside it, coloured TEXT in
`verdant` / `ember`, never a tinted chip or filled pill (the old `DeltaBadge` is gone):

- the comparison rail's period-vs-period row — `ComparisonDelta` / `ComparisonDeltaRow`
  (`components/metric/shared.tsx`), the single component behind TG / IG / MS / Метрика / упоминания;
- the same evaluated Δ when the page states it in prose instead of the rail («изменение за окно» in
  the IG follows descriptor, `IgMetricPage.tsx`);
- the pinned-point inspector's «К пред. дню / К пред. точке» (`PinnedDayPanel` hosts in
  `MetricPage` / `IgMetricPage` / `YmMetricPage`);
- `RankChart`'s baseline column — the rank viz's own form of that same comparison.

Colour there is a **verdict**, so a metric that carries no sentiment opts out of it while keeping the
same markup: `ComparisonDelta`/`ComparisonDeltaRow` take `evaluative={false}` and render the glyph and
the spoken direction in muted ink. Brand-mention VOLUME is the standing case — more mentions is not
self-evidently better (mirrors `DeltaLine` on `/mentions`: «never green/red — mention counts carry no
sentiment»). Share the component, not the judgement.

**Everything outside the explorer reads muted**, direction carried by the sign alone: card stats
(`DeltaPill`, `StatTile`), the per-cell «к медиане» deltas in the content tables (four coloured
percentages per row turned the densest surface into the loudest one) **and the same «к медиане» line
in the post modal opened from that cell** — one comparison may not speak in two voices depending on
which surface shows it. Zero is neutral (`±`, muted) everywhere.

Known tail, NOT covered by this pass: the hashtag **lift** column in `components/instagram/content.tsx`
still paints `verdant` / `ember` — it is a benchmark ratio, not a period Δ, and by this rule it should
go muted; left alone here to keep the ticket's blast radius. The marketing `pages/Landing.tsx` mock is
out of the app canon entirely. This rule NARROWS where verdant/ember may appear; it never licenses new
colour.

### Chart series roles

Chart components consume **semantic role tokens** (`--chart-role-*` in `index.css`, bound as
`--color-chart-role-*` in the `@theme` block), never a raw `brand-*/chart-*` hue — so a widget can't invent
an ad-hoc colour and every series colour has one audited source. Each role aliases a deep/muted
palette token that already resolves per theme, so roles follow light/dark automatically. Colour-blind
safe: **primary** (blue) vs **comparison** (deep amber) is the Okabe-Ito high-contrast pair;
positive/negative never lean on hue alone (diverging bars use position around zero, delta pills use
↑/↓ + sign). Contrast (series↔surface, non-text 3.0) is gated per role in `scripts/contrast-tokens.mjs`.

| Role | Token | Aliases | Used by |
|---|---|---|---|
| Primary | `--chart-role-primary` | `--brand-iris` | line · area · points · bars · Breakdown fill · DivergingBars up |
| Comparison | `--chart-role-comparison` | `--chart-2` | previous-period / baseline ghost: **dashed, no fill** in every line host (incl. the metric explorer); bar hosts draw the ghost as a COLUMN at one shared alpha (`BarChart` `GHOST_ALPHA` = the line ghost's `0.8`, covering bars, hover highlight, legend and tooltip swatch) — an owner's decision, since a dash over bars mixes shape languages. The alpha is read straight out of `BarChart.tsx` by `scripts/contrast-tokens.mjs`: anything below non-text 3.0 on the light card fails the gate |
| Positive | `--chart-role-positive` | `--brand-verdant` | gains / up emphasis (delta text) |
| Negative | `--chart-role-negative` | `--brand-ember` | losses / down (DivergingBars down · delta text) |
| Warning | `--chart-role-warning` | `--status-warn` | anomaly / caution markers |
| Neutral | `--chart-role-neutral` | `--muted-foreground` | target line · «Прочее» pie slice |
| Selection | `--chart-role-selection` | `--brand-iris` | hover point + crosshair (= the accent) |

The categorical **`--chart-1 … --chart-6`** (Okabe-Ito) stay for MULTI-series charts (pie slices,
multi-line); the roles above are the single-series semantic set. `ComparisonDelta` / `WidgetRenderer`
keep the canonical text tokens (`verdant` / `ember` / `status-warn` / `primary`) — those ARE the text side
of the positive / negative / warning / primary roles (tuned for AA 4.5 as text, with on-tint
variants), so they read role-consistent without duplicating a stroke token.

### Surface & width policy

Two enforceable rules govern a widget card's **background** and its **minimum footprint**, keyed on the
widget's visualisation. Both live in **`src/lib/widgetSurface.ts`** (pure, unit-tested in
`widgetSurface.test.ts`) and are applied **centrally** where a `WidgetConfig` becomes a card
(`ConfigWidget.tsx`) — never as a per-page class exception.

- **Surface (colour).** Only a single-metric **story** card — a hero number (`kpi`) or its single-series
  `line` — may carry a tonal (accent-tinted) background. Every multi-series / categorical / tabular viz
  (`bar`, `donut`, `list`, `rank`, `pivot`, `table`, `ledger` — Breakdown & the Mentions ranking
  included) stays on a **neutral** surface *regardless of the saved accent*: a coloured wash behind many
  series or rows reads as status, not story. The accent still lives on the **series stroke** and the
  **hero number** (`--chart-role-primary`); only the card BACKGROUND is neutralised. Positive/negative
  colour stays reserved for the *evaluated comparison Δ* (`ComparisonDelta`), never categorical series
  and never the quiet card/table deltas. Previous-period
  comparison stays dashed/no-fill in every LINE host (`--chart-role-comparison`); bars are the one
  owner-sanctioned exception (see the Comparison row above).
  → `vizAllowsTonalSurface(viz)` / `effectiveTinted(viz, savedTinted)`.
  On the dark TINTED card the widget **title** also rides the accent (`.widget-title` rule in
  `index.css`) — title, number, line and surface share one hue (steep); a neutral or un-tinted card
  keeps the default ink title, and light keeps ink titles everywhere. The header icon affordances
  (⋯ / ↗ / ×) follow one quiet step lower — accent at 0.8 (`.widget-icon`, non-text 3.0-gated);
  their hover pops (`hover:text-foreground` / `hover:text-destructive`) stay untinted.
- **Width.** A temporal `line`/area cannot render at a **third** width — the x-axis collapses into
  sub-pixel mush (cf. the downsample note in `CLAUDE.md`). Such a viz is coerced UP to `half` rather
  than silently dropping points; compact vizzes (kpi hero, bar, donut) read fine at third.
- **Literal footprints.** The desktop grid has six columns: `third` is 2 columns (33%), `half` is
  3 columns (50%), and `full` is 6 columns (100%). Editor labels and rendered widths must match.
  → `vizAllowsThirdWidth(viz)` / `coerceSizeForViz(viz, size)`.

## Type scale

**One** ladder, in the `@theme` block (`--text-*`). No magic `text-[Npx]` — the lint hard-fails on it.
Keep ≲4 steps on a single screen.

`text-2xs` 11 (meta · axis ticks) · `text-xs` 12 (caption) · `text-sm` 14 (body/default) ·
`text-base` 16 (card titles) · `text-lg` 18 (sub-heading, sparingly) · `text-2xl` 24 (page/modal
titles) · `text-3xl` 30 (secondary metric) · `text-hero` 44 (primary KPI hero).

Fonts: `font-sans` = bundled `Geist Variable` from `@fontsource-variable/geist` (the whole modern
app); `font-mono` = the local system monospace stack, scoped to timestamps / collector version / API
status only. No screen depends on Google Fonts: the legacy shell uses system sans/serif stacks, and
production CSP keeps `font-src 'self'` only. The two explicit `@font-face` rules ship only the
RU/Cyrillic and Latin subsets; extended scripts intentionally fall back to the system stack.

## Radius

`--radius: 0.25rem` (4px) — inputs and small controls. Tailwind binds `rounded-lg/md/sm` to it
(`var(--radius)` and −2/−4px). **Card-scale surfaces are `rounded-2xl` (16px)** — one radius family
for the widget card (`ChartSection`), its skeleton/error placeholders (they must match the loaded
card, CLS), the feed section shell + its sticky header, the detail overlay (`DetailShell`) and the
post-detail modals. Pill controls and icon buttons are `rounded-full`. Transient floaters — ⋯ menus,
popovers, pickers, listbox popups (`PillSelect`) and dialogs — sit one step tighter at **`rounded-xl`
(12px)** so they read as chrome, not cards; tooltips stay tight (`rounded`/`rounded-md`). The full
radius ladder: cards/overlays 16 → floating chrome 12 → inputs/controls 4 → pills full.

## Border / hairline opacity

Hairlines are `--border`. Soft over-surface tints use a small, deliberate opacity set rather than
arbitrary values: `foreground / 0.06` (hover wash), `ink3 / 0.25` (edit-mode card edge),
`white / 0.06` (dark card edge). Keep to these; don't invent new alphas per component.

## Icon buttons

Header affordances (expand / menu / remove) share **one** quiet circular shape: `rounded-full` + hover
surface, sized `h-11 w-11` (44px touch target) on mobile and the quieter `h-7 w-7` (28px) at ≥sm where a
cursor is precise. See the `iconBtn` string in `ChartWidget.tsx`.

**Touch targets.** On mobile every primary control clears **44px** — icon buttons, shared tabs and the per-widget
period filter pills grow their hit area below `sm` (the compact desktop look returns at ≥sm). Gated by
the mandatory phone CI job through `e2e/mobile-nav.spec.ts` at 360 / 390 / 430px (also asserts no horizontal page scroll). Inline text
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

Depth is primarily **hairlines + z-index**, so the stack order must be explicit. The small,
centrally-defined card/tooltip shadows do not determine stacking and must not be copied into new
one-off elevation values.
The floating/overlay layer pulls from **one** named ladder (`--z-index-*` in the `@theme` block) — never
hand-pick a raw `z-40`/`z-50` for an overlay. Plain in-flow stacking *inside* a single component (a
`relative z-10` label over its own fill) stays untokenised; the scale governs cross-surface overlays.

| Token | Value | Layer |
|---|---|---|
| `z-sticky` | 20 | in-flow sticky chrome — topbar, page/section headers |
| `z-nav` | 30 | fixed app navigation — sidebar, mobile bottom nav |
| `z-popover` | 40 | transient triggers over content — ⋯ menus, dropdowns, reorder pill |
| `z-modal` | 50 | full overlays + their scrim — detail, dialogs, drawers, command palette |
| `z-modal-popover` | 55 | portalled dropdown opened by a control inside the active modal |
| `z-toast` | 60 | notifications above modals (reserved) |
| `z-tooltip` | 70 | always-on-top hints (`InfoTooltip`) — must show even inside a modal |

Rules:
- **Portal strategy.** Full overlays (modals, drawers, command palette, tooltips) render into
  `document.body` via `createPortal`, so no ancestor's `overflow`/`transform` stacking context can clip
  or trap them; the token only orders them against each other.
- **Nested overlays** follow the ladder: a page menu (`z-popover`) opens above sticky chrome; a dialog
  (`z-modal`) covers page menus; only a dropdown owned by that active dialog may use
  `z-modal-popover`; a tooltip (`z-tooltip`) stays legible even over a dialog. A page menu must never
  out-rank a dialog.
- **Sticky < nav**: a scrolled sticky header slides *under* the fixed rail, never over it.
- Escape / outside-click dismissal is owned by the shared Radix Dialog layer (including advanced
  `DialogSurface` sheets); the z-scale governs paint order only, not closing.

## Motion

The house easing, chart-parity easing and a small duration ladder are defined once in
`src/index.css` `:root` (theme-agnostic). UI motion pulls from these; components must not inline a
duration/easing.

| Token | Value | Use |
|---|---|---|
| `--ease-standard` | `cubic-bezier(0.23, 1, 0.32, 1)` | the house entrance / settle **strong** ease-out. Both control points ride the ceiling, so ~90% of the distance is covered in the first third of the duration and the rest is settle. Perceived speed is set by that first third, not by the total — which is why the previous half-strength `cubic-bezier(0.2, 0.7, 0.3, 1)` read as hesitation at the same durations |
| `--ease-exit` | `cubic-bezier(0.68, 0, 0.77, 0)` | the house curve **mirrored** — exits accelerate away instead of settling. An element leaving should not decelerate into its own disappearance; ease-out on an exit reads as hesitation |
| `--ease-chart-morph` | `cubic-bezier(0.25, 0.1, 0.25, 1)` | Recharts `ease` parity for point-to-point chart updates |
| `--motion-track` | 100ms | smoothing for a transform the JS rewrites every pointermove frame (dock magnification on Connect) — **not** a general «fast» rung |
| `--motion-exit` | 120ms | overlay **dismissal**, ~0.8× the 150ms enter. `--ease-exit` gave exits an accelerating curve, but every overlay still left over exactly as many milliseconds as it took to arrive — so a dismissal had to be waited out. An entrance may take its time (it carries new content); a thing the user has decided to be rid of should be gone before it is missed |
| `--motion-press` | 140ms | tactile press feedback (button dip) |
| `--motion-fast` | 200ms | quick opacity / colour fades |
| `--motion-base` | 240ms | standard control transition (mode swap · icon · hover→active) |
| `--motion-glide` | 260ms | FLIP reorder glide · icon stroke draw-on |
| `--motion-reveal` | 300ms | larger reveals (add-widget rise) |
| `--motion-entrance` | 300ms | card mount rise (was 350ms — over both the <300ms UI ceiling and the playbook's 200-300ms band for entering elements). Shares a value with `--motion-reveal` but stays a separate rung: mounting a card and revealing a panel are different intents and will drift apart again |
| `--motion-morph` | 700ms | point interpolation after a data-window change (see note below). **Deliberately above the <300ms UI ceiling** — that ceiling governs *interface* motion, where the animation sits between the user and their goal. A shape morph is *explanatory*: the movement itself carries the comparison («this is the same series, re-windowed»), so it is read rather than waited out. Cutting it to 300ms turns the reading into a flicker. Interruptibility is what keeps it honest — a signature change mid-flight retargets from the currently visible values instead of restarting, so rapid period-flipping never queues a backlog of animation |

### Reaching the ladder from a component

The ladder used to be unreachable from a Tailwind class: `duration-[var(--motion-base)]` is an
arbitrary value (lint hard-fails it), so the only way out was to re-type the number as
`duration-300`. That is why off-ladder durations kept reappearing. One utility per rung now closes
the gap — defined in `src/index.css`, enforced by `scripts/design-motion-lint.mjs`:

| Utility | Sets | Rung |
|---|---|---|
| `dur-track` · `dur-press` · `dur-fast` · `dur-base` · `dur-reveal` | `transition-duration` | the matching `--motion-*` |
| `anim-dur-fast` | `animation-duration` | `--motion-fast` (tailwindcss-animate enter/exit on dialogs) |
| `anim-dur-exit` | `animation-duration` | `--motion-exit` — pair with `data-[state=closed]:`. Animation-duration, not transition-duration: the Radix overlays leave through tailwindcss-animate keyframes, which `dur-*` cannot reach |
| `ease-house` | `transition-timing-function` + `animation-timing-function` | `--ease-standard` |
| `ease-exit` | same two properties | `--ease-exit` — reach for it on a close/leave state (`data-[state=closed]:ease-exit`) |

Duration and *animation*-duration stay on separate utilities on purpose: a component may transition
on a token beat while running an unrelated ambient keyframe (`ui/progress.tsx` pairs `dur-reveal`
with `animate-pulse`; one merged class would drive the pulse at 300ms).

**Numeric `duration-{100,200,300}` and bare `ease-out` / `ease-in-out` are no longer accepted** in
`.ts`/`.tsx` — they re-type a number that already has a token, and the lint fails on them
(`raw-duration-util` / `raw-ease-util`). `duration-0` stays allowed: it is the «disable this»
idiom (`motion-reduce:duration-0`), not a timing choice. `index.css` is exempt from these two rules —
it is where the ladder and the allow-listed bespoke illustration loops (cartograph / connect /
starfield / jiggle) legitimately hold raw values. Arbitrary `duration-[…]` / `ease-[…]` / `delay-[…]`
remain banned everywhere.

**`transition-all` is banned** (`transition-all` rule): it sweeps layout-triggering properties
(width / height / padding) into the tween, which drops frames when the main thread is busy.
Enumerate instead — `transition-[width]`, `transition-transform`, `transition-colors`. Where a width
tween genuinely IS the effect (the variant dots in `EditWidgetDialog`), name it explicitly so the
layout cost is a visible decision rather than a side effect.

CSS custom props resolve inside inline `style.transition` too, so JS-driven transitions use
`var(--motion-glide) var(--ease-standard)` (see the reorder FLIP in `ChartWidget.tsx`).

**The six `layout-anim-ok` sites were re-audited (2026-08-11) and all six stand.** The tempting one
is `.sidebar-actions`, which tweens `height` and `margin-inline` — but neither converts to a
transform. The height goes `1.75rem → 3.75rem` because the rail STACKS the two actions, and that
height is what reserves the space the source card below moves into; a transform would slide the
actions over it and leave a hole. The `margin-inline` step positions the well so both actions land
on the 32px rail axis, and the toggle is anchored to the well's right EDGE — translating the
container would drag it off the panel edge it exists to track. Decisive point: the parent
`.sidebar-shell` tweens `width` in the same beat, which is irreducible for a rail that pushes rather
than overlays, so the frame does a full layout pass regardless. Converting the smaller half buys
nothing measurable. Don't re-raise this without a profile showing otherwise.

**Chart motion.** The full-size `LineChart` (primary line + area, comparison line) and shared `Sparkline`
follow the shadcn/Recharts update model: after a period or filter change, old point coordinates are
proportionally matched to the new point count and interpolated into the target shape. This is a real
**shape morph**, not a clip wipe or cross-fade. Isolated `MorphingSeries` / `SparklineSeries` layers own
the RAF loops, so axes, labels, card content and interaction overlays stay anchored. A stable data
signature starts the morph only for real series changes; hover, tooltip movement, value-identical
refetches and width-only resizes do not restart it. Rapid changes continue from the currently displayed
geometry. Nulls in the full chart remain honest gaps and never create an interpolated bridge. The dashed
comparison ghost keeps its pattern because point geometry changes without touching `stroke-dasharray`.
Period-backed comparison surfaces retain the previous query result as placeholder data only for the
same source, so a loading skeleton cannot unmount the old SVG before the morph starts; source changes
still clear immediately and never flash another channel's metrics.

**Why 700ms and not Recharts' 1500ms.** The morph is not a one-off delight animation: it fires on
*every* period switch, source switch and filter change — a «десятки раз в день» operation. At 1500ms
the reader waited a second and a half before the numbers stopped moving enough to be read, which
inverts the point of the chart. 700ms still reads as a continuous shape flow (the thing the morph
exists to communicate — these are the same series in a new window, not a new chart) while landing
inside the register the rest of the ladder lives in. The JS fallback in `lib/chartMotionRuntime.ts`
mirrors this number and must be changed with it — a RAF loop cannot read the CSS var mid-frame.

Other micro-charts (`InlineSpark` / the custom `MsMultiLine`) keep the lighter `reveal` fade
(`chart-fade-in`, `--motion-reveal`); bars grow from the baseline (`grow` — `scaleY` from a `fill-box`
bottom origin) + fade. The LineChart and Sparkline `data-chart-motion="morph"` CSS hook is mount-only;
data updates reuse the same node and run point interpolation over `--motion-morph`.
The update duration and easing intentionally match the shadcn example's unoverridden Recharts Area
defaults (`1500ms`, `ease`); the shorter house settle curve made most movement land too early.
The shared `ChartTooltip` fades in and glides between points via a tokenised
`transform` transition (`--motion-base`, never `left`/`top`) — one `[data-chart-tooltip]` rule owns it
for default/rhea/comparison alike.

**A pressable control dips while held.** The shared `Button` carries `active:scale-[0.97]` over
`--motion-press` on its five SURFACE variants; `link` is text and does not depress. A control that
reacts to the finger feels connected to it, while one that only changes colour on release reads as a
picture of a button. Under `prefers-reduced-motion` the dip is dropped outright
(`motion-reduce:active:scale-100`) rather than left to the global 0.01ms net, which would turn it into
a teleport — the reduced-motion rule is «keep the colour half, drop the transform half», the same split
as the hover gate below. Disabled buttons never reach `:active` (`disabled:pointer-events-none`).
Bespoke controls that predate this (`edit-toggle`, `add-widget-trigger`, `report-control`) keep their
own `scale(0.98)` — same band, and they are not `Button` instances.
Gated by `e2e/press-and-exit.spec.ts`, which measures computed `scale` under a held pointer: a
class-name assertion would pass even if the rule lost a specificity tie.

**Exits are shorter than entrances.** Every `data-[state=closed]` overlay carries
`anim-dur-exit` alongside `ease-exit`, so it leaves in 120ms against the 150ms it took to arrive.
Applied to all eight animated surfaces (dialog, alert-dialog, dropdown, context-menu, select,
popover, tooltip, hover-card). The `data-*` variant compiles to an attribute selector, so the exit
duration outranks a plain `anim-dur-fast` on the same element without `!important`.

**Hover motion needs a real pointer.** A `:hover` rule that moves something must be gated to
`@media (hover: hover) and (pointer: fine)`: on a touch screen the browser leaves a synthetic hover on
the last-tapped element, so the transform sticks there until something else is tapped. Hand-written CSS
writes the media query directly (see the sidebar toggle glyph / tooltip); Tailwind utilities use the
**`hover-fine:` / `group-hover-fine:`** variants declared at the top of `index.css`. This covers motion
ONLY — colour and ink hovers keep the plain `hover:` variant, whose v3-parity override stays in place
for the staged phone migration, because a stuck tint is invisible. Same split as reduced motion: keep
the opacity/colour half, drop the transform half. An affordance whose *reveal* is the opacity change
(the IG row chevron) gates only its slide, so touch still gets the hint.

**Reduced motion.** A global safety net in `index.css` collapses every animation/transition to 0.01ms
under `prefers-reduced-motion: reduce`, so token-driven rules never need a per-rule guard. Infinite
loops (reorder jiggle, starfield twinkle) and readability-critical reveals additionally carry explicit
`animation: none`. JS motion gates in-component: the landing's count/typewriter loop and
`MorphingSeries` both check the media query and render the final state without scheduling RAF work.

**Desktop sidebar.** The persistent column remains layout-pushing in both modes (`240px` expanded,
`64px` rail). Both directions share **one edge-led beat** — `--motion-reveal` on the width, the
outer-edge toggle transform, and the copy masks alike — so the surface moves as a single 300ms
gesture (the reference's single sidebar transform) rather than an asymmetric collapse/expand pair. No
staged copy delay: labels ride the same beat instead of lagging a disconnected edge. Icons and avatars
occupy a fixed `40px` first track centred on the rail axis; only the second-track copy is
masked/faded/translated. The global reduced-motion net collapses the duration to ~0, and since no rule
carries a transition-delay the mode switch is immediate.

**The frequency sweep beyond Ctrl+B (2026-08-11) came back clean.** Every control a user touches
dozens of times a day was checked for MOTION, not for animation in general — colour is exempt, since
a tint that lingers costs nothing and reads as nothing. The per-widget period pills carry no
transition at all. Sidebar nav rows, the panel toggle and the source switcher rows carry
`transition-colors` only. The single piece of motion on a high-frequency control is the tab glider,
and it stays: the movement IS the mode indicator, which is a stated reason to animate rather than a
decoration. `Ctrl+B` was the one real violation and it was fixed in #434. Re-run this sweep when a
new frequent control ships — the question is «does it MOVE», not «does it transition».

**Rapid re-open does not restart a keyframe mid-flight (measured 2026-08-11).** The concern was that
`animate-in` / `animate-out` are keyframes, which resume from 0% instead of picking up where they
were. Frame sampling on the account dropdown: the exit falls monotonically 1.00 → 0.00 over ~95ms,
the node UNMOUNTS, and a re-open is a fresh mount fading in from zero. Radix does not hand the same
node back mid-exit, so there is no backwards jump to see and no reason to convert these to
transitions.

**Frequency gate: the keyboard path does not animate.** `Ctrl+B` snaps the sidebar to its new width;
only the pointer toggle plays the 300ms gesture. A shortcut is used dozens of times a day by whoever
learned it, and at that frequency an animation stops reading as polish and becomes latency the user
waits out — the same reasoning that keeps motion off any other high-frequency, keyboard-initiated
action. `Sidebar.tsx` writes `data-instant` on the shell for exactly the one commit that changes the
width and clears it on the next painted frame; the `.sidebar-shell[data-instant]` rule zeroes the
duration for that frame only. Gated by `e2e/smoke.spec.ts` («Ctrl+B snaps the sidebar…»), which also
asserts the pointer path is still mid-flight two frames in.

The **toggle** rides the sidebar's moving outer edge — pinned to the panel's right edge when open,
sliding back onto the `32px` rail axis as it collapses (Search holds the left axis, dropping below the
toggle in the rail). Its glyph is an original morph: a quiet panel outline + divider at rest that, on
`:hover`/`:focus-visible`, fades the divider and reveals a directional chevron (`‹` hide when open,
`›` reveal in the rail) over `--motion-fast`. A compact CSS-only tooltip (a pointer-events-none layer
to the right, `role="tooltip"` + `aria-describedby`, no native `title`) opens on the same hover/focus
carrying the Russian label and discrete `Ctrl`/`B` key chips.

**Bespoke (not canon).** Illustration loops keep their own timings on purpose and are allow-listed by
the lint: cartograph (error/404/empty), the `/connect` orbital hub + starfield, and the reorder jiggle.
The public landing's CSS-native entrance/draw/bob choreography is its own system.

**Overlays & mobile sheets.** Dialogs are borders-only (no shadow): a `bg-background/70` backdrop fades
in (`.detail-backdrop-in`, `--motion-press`) while the panel appears. On mobile the card **detail**
(`DetailShell` `panel`) drops its inset to a full-height, edge-to-edge sheet (`p-0 sm:p-4`,
`rounded-none sm:rounded`), and the **source switcher** opens as a bottom sheet that slides up
(`.sheet-in`, `--motion-reveal`) — both portal-rendered above the bottom nav, focus-managed
by the shared Radix Dialog layer, Escape/backdrop-dismissable, and bottom-padded with `env(safe-area-inset-bottom)` so
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
- `npm run lint:motion` (`node scripts/design-motion-lint.mjs`) — **gated in CI** (the `frontend` job,
  ahead of the suite). Hard-fails on an inlined house easing, magic `text-[Npx]`, arbitrary
  `duration-[…]/ease-[…]/delay-[…]`, off-ladder `duration-300`/`ease-out`, `transition-all`,
  arbitrary `z-[N]`, or a transition on a layout-triggering property. The public marketing landing
  (`pages/Landing.tsx`, its own CSS-native motion system) and `pages/Legal.tsx` (long-form prose) are exempt
  from the **type-scale** rule only — the motion rules apply everywhere. Migrating those two
  surfaces onto the scale is a separate, deliberate task.

### Animating layout on purpose

`layout-animating-transition` flags a transition on width / height / padding / margin / inset / gap:
the browser re-lays-out every frame, which drops frames as soon as the main thread is busy. It is a
gate with an escape hatch, not a ban — write `layout-anim-ok: <why>` inside the CSS rule block and
the rule stands down for that block only (the marker is scoped by the enclosing `{`, so a note on
one rule cannot quietly excuse the next).

Three surfaces hold that marker today, all for the same reason — **the reflow is the effect**:

| Block | Why a transform will not do |
|---|---|
| `.sidebar-shell` and its children | The rail *pushes* the page instead of overlaying it; a transform would slide the panel over the content and leave a gap where the board should have grown |
| `@utility edit-toggle` | A 36 → 108px chip inside a fixed slot; `scaleX` would smear the rounded caps and the glyph |
| `.home-board-canvas` | Edit mode narrows the board so cards re-flow into it — scaling a grid of charts is exactly the wrong outcome |

Anything new that wants the marker should be able to fill in that third column.
