# Atlavue — Design & Analytics Overhaul

Working tracker for the design-craft overhaul + analytics feature roadmap, from the
2026-07-01 multi-agent design audit (65 design findings + 57 competitive gaps) cross-checked
against live-render measurements (demo mode).

**How to use:** work top-down by sprint. Each item has a file ref + concrete fix. Check off as
you go. Design sprints (D*) are pure craft (no new functionality → fastest visible lift). Feature
sprints (F*) add analytics capability. Do **D1 first** (systemic, highest ROI), then D2–D4, then
features.

**Design system = "Atlavue Refined Technical" (light-first):** warm-paper canvas (`#faf9f6`), warm
ink scale, HAIRLINES not card-chrome, ONE calm blue accent (`#2d6be0`) for links/active/brand only,
radius 4px (buttons pill), mono font ONLY for timestamps/collector/API values, brand colors
(TG `#229ED9` / IG `#E1306C`) only in tiny markers. Tokens: `frontend/src/index.css`.

### What the audit says we already do RIGHT (preserve — don't regress)
- Strict 2 font weights (400/500); the "one blue" rule genuinely holds; ~zero box-shadows
  (hairlines + z-index for depth) — a rare "designed, not generated" signal.
- Overview screens are curated (not a chart-dump); chart data colors are single-hue.
- Keep: no-shadow/borders-only depth, the lean stroke-only icon set — **document these as
  intentional** so future work doesn't "helpfully" add shadows/emoji.

### Overall verdict
More disciplined than a typical AI dashboard, but undermined by 3 systemic issues: (1) type-scale
sprawl, (2) the app violating its **own** "hairlines-not-cards" principle, (3) the Analytics page
being a "wall of 20 charts". D1 + D4 fix the bulk of the "looks templated" feeling.

---

## Sprint map

| Sprint | Theme | Nature | Rough size |
|--------|-------|--------|-----------|
| **D1** | Design-system foundation (type scale, radius, hairlines-not-cards, token governance) | craft, systemic | M |
| **D2** | Per-screen polish (Overview / Posts / Mentions / IG / Settings / Auth / Landing / Connect) | craft | L |
| **D3** | Chart craft (tooltips, crosshair, gridlines, number/delta formatting, palette a11y) | craft | M |
| **D4** | Analytics restructure — break the 20-chart wall into grouped, progressive sections | craft + IA | M |
| **F1** | Analytics features · batch 1 (annotations, ghost overlay, format breakdown, engagement mix) | feature | M–L |
| **F2** | Analytics features · batch 2 (crosshair+brush+drill, anomaly markers, leaderboard, saved views) | feature | L |
| **F3** | Reporting & sharing (PNG/PDF export, scheduled reports, embed/share) | feature | M–L |
| **A11y** | Accessibility & motion (keyboard/ARIA charts, reduced-motion, focus, table fallback, locale dates) | craft | M |
| **Backlog** | Evaluate-later features (competitor overlay, ML, ROI attribution, cohort/retention, …) | — | — |

---

## Sprint D1 — Design-system foundation
*Systemic craft. Highest ROI: fixes the biggest "AI/template" tells app-wide. Do first.*

**Goal / acceptance:** no `text-[Npx]` magic sizes; one radius language (4px + pill); Card reserved
for forms/modals/floating; skeletons match final layout; status colors documented as tokens.

### D1.1 Type scale (the #1 tell — 9 sizes measured on one screen)
- [ ] Define a disciplined scale (~6 steps), e.g. `xs 11 · sm 12/13 · base 14 · lg 16 · display 24 · hero 44`; add to Tailwind config or an index.css comment as the canonical scale.
- [ ] Global sweep: replace every `text-[Npx]` with a scale token. Grep `text-\[` across `frontend/src`.
- [ ] `panels/Digest.tsx:108` `text-[13px]`→`text-xs`; `:113` `text-[15px]`→`text-sm`.
- [ ] `panels/Overview.tsx:105` SubscriberGrowth hero `text-3xl`→`text-[44px]` to match Views hero (`panels/KpiGrid.tsx:256`). Both heroes = 44px.
- [ ] Data-health / SourceStatus / KPI rows: kill inline `text-[13px]`/`text-[10px]`; map to scale (reserve 10px for timestamps/metadata only).
- [ ] `panels/TgAnalytics.tsx` KPI subtitles (`text-[10px]`): add `leading-tight` so descenders don't collide (or bump to 11px).

