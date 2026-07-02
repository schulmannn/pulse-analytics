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

### D1.1 Type scale (the #1 tell — 9 sizes measured on one screen) — ✅ DONE
Shipped scale (canonical, documented in `tailwind.config.js`): `2xs 11 · xs 12 · sm 14 · base 16 ·
lg 18 · 2xl 24 · 3xl 30 · hero 44` — 6 primary steps + 2 intermediates (lg, 3xl). Chose the
**low-shift** variant: keep Tailwind-native px, add only `2xs`(11) + `hero`(44), and fold every magic
`text-[Npx]` onto the nearest native step (mostly imperceptible +1px up). Preserves the tuned public
pages. Verified live (demo mode): `.text-hero`=44px, `.text-2xs`=11px, 0 console errors.
- [x] Disciplined scale defined + two tokens (`2xs`, `hero`) + canonical-scale comment added to `tailwind.config.js`.
- [x] Global sweep: 97 `text-[Npx]` → scale tokens across 29 files; **0 residual** magic sizes. `pages/Landing.tsx` **exempt** (its 7–11px are a scaled mock-dashboard preview — forcing an 11px floor breaks the miniature; handled in D2).
- [x] `panels/Digest.tsx:108` `text-[13px]`→`text-sm`; `:113` `text-[15px]`→`text-base` (folded **up** per the uniform rule — the :113 lead is a dominant element, so emphasis tier is correct).
- [x] `panels/Overview.tsx:105` SubscriberGrowth hero `text-3xl`→`text-hero` (44) to match Views hero (`panels/KpiGrid.tsx:256`, also `text-hero`). Both heroes = 44px — confirmed live.
- [x] Data-health / SourceStatus / KPI rows: inline `text-[13px]`/`text-[12px]`/`text-[10px]` mapped to scale (13→sm, 12→xs, 10/11→2xs). *(DataHealth label/value inversion is a D2 semantic fix, not a size remap.)*
- [x] `panels/TgAnalytics.tsx` KPI subtitles `text-[10px]`→`text-2xs` (11px): descender collision resolved by the token's paired `line-height:15px` (no separate `leading-tight` needed).