### D1.2 Radius — one language (4px panels, pill buttons)
- [ ] `components/ui/card.tsx` Card: `rounded-lg` (8px) → `rounded` (4px). (Verify Tailwind `rounded` maps to `--radius: 0.25rem`.)
- [ ] Instagram panels/components: replace all `rounded-lg` → `rounded` (Layout.tsx, IgOverview, IgAnalytics, IgPostCard, section wrappers).
- [ ] `components/Breakdown.tsx:35` `rounded-md` (6px) → `rounded`.
- [ ] `IgConnectPanel` (`components/instagram/health.tsx:125`) accent button `rounded-lg` → `.btn-pill`.
- [ ] Consolidate pill usage: DeltaPill / status pills use `.btn-pill` (or a `rounded-pill` util) as single source, not raw `rounded-full`.

### D1.3 Hairlines, not cards (the app violates its own principle — ~288 Card usages)
- [ ] **Skeletons must match final layout.** `panels/KpiGrid.tsx:357–378` KpiSkeletons use Card+gap-4; real render is hairline ledger (gap-px). Rebuild skeleton as `grid gap-px border-t border-border bg-border` cells on `bg-background` (kills the "system swap on load" flash).
- [ ] `panels/TgAnalytics.tsx:241` — KPI grid wrapped in `rounded-lg border bg-border` card box → remove wrapper, let the `gap-px` grid sit open on paper.
- [ ] `panels/TgAnalytics.tsx:409–420` drill-down KPI Cards → hairline grid.
- [ ] `components/instagram/content.tsx` IgPostCard: drop Card wrapper → `border-t border-border pt-4` rows; move rank/type badges into a header row (no positioned overlays).
- [ ] Remove decorative tint fills (border-only): DemoBanner (`DashboardLayout`), Settings/destructive cards → `border-*/30` only, no `bg-*/[0.04]`.
- [ ] `pages/Landing.tsx` CtaBand `bg-blue-tint` (a data-viz status token) → `bg-primary/[0.04]` (don't hijack the status palette for marketing).
- [ ] Follow-up audit: reserve `Card` for forms (Settings), modals (KpiDrillDown/PostModal), floating (popovers). Everything tabular/grid → `gap-px` hairline pattern.

### D1.4 Token governance (colors, gradients, spacing)
- [ ] Make status colors explicit tokens: add `@layer utilities` exporting `.text-verdant`/`.text-ember`/`.text-status-warn` = `hsl(var(--brand-*))`; stop scattering naked class names / inline hsl in InsightCell dots (`panels/Insights.tsx`), PctTag (`panels/Posts.tsx`), DataHealth.
- [ ] Story expiry warning `text-ember` → `text-status-warn` (amber caution, not red alert) — `components/instagram/content.tsx:352`.
- [ ] Document chart gradient opacity scale in index.css (peak 1 / mid 0.55 / fade 0), optionally as `--chart-gradient-*` vars.
- [ ] Spacing: adopt an 8px-baseline scale (4/8/12/16/24); fix cramped rhythms (Digest sections `border-t pt-4`→`mt-3 border-t pt-3`; Settings `space-y-8`→`space-y-6`).
- [ ] **Document as intentional (no code):** zero-shadow borders-only depth; lean stroke-only icon set.

---

## Sprint D2 — Per-screen polish
*Every remaining per-screen finding. Group the work by screen.*

### Overview / TG
- [ ] TopPosts empty state → 3-part (heading + reason + link to /analytics) instead of bare text (`panels/TopPosts.tsx:74`).
- [ ] Metric hierarchy in TopPosts/Posts: primary (Просмотры) dark/semibold, secondary muted, derived (ER) dimmest.

### Posts / Mentions
- [ ] Posts row hover: drop `group-hover:text-primary` (`Posts.tsx:102`) — let the row-bg shift carry the affordance (no double shout).
- [ ] Album badge → inline text `· N фото` (drop the categorical `bg-secondary` pill) (`Posts.tsx:108`).
- [ ] Posts mobile: replace 8-col horizontal-scroll table with a card list < md (reuse `TopPosts.tsx:93–191` pattern).
- [ ] PostModal stat boxes `rounded-lg bg-muted/40` → `rounded border border-border bg-background`; reason "badge" → plain `text-verdant` statement (no pill).
- [ ] Mentions KPI hierarchy (Упоминаний primary / Каналов secondary / Охват tertiary).
- [ ] Mentions empty state: solid hairline (not `border-dashed`); quota meter → a SourceStatus-style badge above charts (not a footnote).
- [ ] Mentions section titles → hairline-above label (`border-t pt-4`), not full-width flex divider; BarChart x-labels: rotate/thin on mobile (14 dates overlap).

### Instagram (parity pass)
- [ ] IG post cards: drop Card chrome (see D1.3); sort buttons → small pill toggles (not `rounded-lg px-3 py-1.5`).
- [ ] `font-mono` ONLY for timestamps — remove from media_type/type labels (`content.tsx:87,368`).
- [ ] Reels KPI grid → 2-mobile/4-desktop to align with other KPI blocks.
- [ ] Tags card: make whole card a link (native `<a>`), add hover underline on @username.
- [ ] DataHealth rows: label small (`text-xs`), value `text-sm font-mono` (currently inverted) (`health.tsx:23`).
- [ ] Insights: single-insight (Overview) → plain text+evidence, no grid; grid only for limit>1 (`insights.tsx`).
- [ ] BestTimeHeatmap responsive: `min-w-full lg:min-w-[440px]` + mobile fallback (`audience.tsx`).
- [ ] Empty states → hairline sections (not Cards) across health/content/insights.

### Settings / Auth / Landing / Connect / GetStarted
- [ ] Settings: `space-y-8`→`space-y-6`; section intro headings read as ledger breaks not form labels; `Подключённые каналы` gets a hairline-above; empty state = hairline box (not dashed+fill).
- [ ] Settings ChannelKeysPanel: replace `⚠️` emoji with an inline SVG alert icon.
- [ ] Auth: AtlavueMark `h-[18px]`→`h-5 w-5` (brand feels too small vs 24px title); normalize the 3 Trust icons to uniform `strokeWidth=1.5 h-4 w-4` + `aria-label`.
- [ ] Landing: **decide on HeroAurora** (3 radial-gradient peach/pink/blue glows read as generic-SaaS vs our warm-paper+hairline — flatten or keep as a deliberate hero exception; owner call). Hero mock: responsive grid + `clamp()` sizes so it doesn't overflow at 390px. Pillars: symmetric column padding.
- [ ] Connect: `font-mono` on the CodeBlock `<pre>` itself; Step badge → `bg-primary/10 text-primary` (subtle) + bump step title to `text-base`.
- [ ] GetStarted BloomArt: monochrome strokes (border) + single accent bloom (drop `text-ink3` on decorative strokes).

### Emoji-as-icons purge (AI-tell)
- [ ] Remove 😊😐😠 (sentiment), ❤️↗️💬 (engagement), ➕➖ (churn) from `panels/TgAnalytics.tsx` + `panels/Insights.tsx` → color dots (Breakdown coding) + text.
- [ ] (Single flavor-emoji in a true empty state is acceptable; decoration emoji in data views is not.)

### Empty-state pattern (make one, use everywhere)
- [ ] Standard: `rounded border border-dashed bg-background py-8 text-center` + heading + reason + optional action link. Apply to CollectorEmptyState, TgAnalytics no-data, Bugs/Admin empty, Mentions.

---

## Sprint D3 — Chart craft
*What separates premium charts from generic ones.*

- [ ] **Tooltips → paper palette + crosshair.** Replace `bg-popover` tooltip with `bg-background/95` + hairline; add a snap-to-nearest crosshair guide; multi-series stacked/tabular layout with formatted deltas. (`LineChart`/`BarChart`.)
- [ ] Heatmap "best slot": replace inline `border:2px solid hsl(--brand-verdant)` with a token util (`border-2 border-verdant` conditional), base cells stay 1px `--border` (`panels/Charts.tsx:213`).
- [ ] Gridline/axis restraint: thin low-opacity gridlines (20–30%), ticks snapped to meaningful intervals (hourly/daily/weekly), labels optically aligned (Tufte data-ink).
- [ ] Number/delta formatting pass: locale-aware, abbreviate (1.2M), 1-decimal %, **tabular figures** in tables, consistent `↑/↓` + color + period on deltas. Centralize in `lib/format`.
- [ ] Categorical palette a11y: audit `--chart-1..6` for colorblind-safety (Okabe-Ito / Tol / Tableau-10), never color-alone; sequential scales perceptually uniform (Viridis-like) for heatmaps.
- [ ] Chart empty/loading: layout-aware skeletons (not spinners); per-chart empty states.
- [ ] ExpandableChart close button: pair `×` with `rounded-full hover:bg-muted` or a text glyph in the UI font (`panels/Charts.tsx`).

---

## Sprint D4 — Analytics restructure (break the 20-chart wall)
*The single biggest structural issue: `/analytics` stacks ~20 chart blocks with no hierarchy.*

- [ ] Regroup the 20 sections into 3–4 tabs/anchored groups: **Динамика** (views/subs/velocity/history), **Аудитория** (sources/languages/sentiment/geo/best-time), **Контент** (formats/hashtags/top-posts), **Сравнение** (period-vs-period).
- [ ] Lead each group with the 2–3 charts that matter; the rest behind "показать все" / drill.
- [ ] Wrap the Compare "Период vs предыдущий" table in a `ChartSection` (title + hairline rhythm) (`panels/Compare.tsx:166`).
- [ ] Consistent section rhythm across the whole page (hairline-above headings, 8px scale).

---

## Sprint F1 — Analytics features · batch 1
- [ ] **Timeline annotations / event markers** — mark campaigns/launches/algorithm-changes on charts to explain spikes. Store per-channel; toggle; tag-filter. *(fits "insight→action" ethos; Mixpanel/GA standard.)*
- [ ] **Ghost previous-period overlay on the charts themselves** (faded prior period), not just the Compare table. *(partial: TG had a ghost-overlay experiment; make it a first-class, everywhere toggle.)*
- [ ] **Content breakdown by format/type** aggregated (IG Reels/Stories/Posts; TG text/media) — which formats drive engagement. *(per-post exists; add aggregate + comparison.)*
- [ ] **Engagement composition over time** (likes/comments/shares/saves as a stacked trend) — quality of interaction, not just totals.

## Sprint F2 — Analytics features · batch 2
- [ ] **Interactive charts standardized:** crosshair tooltip (F0 above) + **brush-to-zoom** (drag to zoom a range) + **click-to-drill** with breadcrumbs (generalize the existing KpiDrillDown across chart types).
- [ ] **Anomaly / trend markers on charts** — flag statistically unusual spikes/drops (rolling baseline, >2–3σ) with an in-chart marker + "почему" tie-in to auto-insights. *(builds on tgInsights/igInsights.)*
- [ ] **Post leaderboard** — ranked, sortable-by-any-metric list (generalize TopPosts).
- [ ] **Saved views / presets** — named dashboard configs ("Обзор для руководителя / Контент / Конкуренты"). *(partial: per-user layout prefs exist — extend to named, switchable views.)*

## Sprint F3 — Reporting & sharing
- [ ] **Export PNG + PDF** (chart→PNG preserving fonts/colors; dashboard→paginated PDF) on top of existing CSV (`lib/igExport`, `downloadCsv`).
- [ ] **Scheduled reports** — recurring (daily/weekly/monthly) email/Slack delivery; recipient list; template.
- [ ] **Embed / share link** — read-only public snapshot of a chart/dashboard (password-optional).

## Sprint A11y — Accessibility & motion
- [ ] Keyboard nav + ARIA on interactive charts (tab through points, arrow keys, `aria-label`/`aria-live`); visible focus outlines (2–3px, not color-only).
- [ ] `prefers-reduced-motion` audit for all transitions/hero motion; standard 100–300ms easing system.
- [ ] Chart data-table fallback (SVG + accessible `<table>` / CSV) for WCAG 1.1.1.
- [ ] Locale-aware date/time display (ISO for APIs, localized for UI, timezone indicator cross-region).
- [ ] Full interactive-state coverage (default/hover/active/disabled/focus) on all controls.

---

## Backlog — evaluate later (captured, not scheduled)
*Included for completeness ("берём всё"), but off the lean "technical-ledger" path — needs a
product decision, extra data, or heavy ML before committing.*
- Competitor benchmarking overlay (needs competitor data; mentions/gap-analysis is a partial start).
- Industry benchmark comparisons (needs anonymized aggregate data / partnerships).
- Predictive analytics / forecasting; ML-based anomaly detection (beyond simple statistical markers in F2).
- Multi-channel attribution & campaign ROI (needs downstream conversion tracking / UTM / external).
- Cohort & retention matrices, cohort side-by-side (product-analytics, not social — reassess fit).
- Real-time streaming / auto-refresh UI + staleness indicator.
- Cross-filtering (click a value → filter all charts); cascading dropdown filters (URL-persistent).
- One-click chart-type conversion.
- Collaborative team commenting / shared annotations.
- Data-sampling transparency & row-precision controls.
- Cross-post recommendation engine.
- Custom KPI / formula builder.
- Real-time engagement-spike push notifications.

---

*Source: multi-agent design audit + competitive research, 2026-07-01. 65 findings / 57 gaps.
Positive baselines (2 weights, one-blue, no-shadow) confirmed — preserve them.*