### D1.2 Radius — one language (4px panels, pill buttons) — ✅ DONE
**Config finding:** `tailwind.config.js` already overrides `borderRadius.lg` → `var(--radius)` = **4px**
(not Tailwind's default 8px). So `rounded-lg` and `rounded` render **identically** at 4px here — the
audit's "8px→4px" premise doesn't apply; the radius language was already visually at 4px. The only
*real* deviation was `rounded-md` (2px). Verified live: base `Card` now `rounded border bg-card`, 0 console errors.
- [x] `components/ui/card.tsx` Card `rounded-lg` → `rounded` (canonical base; `rounded` = `--radius` = 4px, confirmed).
- [x] `rounded-md` (2px) → `rounded` (4px) **app-wide** — 19 sites / 10 files (Settings, Mentions, Bugs buttons; ChartTooltip, InfoTooltip, SectionNav, skeleton, Connect, Breakdown). Kills every orphan 2px radius → everything is now 4px or pill.
- [x] `components/Breakdown.tsx:35` `rounded-md` → `rounded` (covered by the sweep above; was 2px here, not 6px).
- [x] `IgConnectPanel` (`components/instagram/health.tsx:125`) accent CTA `rounded-lg` → `.btn-pill` (matches the Export/Apply pill-CTA language).
- [x] **Decided — skip** `rounded-full`→`.btn-pill` consolidation: `.btn-pill` is button-named and the `rounded-full` sites are all legit circles/dots/avatars/progress-bars/status-chips — semantically correct as-is; converting is a visual no-op with a naming mismatch.
- [~] IG `rounded-lg` → `rounded` on ledger-box wrappers + sort toggles: **folded into D1.3/D2** (those sprints rewrite the `grid gap-px … bg-border` wrappers → hairline, and turn IG toggles → pill), so the naming unifies there as a byproduct instead of churning the same lines twice. Deferred (not skipped): modal `rounded-2xl` → D1.3 (Card/modal reservation); avatar `rounded-xl` = intentional soft-square (leave).

### D1.3 Hairlines, not cards (the app violates its own principle — ~288 Card usages) — 🚧 IN PROGRESS
- [x] **Skeletons must match final layout.** `panels/KpiGrid.tsx` `KpiSkeletons` rebuilt: was Card+gap-4; now mirrors the real render — hero block + `grid gap-px border-t border-border bg-border` ledger with `bg-background` cells. Kills the "card → ledger swap on load" flash.
- [x] `panels/TgAnalytics.tsx:241` — KPI grid boxed-ledger (`overflow-hidden rounded-lg border bg-border`) → **open ledger** (`border-t border-border bg-border` + `gap-px`). Verified live: border-top 1px only, no box border/radius; `bg-border` draws internal hairlines through the gaps.
- [~] Remove decorative tint fills (border-only): **DemoBanner** (`DashboardLayout`) + **Overview stale-data banner** done (dropped `bg-*/[0.04]`, kept border + text/dot color; `rounded-lg`→`rounded`). *Deferred to D2 (per-screen): Settings/Mentions destructive boxes, `instagram/Layout.tsx:62` ok/error notice — those are functional status feedback, handled with their screens.*
- [x] **Rolled the open-ledger to the sibling boxed-ledgers** — 10 sites / 8 files (`Admin:44`, `Insights:123/170`, `Mentions:133`, `instagram/IgAudience:33`, `instagram/IgAnalytics:110`, `instagram/content:124/354`, `instagram/insights:22`). ⚠️ Substring sweep over-reached into `DashboardLayout` `PlatformNav` (the Telegram/Instagram **switcher**) — caught via live inspect and **reverted to a bounded segmented control** (`overflow-hidden rounded border`), since a switcher needs the box, not an open ledger.
- [x] `panels/TgAnalytics.tsx:409–420` (the `TgAnalyticsSkeletons` Card grid) → hairline: rebuilt to mirror the open KPI ledger + flat chart-section skeletons.
- [~] `components/instagram/content.tsx` IgPostCard: **deferred to D2 IG pass** — it's a thumbnail-grid media card (image + overlaid rank/type badges); de-carding it to `border-t` rows is a grid→list restructure that needs live iteration, done cohesively with the rest of the IG polish.
- [~] `pages/Landing.tsx` CtaBand `bg-blue-tint` → `bg-primary/[0.04]` — **folded into the D2 Landing pass** (keep Landing chrome changes cohesive).
- [~] Follow-up Card-reservation audit: **remaining non-reserved `Card` usages = empty/error states** (KpiGrid:46, TgAnalytics:66, content.tsx ×6, Bugs, Settings) → these become the **D2 standard empty-state pattern** (`rounded border border-dashed`). Card stays reserved for forms/modals/popovers.

### D1.4 Token governance (colors, gradients, spacing) — ✅ DONE
- [x] Status colours: `.text-verdant`/`.text-ember`/`.text-status-warn` (+ `bg-*` tints) are **already generated** from `tailwind.config.js` colours — documented in `index.css` as the canonical status utilities. Raw `hsl(var(--brand-*))` is **legitimately** reserved for SVG chart paint (fills/strokes/gradients — CSS classes can't reach SVG). *(Hashtags lift color + heatmap best-slot border stay inline → D3 chart-craft.)*
- [x] Story-expiry warning `text-ember` → `text-status-warn` (amber caution, not red alert) — `components/instagram/content.tsx:352`.
- [x] Chart area-gradient opacity scale documented in `index.css` (peak 1 · mid 0.55 · fade 0).
- [x] Spacing: `Settings` `space-y-8` → `space-y-6`. *(Digest micro-rhythm + `Posts`/`instagram/Layout` `space-y-8` left as-is — subjective, shipped fine; revisit per-screen in D2 if it reads cramped.)*
- [x] **Documented as intentional** in `index.css`: zero-shadow borders-only depth + lean stroke-only icon set (so future work doesn't add shadows/emoji).

---

> **Sprint D1 — ✅ COMPLETE** (uncommitted). Foundation done: one type ladder (11–44, no magic px),
> one radius language (4px / pill), hairlines-not-cards (skeletons match, boxed→open ledgers,
> decorative tints removed), governed status tokens + documented intentional patterns. Verified
> live in demo mode; build + 81 tests green. Deferred into D2 (cohesive per-screen work): IgPostCard
> de-card, empty-state Card→hairline pattern, Landing CtaBand tint, Settings/Mentions destructive tints.

---

## Sprint D2 — Per-screen polish
*Every remaining per-screen finding. Group the work by screen.*

### Overview / TG
- [x] TopPosts empty state → 3-part `EmptyState` (heading + reason + link to /analytics) (`panels/TopPosts.tsx`).
- [x] Metric hierarchy in TopPosts cells: `COLUMN_TONE` — Просмотры `text-foreground` (primary) → Реакции/Репосты `text-ink2` → ER `text-ink3` (dimmest); active sort column gets a weight bump (affordance stays in the header arrow). *(Posts full table already had Просмотры-dark / secondary-muted; ERV/ER keep the meaningful PctTag colour-coding.)*

### Posts / Mentions
- [x] Posts row hover: dropped `group-hover:text-primary` — the `hover:bg-hover-row` row shift carries it.
- [x] Album badge → inline `· N фото` (dropped the `bg-secondary` pill).
- [x] Posts mobile: 8-col horizontal-scroll table → **card list < md** (reuses the TopPosts row shape). Verified: at 375px the table is `display:none`, the list shows.
- [x] PostModal (`Posts.tsx`) reaction stat boxes `border-border/20 bg-muted/40` → `border-border bg-background`; **`PostDetailModal`** reason pill → plain `text-verdant` statement (verified: not a pill) + its Stat boxes → `rounded border border-border bg-background` (7 hairline stat boxes, 0 muted).
- [x] Mentions KPI hierarchy — shade ramp Упоминаний `foreground` / Каналов `ink2` / Охват `ink3` (verified live: rgb 27→78→107).
- [x] Mentions empty state: `border-dashed` Card → **solid hairline** de-carded box; `MentionsSkeletons` rebuilt to the open-ledger scaffold (no card→ledger flash); removed unused `Card` import.
- [~] Deferred: Mentions quota meter → SourceStatus badge (minor); section titles → hairline-above → **D4** (needs to change all `ChartSection`s together for consistency); BarChart x-label rotate/thin on mobile → **D3** (chart-craft, BarChart component).

### Instagram (parity pass) — ✅ DONE
- [x] IgPostCard de-carded: dropped `Card` → `border-t` hairline cell; rank/type moved into a header row (no positioned image overlays); dropped the `bg-muted/10` stat tint + the `font-mono` on the type label. Verified live: 0 card wrappers, rank headers present.
- [x] Sort buttons → `.btn-pill` toggles (verified: border-radius 9999px). `font-mono` now timestamp-only (Tags/Stories timestamps keep it; type labels don't).
- [x] Tags card is a native `<a>` (already) + `group-hover:underline` on @username + `rounded`.
- [x] DataHealth rows: label `text-xs`, value `text-sm font-mono` (fixed the inversion).
- [x] IG Insights: single insight → plain analyst note (no grid chrome); 2+ → hairline ledger. Empty → `EmptyState`.
- [x] BestTimeHeatmap responsive: `min-w-full lg:min-w-[440px]` (verified live).
- [x] Empty states → `EmptyState` across content (6) + insights; health has none.
- [~] **Skipped:** Reels KPI grid 2-mobile — 3 KPIs don't tile cleanly into 2/4 cols (an empty half-cell); left `grid-cols-1 sm:grid-cols-3`. **Side effect noted:** removing `Breakdown.icon` dropped the country-flag emoji + contact-type emoji (audience/IgAudience) — consistent with no-emoji-in-data-views; labels (country names / CONTACT_LABEL) carry the meaning. Dead `icon:` props + `flag`/`CONTACT_ICON` imports cleaned up.

### Settings / Auth / Landing / Connect / GetStarted — ✅ DONE
- [x] Settings: `space-y-6` (D1.4); `Подключённые каналы` gets a `border-t` hairline-above; empty states (channels list + DB-disabled) → solid hairline boxes (dropped `border-dashed` + `bg-muted/20` fill).
- [x] Settings ChannelKeysPanel `⚠️` → inline SVG alert (done in the emoji-purge pass).
- [x] Auth: AtlavueMark `h-5 w-5`; Trust icons normalized to `strokeWidth 1.5`; input radius `rounded-[4px]`→`rounded`.
- [x] Connect: CodeBlock `<pre>` already `font-mono`; Step badge → `bg-primary/10 text-primary` (subtle); step title → `text-base`.
- [x] GetStarted BloomArt: strokes → monochrome `text-border` (single accent bloom kept); CTAs → `.btn-pill`.
- [x] Landing: Pillars symmetric column gutters (inner-edge padding on both sides of each divider).
- [x] **Landing HeroAurora — DECIDED (2026-07-01): KEEP** as a deliberate hero exception (owner call). The 3 peach/pink/blue radial glows + hero drop-shadow are an intentional marketing-surface choice; the "warm-paper/hairline/one-blue" rules govern the app, the landing hero gets this one exception. Hero mock is `hidden md:block` (no 390px overflow) — responsive-mock item moot.

### Settings / Auth / Landing / Connect / GetStarted
- [ ] Settings: `space-y-8`→`space-y-6`; section intro headings read as ledger breaks not form labels; `Подключённые каналы` gets a hairline-above; empty state = hairline box (not dashed+fill).
- [ ] Settings ChannelKeysPanel: replace `⚠️` emoji with an inline SVG alert icon.
- [ ] Auth: AtlavueMark `h-[18px]`→`h-5 w-5` (brand feels too small vs 24px title); normalize the 3 Trust icons to uniform `strokeWidth=1.5 h-4 w-4` + `aria-label`.
- [ ] Landing: **decide on HeroAurora** (3 radial-gradient peach/pink/blue glows read as generic-SaaS vs our warm-paper+hairline — flatten or keep as a deliberate hero exception; owner call). Hero mock: responsive grid + `clamp()` sizes so it doesn't overflow at 390px. Pillars: symmetric column padding.
- [ ] Connect: `font-mono` on the CodeBlock `<pre>` itself; Step badge → `bg-primary/10 text-primary` (subtle) + bump step title to `text-base`.
- [ ] GetStarted BloomArt: monochrome strokes (border) + single accent bloom (drop `text-ink3` on decorative strokes).

### Emoji-as-icons purge (AI-tell) — ✅ DONE
- [x] Removed 😊😐😠 (sentiment), ❤️↗️💬 (engagement), ➕➖ (churn) from `panels/TgAnalytics.tsx` → `Breakdown` **colour dots**: sentiment verdant/ink3/ember (matches delta palette), engagement chart-1/2/3, churn verdant/ember. Repurposed `mapSourceItems`' 3rd param emoji→colour; **removed the now-dead `icon` prop** from `Breakdown`. (`Insights.tsx` had none.) Verified live: 6 colour dots, 0 purged emoji in DOM.
- [x] Settings `⚠️` → inline **stroke SVG alert triangle** + recoloured the one-time-key caution `text-verdant`→`text-status-warn` (amber caution, was mis-green).
- [x] Kept legitimately: **reaction-emoji data** ("Реакции по эмодзи" shows the actual 👍🔥❤️ reactions — that's the data, not a decorative icon) and demo post-text emoji.

### Empty-state pattern (make one, use everywhere) — ✅ DONE
- [x] Created `components/EmptyState.tsx` — the one pattern: `rounded border border-dashed border-border bg-background py-8 text-center` + heading + optional reason + optional action link (hairline box, not a Card).
- [x] Applied: `TgAnalytics` no-data, all 6 IG `content.tsx` empty states, IG Insights, `TopPosts` (with `/analytics` action link), `Bugs` (DB-disabled + Багов пока нет). `Mentions` + `Settings` empties use the **solid** hairline variant (actionable/section context, not dashed). `CollectorEmptyState` de-carded (kept the 3-step checklist, dropped the Card).
- *(Two empty-state flavors, intentional: **dashed** `EmptyState` = passive "no data"; **solid** hairline = actionable panel / section container — Mentions, Settings.)*

---

> **Sprint D2 — ✅ COMPLETE** (see per-section marks above). Emoji-icon purge, one reusable
> empty-state, metric hierarchy, Posts/Mentions mobile + hierarchy, full IG parity (de-card, pill
> toggles, font-mono scope, DataHealth, single-insight, responsive heatmap), Auth/Connect/GetStarted/
> Landing/Settings polish. Verified live; build + 81 tests green. **One open owner decision: Landing
> HeroAurora** (flatten vs keep). Consciously deferred out of D2: Reels KPI tiling; a few items
> routed to D3 (BarChart mobile x-labels, heatmap best-slot border token) / D4 (section-title
> hairline-above consistency, Mentions quota badge).

---

## Sprint D3 — Chart craft — ✅ DONE
*What separates premium charts from generic ones.*
*(Note: attempted to delegate the mechanical edits to Codex — blocked by its sandbox, which is bound to `mcp-abap-adt` and can't write into `pulse-analytics`. Applied directly. **Codex delegation isn't viable for this repo from this workspace.**)*

- [x] **Tooltips → paper palette.** `ChartTooltip` now `bg-background/95` + `border-border` + `text-foreground` (was `bg-popover`). Snap-to-nearest **crosshair already exists** in `LineChart` (per-point hit targets + vertical guide). *Multi-series stacked/tabular tooltip → F2 (crosshair-tooltip feature).*
- [x] Heatmap "best slot": inline `border:2px solid hsl(--brand-verdant)` → `border-2 border-verdant` token util (`Charts.tsx` + `audience.tsx`); base cells unchanged. Verified live (`rgb(78,188,127)` verdant).
- [x] Gridline/axis restraint: `LineChart` gridlines `opacity 0.6`; `BarChart` x-labels width-aware **thinning** (`labelStride` from measured width — fixes the 14-date overlap, was the D2-deferred item).
- [x] Number formatting: `fmt.short` gained a **billions (B)** tier; `fmt` is already locale-aware + abbreviated + `tabular-nums` in tables; `DeltaPill` is the single `↑/↓`+color+% source. Centralized.
- [x] **Categorical palette a11y:** `--chart-1..6` swapped to an **Okabe-Ito basis** (light+dark) — chart-1 = brand blue, chart-2 = orange (its high-contrast pair), two blues (1,6) farthest apart. Never color-alone (Breakdown = dot **+** text label). Verified live both themes. *(⚠️ visible change — teal→orange, amber→green etc. — flagged for eyeball.)*
- [~] Chart empty/loading: per-chart empty states already exist (`LineChart`/`BarChart` "Нет данных"); layout-aware skeletons handled at panel level (D1.3/D2 skeleton rebuilds). No new work.
- [x] ExpandableChart close button: already an SVG `×` in `rounded-full hover:bg-muted` (design.md target already met). Heatmap best-slot `border` token covers the `Charts.tsx` line.

> **Sprint D3 — ✅ COMPLETE.** Chart tooltips on paper, restrained gridlines + thinned bar labels,
> colour-blind-safe categorical palette (Okabe-Ito), heatmap best-slot as a token, billions formatting.
> Build + 81 tests green; verified live (light+dark). Deferred: multi-series tabular tooltip → F2.

---

## Sprint D4 — Analytics restructure (break the 20-chart wall) — ✅ DONE
*The single biggest structural issue: `/analytics` stacked ~20 chart blocks with no hierarchy.*

- [x] Regrouped into **4 tabs**: **Динамика** (Просмотры по дням, Рост, Просмотры и репосты, Чистый прирост, Отток + История + Скорость), **Аудитория** (источники ×2, Языки, Тональность, Активность по часам, По дням недели + Тепловая карта), **Контент** (Реакции по эмодзи, Состав вовлечённости, Ср.охват по типу + Хэштеги), **Сравнение** (Compare + Авто-инсайты). Impl: `TgAnalytics` gained an optional `group` prop (`inGroup(g) = !group || group === g`; KPI ledger always shows as the group header; `!group` = all sections, backward-compatible); `App.tsx` `Analytics()` renders an underline tab bar (`role=tablist/tab`, `aria-selected`) and only the active group's content. **Verified live: each tab renders only its family** (Динамика=5, Аудитория=7), switching works, 0 console errors.
- [~] "показать все" / per-tab top-N progressive disclosure → **deferred** (the tabs already break the wall + only one group's DOM renders at a time; per-tab top-N is a refinement, not needed to fix the "wall").
- [x] Compare "Период vs предыдущий" → hairline-trailing section heading (matches the `ChartSection` rhythm).
- [~] Consistent section rhythm (hairline-above all `ChartSection`s) → the app is already consistent on the **trailing-hairline** `ChartSection` pattern; reformatting every one to hairline-above would be churn for no clarity gain, so kept as-is (this was the D2-deferred item — resolved as "no change, already consistent").

> **Sprint D4 — ✅ COMPLETE.** `/analytics` is now 4 tabs (Динамика / Аудитория / Контент / Сравнение)
> — the ~20-chart wall broken into focused, progressively-disclosed groups. Build + 81 tests green;
> verified live (tab switching filters section families). All D-sprints (D1–D4) now complete.

---

## Sprint F1 — Analytics features · batch 1
- [~] **Timeline annotations / event markers** — DB **confirmed live on prod** (`/api/ready` → `database.ok`). **Backend BUILT (uncommitted, `node -c` clean):** migration `006_annotations.sql` (`chart_annotations` table, per-channel FK + `created_by`), `db.js` `listAnnotations`/`createAnnotation`/`deleteAnnotation`, channel-scoped routes `GET/POST/DELETE /api/channels/:id/annotations` (ownership via `getChannel`, `!enabled`-guarded, audit-logged). **Remaining = FRONTEND:** api hooks + render markers on the trend charts + add/delete UI. ⚠️ can't verify end-to-end locally (no local `DATABASE_URL`) — needs prod DB (or the vite→prod proxy trick).
- [x] **Ghost previous-period overlay** — `LineChart` `ghost` prop draws the previous equal-length window as a faded dashed line on the **same y-scale**, with a "Пунктир — прошлый период" hint. Wired on "Просмотры по дням" (previous 14 days via `views_by_day.slice(-28,-14)`, guarded when history is long enough). Verified live (dashed line renders, 0 errors). *(everywhere-toggle + more trend charts → follow-up.)*
- [x] **Content breakdown by format** — new "Вовлечённость по формату" section (Контент tab): avg **ERV per media type** from in-range posts (which formats *engage*, complementing "Ср. охват по типу" = which get views). Sorted desc, "X% ERV · N шт". Verified live. *(IG format aggregate + period comparison → follow-up.)*
- [⏸] **Engagement composition over time** (stacked likes/comments/shares/saves) — **DATA-BLOCKED for TG**: the graphs API exposes only `views_by_day` + `interactions` (views/shares), no daily reactions/replies series. Totals live in "Состав вовлечённости"; format-quality in the new "Вовлечённость по формату". *(Revisit if a daily engagement series is added, or do it for IG.)*

## Sprint F2 — Analytics features · batch 2
- [~] **Interactive charts standardized:** **crosshair — done** (LineChart snap-to-nearest guide + paper tooltip, D3). **brush-to-zoom → deferred** (largely redundant with `ExpandableChart`'s window presets 1М/3М/6М/Всё; high interaction complexity vs payoff). **click-to-drill on charts → deferred** (large; `KpiDrillDown` already covers KPI drill).
- [x] **Anomaly / trend markers on charts** — `lib/anomaly.ts` `detectAnomalies` (local-outlier: rolling neighbourhood mean±σ, flag >2.5σ, never flags a smooth trend) + `LineChart markAnomalies` prop → hollow amber rings on outlier points + "· аномалия" appended to the hover tooltip. Enabled on История подписчиков / Просмотры по дням / Рост подписчиков. **+6 unit tests** (87 total). Verified live (ring renders, 0 errors). *(Deeper "почему" tie-in to auto-insights → follow-up.)*
- [x] **Post leaderboard** — the Posts "Публикации · топ-25" table is now **sortable by any of 6 metrics** (Просмотры / Реакции / Репосты / Вирал. / ERV / ER) via clickable headers with ↑/↓/↕ indicators (toggle asc/desc). Verified live (ER sort reorders rows + moves the active indicator). *(mobile list follows the active sort.)*
- [⏸] **Saved views / presets** — **NEEDS BACKEND + DB** (extend `user_prefs` to named configs + API). Deferred pending the DB confirmation. *(per-user layout prefs already persist; this adds named/switchable views.)*

> **F1/F2 progress (frontend, UNCOMMITTED — user reviewing before commit/deploy):**
> ✅ anomaly markers (F2), ✅ post leaderboard (F2), ✅ ghost previous-period overlay (F1),
> ✅ content breakdown by format (F1). Build + **87 tests** green; each verified live in demo mode.
> ⏸ **Blocked on backend/DB:** timeline annotations (F1) + saved-views (F2) — need Railway Postgres
> (`DATABASE_URL`); **data-blocked:** engagement-over-time (no daily reactions series in TG graphs).
> **Deferred:** brush-zoom (redundant with the window presets), chart-drill (large; KPI drill exists).

---

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

## Sprint D5 — кандидаты из live-ревью прода 2026-07-02 (⏳ ждёт приоритизации владельцем)
*Источник: живой обход https://atlavue.app (light+dark, TG+IG, все разделы) + сравнение со
steep.app. Полный разбор: `AUDIT_2026-07-02_arch_design.md`. Это то, что реально «выдаёт AI» —
каждый пункт мелкий, вместе дают основной эффект.*

### D5.1 Полировка-баги (P0) — ✅ SHIPPED (main `bb08036`)
- [x] Markdown-сырец в текстах постов → `stripTgMarkdown()` в `lib/posts` (Топ постов / Посты / модалки) + тесты.
- [x] «обновлено обновлено»: `freshness()` возвращает голый относительный label, потребители добавляют «обновлено» единожды.
- [x] Двойной H1 «Настройки» (в модалке настроек H1 один — топбар-роут).
- [x] Английский в графиках: `ruSeriesName()` (Views→Просмотры/Shares→Репосты) + `ruAxisLabel()` (месяцы Jan→янв) в `lib/format` + тесты.
- [x] Тултип LineChart: привязан к точке, чистится на pointerleave/scroll, не лезет за верх плота (z-10 < шапки).
- [x] Y-подписи: зарезервирован левый gutter, подписи в нём, плот начинается после.
- [x] ExpandableChart: разворот только по кнопке ↗ (a11y-dialog: focus-trap/scroll-lock/Esc); клики по телу графика — нет.
- [x] «Аудитория»: сетка без дыры (секции — прямые grid-элементы, последняя нечётная тянется на 2 колонки).
- [x] BarChart n=2: кэп ширины бара 48px + центрирование группы.
- [x] IG: video-URL больше не идёт в `<img>` (причина белых дыр) → плейсхолдер-тайл + обложки `aspect-[4/5]`.
- [x] Данные спорят: Сравнение → EmptyState с объяснением (Обзор = дельты Telegram, Сравнение = архив сборщика).
- [x] Error-карточка получила «Повторить» (+ retry-предикат не ретраит 4xx; 401 → Landing/редирект).

### D5.2 Chart-craft 2 + язык компонентов (P1) — ✅ SHIPPED (main `bb08036`)
- [x] Плоская заливка столбиков + hover (вертикальный градиент убран); line/area-градиент сохранён.
- [x] Топ постов: бейдж только при pct ≥ 100 (≥2× среднего) — не под каждой строкой.
- [x] ERV/ER: нейтральный `text-ink2`, цвет только у относительных выбросов (медиана видимых строк).
- [x] Язык кнопок сведён: primary CTA = pill (Обновить/Подключить), tool-кнопки — тихие rect.
- [x] Dark: `--row-tint-colored/-neutral` токены (болотные подсветки убраны, цветная точка = сигнал категории).
- [x] Rail: тултипы+aria на иконках свёрнутого сайдбара (см. D5.4).
- [x] «UID · Owner» в Настройках — только для суперюзера.
- [x] Пустое «Период vs предыдущий» → EmptyState.
- [~] Модалка разворота бар-чартов: добавлены значения над столбами + оси в развороте *(частично: не «не разворачивать», а обогатить)*.
- [~] Auth-страницы: **⏳ пустая половина не заполнена**; ⚠️ на проде НЕТ кнопки «Sign in with Google» — вероятно не задан `GOOGLE_CLIENT_ID` (проверить env).

### D5.3 Паттерны из steep — частично SHIPPED (main `f059791`)
- [x] **Period pager** «‹ ›» рядом с пресетами (шаг окна через custom-range; ‹ до дна архива 730д, › сброс на rolling).
- [x] **Value labels** на пике+последней точке (`markExtremes` prop LineChart) — «Просмотры по дням», «История подписчиков».
- [x] **Состояние в URL** (`?p=/?from&to`, `?tab=`, replace) — шарабельные ссылки.
- [ ] **Метрика как объект** (эволюция KpiDrillDown → страница метрики: определение + breakdown + compare). Большой, обсудить скоуп.
- [ ] F3-отчёты в форме **документа** (заголовок + глобальный фильтр-бар + текст-секции между метрик-карт) — модель steep Reports.
- [ ] **«Закреплённое»** — секция шорткатов под навигацией сайдбара (аналог steep Teams-шорткатов). Отложено до saved views (F2) — не строить пустой UI раньше данных.

### D5.4 Сайдбар (steep-style) + Настройки (Claude-style) — ✅ SHIPPED (main `fd31ebe`)
- [x] Сайдбар: постоянная push-колонка (240/64px), тоггл в шапке + Ctrl/⌘B, персист `pulse_sidebar` (hover-оверлей убран).
- [x] Секции навигации Telegram/Instagram вместо скрытого свитчера платформ (обе платформы видны сразу).
- [x] Активный пункт = полная подсветка строки (`bg-hover-row`), синяя палка убрана.
- [x] Канал-свитчер с детерминированным цветным letter-avatar (6 muted tint-пар, light+dark).
- [x] «Настройки» в сайдбаре; футер-статус свежести остался последним. Mobile: свитчер платформ в MobileHeader.
- [x] Настройки — модалка как в Claude (не страница): `role=dialog`, focus-trap, Esc/backdrop, закрытие на исходную страницу; левый pane-switcher `?section=`; строки «заголовок+описание / контрол».
- [x] Тема в настройках Светлая/Тёмная/**Системная** (matchMedia) синхронно с меню аккаунта.

### D5.5 Backend hardening — ✅ SHIPPED (main `0491aa8`)
- [x] asyncHandler + error-middleware (нет крашей на rejected await; `e.message` не течёт наружу).
- [x] Таймауты на все исходящие HTTP; open redirect `/app` закрыт; HSTS; `/api/*` 404 JSON.
- [x] IG-квота: кеш сторис 180с, clamp ключей, singleflight; cache TTL-sweep + cap.
- [x] getChannel исключает disabled; ingest-токен в header + timing-safe; audit на admin/reset/verify.
- [x] Коллектор: dead-letter на 4xx + cap, неблокирующая доставка. mtproto: FloodWait→429, Semaphore(1), CORS убран.
- [⏳] **`APP_URL`/`TRUSTED_HOSTS` на Railway** — проверить (дефолт = старый pulse-хост; boot-warning добавлен).

### D5.6 TEAM_PASSWORD removal — ✅ MERGED в main (`e368496`)
- [x] Break-glass логин убран, `SESSION_SECRET`/`MTPROTO_TOKEN` обязательны в prod (fail-fast), ключи derived, mtproto fail-closed.
- [x] Railway env выставлены владельцем (`MTPROTO_TOKEN` на оба сервиса + `SESSION_SECRET` на web) → ветка влита.
- [⏳] После зелёного деплоя: удалить `TEAM_PASSWORD` с обоих Railway-сервисов. Все сессии инвалидируются (re-login; break-glass больше нет → нужен обычный суперюзер).

---

## Sprint D6 — кандидаты из пост-D5 live-ревью прода 2026-07-02 (вечер) — ⏳ ждёт приоритизации
*Источник: обход https://atlavue.app ПОСЛЕ деплоя D5 (обе темы, TG+IG live-данные) + повторный
разбор steep.app (landing + web-app demo: metrics catalog / metric page / reports). D5-фиксы
сверены живьём: тултип/RU-оси/y-gutter/EmptyState/бар-кэп/IG-обложки/сайдбар/модалка настроек/
палитра/pager/value labels — работают. Ниже — то, чего D5 не покрыл.*

### D6.1 Доверие к данным (P0 — числа спорят между собой на одном экране)
- [ ] Обзор: Инсайт говорит «подписчики −166» (архив joined−left, `panels/Digest.tsx:33-45`),
      леджер над ним — «−110» (graphs-дельта, KpiGrid). Один экран — одна правда: Digest берёт
      ту же graphs-дельту, либо каждая цифра подписана источником.
- [ ] Аудитория: «Просмотры по источникам» = 155 419 при hero «8.6k за 30 дн»
      (`panels/TgAnalytics.tsx:413`, `graphs.views_by_source` — все просмотры канала за окно,
      включая старые посты). Подпись-каверна («все просмотры канала за период, вкл. старые
      посты») или нормировка в %-доли.
- [ ] IG-леджер: «Просмотры 0», «Взаимодействия 0», «Вовлечённость —» с пилюлей «↓100%»
      (`panels/instagram/IgOverview.tsx:38-40`, `fmt.short(0)` + `pairDelta` без guard).
      Недоступная метрика ≠ ноль: «—» + hint «API не отдаёт метрику для этого аккаунта»;
      дельту скрывать при пустой/нулевой базе.
- [ ] «Лучшее окно — Пн 9:00» (авто-инсайт, по охвату) vs «лучший слот: Чт 6:00 · ERV 9.4%»
      (heatmap) на соседних табах: указать метрику в обеих подписях («по охвату» / «по ERV»).

### D6.2 Текст постов (P0 — самый громкий «неотполировано»-сигнал)
- [ ] Markdown-лик ЖИВ в «Топ постов»: `[Хлопок и шалфей](https://…-4…` — сервер обрезает
      caption для top_posts ДО стрипа, обрезанная ссылка не закрыта скобкой → `TOKEN` в
      `lib/markdown.ts:21` не матчит и отдаёт сырец. Фикс: (а) сервер стрипает markdown до
      усечения; (б) клиент — fallback на висячий `[label](tail` в `parseInlineMarkdown`
      (отдавать label, отбрасывать хвост). + тест.
- [ ] Склейка строк в однострочных заголовках: «…жизнь мастерской Именно здесь…» —
      `markdownToPlainText` (`lib/markdown.ts:76`) схлопывает `\n` в пробел. Для титулов:
      первая непустая строка (или `\n+` → « · »). Общий `postTitle(caption)` для
      TopPosts/Posts/модалок.
- [ ] Модалка поста: мета «559 просм · 33 реакц · 3 реп» → полные слова («просмотров ·
      реакции · репоста»), места достаточно (`panels/Posts.tsx` PostModal).
- [ ] ДВЕ разные модалки одного поста: из «Топ постов» — фото+полный текст
      (`components/PostDetailModal.tsx`), из «Публикаций» — заголовок+кривая набора
      (`panels/Posts.tsx:278`). Слить в один компонент: фото + титул + мета + стат-ряд +
      «Динамика набора» + «Открыть в Telegram».

### D6.3 Chart-craft 3 (по живым данным)
- [x] **Y-ось LineChart: nice-ticks — SHIPPED (волна metric-page).** `niceScale` в
      `components/LineChart.tsx`: шаг 1/2/5×10ⁿ, домен наружу (floor/ceil), кэп 5 тиков,
      step-aware формат (суб-тысячный шаг на k-шкале → полные числа «4 950», иначе fmt.short),
      дедуп после форматирования. `yMin={0}` = zero-base (включён на страницах метрик для
      объёмных). Остальные объёмные чарты Аналитики перевести на `yMin={0}` — follow-up.
- [ ] Value label пика наезжает на линию/маркер («5.3k» прямо на кривой, История) —
      вертикальный offset + учёт anomaly-кольца (`LineChart markExtremes`).
- [ ] BarChart: value labels над столбцами при n≤8 («Количество постов», «По дням недели»,
      «Упоминаний по дням» — сейчас ни одного значения на осях; steep подписывает бары).
- [ ] «Количество постов»: 7 столбиков с кэпом 48px по центру full-width секции = острова в
      пустоте (`panels/TgAnalytics.tsx:475`). Обернуть чарт в `max-w-[~560px]` слева или
      спарить секцию в 2-колоночную сетку.
- [ ] Болотные плашки в дарке ОСТАЛИСЬ: «Состав вовлечённости» (Репосты), Сравнение «По
      форматам» (Фото), «#open» — широкая цветная заливка ряда через `--row-tint-colored`
      (`components/Breakdown.tsx:31`). В дарке: нейтральная плашка для всех (категорию несёт
      точка), цвет — только тонкому value-бару. + `:32` фолбэк на МЁРТВЫЙ токен
      `--brand-iris` → `--primary`.
- [ ] «Влияние хэштегов» — единственная Card-коробка на всю Аналитику
      (`panels/Hashtags.tsx:100`, + skeleton/error `:19/:28`) → ChartSection-паттерн
      (открытая секция с trailing-hairline).
- [ ] Оси «Динамики набора» в модалке: «13 июн 21:00» ×3 — час убрать на дневном грануле.

### D6.4 IA / дубли
- [ ] `/posts` открывается дублем «Топ постов за период» (`panels/Posts.tsx:81`) над
      «Публикации · топ-25» — лидерборд с сортировкой уже покрывает топ. Убрать блок
      (или заменить строкой-сводкой периода).
- [ ] «(нажмите на столбец для сортировки)» в заголовке (`panels/Posts.tsx:89`) — снять,
      аффорданс ↕ уже есть.
- [ ] «Охват по дням недели» (Сравнение) ≈ «По дням недели» (Аудитория) — один и тот же
      разрез на двух табах; в Сравнении заменить на ghost-сравнение периодов или убрать.
- [ ] IG Контент: первая секция экрана — пустые «Отметки на фото»
      (`panels/instagram/IgContent.tsx:22`). Пустую секцию — вниз (или скрывать, раз
      EmptyState несёт только «пока пусто»).
- [ ] IG hero «Охват» в коробке-карточке — TG-hero открытый; де-кард для паритета
      (`panels/instagram/IgOverview.tsx`).

### D6.5 Микро-полировка
- [ ] **⬆ ПРИОРИТЕТ: `fmt.day` сдвигает даты на день в западных таймзонах.** Date-only строки
      парсятся как UTC-полночь и рендерятся в локальной TZ → в UTC−3 (владелец сейчас в ней!)
      «2026-06-01» показывается как «31 мая» во ВСЕХ осях/таблицах (видно на проде: недельные
      колонки pivot, «сгенерирован» в отчёте — последний уже пофикшен локальной датой). Фикс:
      `fmt.day` парсит `YYYY-MM-DD` как ЛОКАЛЬНУЮ дату (`new Date(y, m-1, d)`) + тест; сверить
      с UTC-бакетированием (пост 22:00 UTC−3 попадает в UTC-завтра — вопрос консистентности из
      A11y «locale-aware dates», решить одним заходом).
- [ ] Свитчер каналов: в дропдауне letter-аватары, хотя у канала есть логотип (карточка
      сайдбара показывает его); + нет «+ Добавить канал» (→ Настройки·Каналы).
- [x] **Командная палитра → поиск в стиле Claude/steep — SHIPPED.** Безголовая центрированная
      строка (иконка + инпут + `esc`-чип, бумажный backdrop), **история «Недавнее»**
      (localStorage `pulse_palette_recents`, MRU 6, сохраняется при выполнении команды),
      группы Разделы (TG+IG+система) / **Метрики** (6 страниц `/metrics/:key`) / Каналы /
      Аккаунт, иконки из nav-icons, «⏎»-чип на активной строке, футер-легенда
      «↑↓ · ⏎ · esc». Проверено в демо: фильтр, Enter-навигация, MRU-порядок.
- [ ] Mentions топ-каналы: «7 · 6.5k охв» → «7 упоминаний · охват 6.5k».
- [ ] KPI-леджер Аналитики: подпись «вовлечённость на пр…» обрезается на ~1240px —
      сократить копи или `title`-тултип.
- [ ] «Вовлечённость по формату»: строки с n=1 («Видео · 1 шт») наравне с n=17 — приглушать
      и помечать «мало данных» при n<3.
- [ ] (опционально) `backdrop-blur` на шапке/bottom-nav (`DashboardLayout.tsx:550/:383`) →
      непрозрачная бумага: blur на матовой теме почти не виден, но платится GPU-налогом
      (steep/linear — solid).

### D6.6 Steep-паттерны · волна 2 (дополнение к D5.3)
- [x] **Metric page (S2) — v1 SHIPPED.** `/metrics/:key` (views/subscribers/avgReach/reactions/
      forwards/er): hero-значение+Δ+caption (та же математика, что в леджере — общий
      `lib/kpiDerive.ts`), большой дневной чарт (value labels, anomaly-кольца, ghost прошлого
      окна с подсказкой, ось от нуля для объёмных), рейл «Сравнение» (текущее/прошлое окно,
      честные фоллбэки) + «О метрике» (формула/что учитывается/источник из `metricDefs`) +
      «Топ постов по …» с reconcile-строкой. Вход: клики по KPI Обзора (hero+леджер+Рост
      подписчиков), топбар-титул = имя метрики. Старая модалка KpiDrillDown удалена
      (поглощена страницей). *Follow-up: TgAnalytics-леджер (ERV/виральность) → страницы;
      команды палитры «Метрика: …»; нижний таймбар не делаем — глобальный период уже в
      топбаре с пейджером (осознанная адаптация).*
- [x] **Виджеты v3: превью типов + iOS drag-and-drop (SHIPPED).** (а) Диалог «Настройка
      виджета»: сегмент «Тип» → **живые превью-карточки** (steep Edit widget) — каждый вариант
      рендерится по-настоящему в масштабе 0.5 (обёртка 448px → scale), наследует выбранный
      акцент/тинт (WYSIWYG), активная в ring-рамке, подпись снизу; диалог расширен до max-w-lg.
      (б) **«Переставить» в меню → iOS-джигл**: все виджеты группы дрожат (keyframes
      `widget-jiggle` ±0.4°, чётные — другая фаза; reduced-motion выключает), становятся
      draggable (HTML5 DnD), live-swap на dragover (кулдаун 160мс + запрет мгновенного
      реверса пары — гасит пинг-понг от рефлоу), контент виджетов pointer-events-none,
      меню «⋯» скрыто, **плавающая пилюля «Готово»** (portal, bottom-center) + Esc выходят
      из режима; порядок персистится тем же `pulse_widget_order`. Тач-фоллбэк = прежние
      Выше/Ниже. Демо-верифай: превью с реальным контентом, джигл ×7, DnD-своп persisted.

- [x] **МЕГА-ВИДЖЕТЫ: блоки ленты = гигантские поверхности + всё в виджетах (steep Home, SHIPPED).**
      Каждый блок ленты — rounded-2xl панель «на тон от канваса» (light = полный bg-card белый —
      /50-микс на бумаге неразличим, ΔL*≈1.1; dark = bg-card/50 → слои канвас→поверхность→виджет
      читаются); мобайл-инсет ужат (px-3). Внутри всё виджеты: **Обзор** — hero+леджер открыты
      («greeting»-зона), Инсайт/Рост подписчиков — WidgetGroup id="overview" с ЯВНЫМИ id
      `overview-*` (дефолт id=title коллизировал с виджетами Аналитики на той же странице:
      скрыл один «Рост» — исчезали ОБА), Топ постов — full-width виджет ВНЕ группы (span-2 +
      CSS-order реордер = дыры в сетке); **Посты** — дубль топ-постов удалён (D6.4), таблица =
      виджет с flush-паддингами ячеек (px-3, first:pl-0/last:pr-0) и скелетоном, зеркалящим
      новый лейаут; **IG** — все чарт-секции на виджетах (вкл. TrendCard в shared — был
      полу-мигрирован); леджер-ячейки в блоках bg-background→bg-card (не «дыры» канваса на
      поверхности; Report-леджер оставлен — документ на канвасе); Digest отдал заголовок
      «Инсайт» хостам. **Пре-деплой ultracode-ревью** (14 агентов, 2 линзы + адверсариал-
      верификация): 8 подтверждённых находок, все исправлены до деплоя. ⚠️ ГРАБЛИ: PowerShell
      Get/Set-Content на UTF-8-без-BOM ломает кириллицу (ANSI-чтение) — восстановлено из git,
      правки переделаны Edit-тулом; PS для текстовых замен в сорцах не использовать.

- [x] **TG-ЛЕНТА: Обзор → Аналитика → Посты → Упоминания одной страницей (steep Home, SHIPPED).**
      Решение владельца: скролл перетекает между разделами; каждый блок открывается **жирным
      заголовком** (text-2xl) + `border-t` + большой воздух (space-y-20/pt-14). `panels/TgFeed.tsx`:
      один роут `:section?` (optional-сегмент, БЕЗ ремаунта при replace-навигации) обслуживает
      все 4 старых пути — deep-links живы; **scrollspy** (тайм-троттлинг, БЕЗ rAF/IO — они не
      тикают во frame-starved средах) двигает URL/сайдбар/топбар за читателем (replace);
      клик по сайдбару = плавный скролл к блоку (спай молчит до достижения цели —
      `pendingTarget`, отмена по wheel/touch; таймер-ре-анкоринг против сдвига от
      домонтирования); **LazyBlock** = ленивый монтаж ниже фолда (IO + scroll-fallback,
      скелетон-виджеты) — урок D4 сохранён; `history.scrollRestoration='manual'`; без каналов —
      только GetStarted. `Analytics` вынесен из App.tsx → `panels/AnalyticsTabs.tsx` (табы
      внутри блока как были). ⚠️ Верифай в headless-превью частичен (IO/rAF/innerHeight там
      мертвы) — спай/монтаж/пути проверены, ЯКОРЬ deep-link проверить в реальном браузере. Меню «⋯» = **Выше / Ниже /
      Изменить / Скрыть** (как steep Move up/down/Edit/Delete): порядок — `WidgetGroup`-контекст
      (регистрация детей + CSS `order` в grid; persist `pulse_widget_order[groupId]`; обёрнуты
      грид TgAnalytics per-tab, Mentions, Compare); скрытие — `prefs.hidden` + бар «Скрытые
      виджеты: … +» под группой; **«Изменить» открывает диалог** (steep Edit widget):
      **Тип виджета** (`variants` — секция объявляет представления: line↔bar для дневных/
      недельных чартов, `breakdownVariants` список↔столбцы для всех Breakdown-секций — ~14
      секций подключено), **Заголовок** (кастомное имя виджета), Акцент-свотчи, Цветной фон,
      Сбросить. ГРАБЛИ: (а) эффект регистрации зависел от ctx-объекта (пересоздаётся каждый
      рендер) → cleanup/register-луп «Maximum update depth» — деп только на стабильный
      `register`-callback; (б) битый HMR маскировал фикс (старый `?t=` в стеке) — рестарт
      dev-сервера (памятка подтвердилась в третий раз); (в) забыл `variant` в emptiness-чеке
      setPrefs → вариант-only пресет удалялся. *Follow-up: variants для История/Скорость/
      Рост (нужна прокладка полных labels), IG-панели, prefs→user_prefs.*

- [x] **Виджет-дашборд + пер-виджет кастомизация (steep Home) — SHIPPED.** Решение владельца
      (осознанная эволюция «hairlines-не-карточки»: КАРТОЧНАЯ поверхность теперь канон для
      ЧАРТ-виджетов, hairline-леджеры остаются для KPI/таблиц/документа-отчёта):
      `components/ChartWidget.tsx` — виджет-шелл (rounded-xl, bg-card на бумаге/тёмном канвасе)
      с меню «⋯»: **акцент** (Стандарт + 6 свотчей `--chart-1..6`; работает скоупингом
      `--brand-iris` на поддерево → LineChart/BarChart/Sparkline/Breakdown перекрашиваются без
      пропсов) + **«Цветной фон»** (тонировка карточки акцентом, как у steep) + «Сбросить»;
      персист `localStorage pulse_widget_prefs` (id = title). **Заодно закрыт FH3-копипаст:**
      4 локальные копии ChartSection (TgAnalytics/Charts/Compare/Mentions) удалены → все
      секции Аналитики (все 4 таба) и Упоминаний теперь кастомизируемые виджеты; главный чарт
      metric page — виджет с type-свитчером в шапке (рейл/отчёт остаются плоскими). Верифай:
      акцент 2 → stroke rgb(225,155,5), тинт rgba(...,0.07), persist/restore. *Follow-up:
      IG-панели на виджеты; sync prefs в user_prefs API (кросс-девайс); Overview — решить
      отдельно (Figma-слим).*

- [x] **Metric page v2 — ПОЛНЫЙ steep-эксплорер (SHIPPED).** По запросу владельца «сделаем один
      график максимально полным»: (1) **нижний таймбар** — гранулярность **День/Неделя/Месяц**
      (URL `?grain=`, недоступные для окна ступени disabled: месяц <60д, неделя <14д) + пресеты
      7д/30д/90д/Всё + чип кастом-диапазона + **пейджер ‹ ›** (шаг = длина окна; вперёд к
      сегодня = снап в rolling с суточным допуском); (2) **4 типа графика**: line / bar /
      **rank** (`components/RankChart.tsx`: категории по значению, парный бар базы, ▲Δ% на
      строку, «Итого», легенда) / **pivot** (`components/PivotTable.tsx`: измерение × время,
      синий heat-рэмп от глобального максимума, «Values & colors» как у steep); rank/pivot
      скрыты для подписчиков (нет пер-пост атрибуции); (3) **Разбивка с выбором измерения** —
      Формат / **День недели** (`?dim=`, сегмент-селект в рейле; rank/pivot/список следуют);
      (4) **Сравнение с выбором базы** — Выкл / Пред. период / **Год назад** (`?cmp=`);
      база = пунктир на линии + парные бары в rank + числа cur/base + ▲Δ% в рейле; честные
      фоллбэки («в выборке нет данных за …»). Бакетирование grain-aware (UTC: дни/понедельники/
      первое число), серии/rank/pivot/сравнение — из одного normPostsAll (added to kpiDerive).
      Весь вид в URL: `?chart&grain&dim&cmp` + период. Демо-верифай: все переключатели, пейджер
      туда-обратно, disabled-ступени. *Rollout на остальные чарты Аналитики — следующая волна.*

- [x] **Metric page v1.1 — интерактив как у steep (SHIPPED следом).** (а) переключатель
      **line ↔ bar** в шапке чарта (иконки-сегмент; состояние в `?chart=`, шарабельно);
      bar-режим = BarChart в rich-режиме через `ChartExpandedContext` (y-тики + value labels);
      (б) **точки-кольца на каждой точке линии** (`LineChart showPoints`, ≤45 точек) — steep-вид
      «последовательность измерений»; (в) рейл дополнен **«Разбивка по формату»**
      (Breakdown-строки по mediaType/albumSize, нейтральный tint) — для пост-метрик;
      (г) ghost прошлого периода стал **тогглом** «Прошлый период на графике · вкл/выкл»
      в секции «Сравнение» (line-режим). Проверено в демо: URL-state, переключения, скрытие
      разбивки у подписчиков, 0 console-ошибок.
- [x] **Report-документ (S4/F3) — v1 SHIPPED.** Страница `/report` («Отчёт» в сайдбаре/палитре):
      документ-заголовок «@канал — период · сгенерирован дата» + **глобальный фильтр-бар
      пилюлями** (период-чипы + сброс кастом-диапазона · канал-дропдаун при ≥2 · Telegram ·
      «Печать / PDF»), секции: Сводка (6-KPI леджер-ссылки на страницы метрик) → Инсайт
      (Digest) → 2 метрик-карты (line+points+labels, «Открыть →») → **«По неделям» —
      heat-шейдинг таблица** (6 недель × Просмотры/Реакции/Репосты/Δ подписчиков; заливка =
      доля от максимума строки, verdant/ember) → Наблюдения (Insights) → Лучшие публикации
      (TopPosts) → футер-подпись. **Печать: app-shell (сайдбар/топбар/bottom-nav) скрыт через
      `print:hidden`** → Ctrl+P = документ-PDF (базовый экспорт до полноценного F3).
      *Follow-up: «Add to report» с метрик-страниц + именованные отчёты (нужна персистенция),
      share-ссылка/расписание (F3), IG-платформа в фильтре.*
- [ ] Value label на последней точке/баре по умолчанию (у нас `markExtremes` только на 2
      чартах; steep подписывает last-value почти везде в отчётах).
- [~] Политика «ось от нуля» для объёмных метрик — `LineChart yMin={0}` теперь дружит с
      nice-scale (домен от нуля, тики круглые); включена на страницах метрик. Остальные
      объёмные LineChart'ы Аналитики — follow-up (BarChart и так от нуля).
- [ ] (опционально) Heat-шейдинг ячеек в таблице «Период vs предыдущий» (Compare) — заливка
      интенсивностью значения, красная — аномалия (steep Reports).
- [ ] (лендинг, опционально) Serif-display акцент в hero-заголовке (steep: serif + курсивное
      слово) — точечный «не-AI» сигнал маркетинговой страницы; app остаётся на Inter.

> **Перф-инцидент при ревью — снят с прода.** Вкладка замирала на 30–60с при скролле/скриншотах,
> НО: воспроизвелось и на steep.app; «glow» на маркерах оказался курсором-оверлеем расширения
> Chrome-автоматизации; в коде drop-shadow нет; DOM /analytics — 763 узла. Вердикт: окружение
> (расширение+CDP+GPU этой машины), не приложение. Владельцу: разово прокрутить /analytics
> руками — если руками плавно, вопрос закрыт окончательно.

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
