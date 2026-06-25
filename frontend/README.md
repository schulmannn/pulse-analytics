# Pulse frontend (Sprint 3F — Vite + React + TS)

New dashboard frontend. Replaces the legacy `public/index.html` (~5k lines, inline
`<script>`, manual `renderX()` + a global `state` object) **panel by panel** —
strangler-fig, not a big-bang rewrite. The old dashboard keeps serving at `/`; this app
is served by Express under **`/app`** until everything migrates (3F-3 catover).

## Stack

- **Vite** + **React 18** + **TypeScript** (strict)
- **Tailwind CSS 3** + **shadcn/ui** (`new-york`) — design tokens in `src/index.css`
- **TanStack Query** — data fetching/cache/dedupe (no refetch-on-focus)
- **Zod** — runtime validation → inferred types for every API response

## Commands

```bash
npm install                 # once
npm run dev                 # Vite dev @ :5173, proxies /api → http://localhost:3000
npm run build               # tsc --noEmit && vite build → dist/  (what Docker runs)
npm run typecheck           # tsc --noEmit
```

Dev needs the Express server running in the repo root (`npm run dev` there → :3000).
Data only appears when you're logged in and the channel APIs return — locally that
usually means you'll hit the “Нужен вход” gate. Real data shows on the deployed `/app`.

## Layout

```
src/
  api/
    client.ts      apiGet(path, zodSchema) → typed, throws ApiError (has .status)
    schemas.ts     Zod schemas — PERMISSIVE (optional/nullable/.passthrough)
    queries.ts     TanStack useQuery hooks (one per endpoint)
  components/ui/   shadcn primitives (Card, …) — add with `npx shadcn@latest add <x>`
  lib/
    utils.ts       cn() class merge
    format.ts      fmt.* + sparkline paths — PORTED from legacy, keep output identical
  panels/          one file per dashboard panel (Hero.tsx, KpiGrid.tsx, …)
  App.tsx          shell + auth gate + panel composition
  main.tsx         React root + QueryClient
```

## How to migrate a panel (the pattern)

Reference implementation: **`panels/KpiGrid.tsx`** + **`panels/Hero.tsx`**
(ported from legacy `renderKpis()` / `renderHero()`, TG path).

1. **Schema** (`api/schemas.ts`): add a Zod schema for the endpoint's response. Keep it
   permissive — fields `.optional()`, objects `.passthrough()`, numbers `z.coerce.number()`.
   Validation shapes types; it must **never throw on real data** and blank a panel.
2. **Query** (`api/queries.ts`): add a `useX()` hook calling `apiGet(path, Schema)`.
3. **Panel** (`panels/X.tsx`): a function component reading the hook. Handle the three
   states explicitly: `isLoading` (skeleton), `isError` (inline message), empty data.
   Port the legacy render logic 1:1; reuse `fmt.*` so strings match exactly.
4. **Mount** it in `App.tsx`.

## Rules (these are also the review checklist)

- **Colors:** only semantic Tailwind tokens (`bg-card`, `text-foreground`,
  `text-muted-foreground`, `text-primary`, `border`, `bg-muted`) or brand accents
  (`text-iris`, `text-verdant`, `text-ember`; in raw SVG use `hsl(var(--brand-iris))`).
  **Never hardcode hex** — the palette + dark theme live in CSS variables.
- **CSP:** the `/app` route runs `script-src 'self'` (no inline scripts/handlers). React
  event props (`onClick=`) are fine — they compile to JS. **No** `dangerouslySetInnerHTML`
  with server/user data (that's what JSX escaping protects us from — don't reintroduce
  the legacy `innerHTML` XSS surface).
- **Types:** `npm run typecheck` must pass. No `any`; let Zod infer types.
- **Data fetching:** always through a `useQuery` hook, never bare `fetch` in a component.
- **Parity:** match the legacy panel's numbers/labels. When the legacy code reads a field
  several ways (`memberCount ?? members`), keep the fallbacks.

## Legacy panel → endpoint map (migration backlog, 3F-2)

| Legacy `renderX` | Endpoint(s) | Status |
|---|---|---|
| `renderKpis` / `renderHero` (TG) | `/api/tg/full` | ✅ done (PoC) |
| `renderHistory` / `renderHeatmap` / `renderVelocity` | `/api/history/*`, `/api/tg/mtproto/graphs\|velocity` | todo |
| `renderPosts` | `/api/tg/mtproto/posts\|post_stats\|thumb` | todo |
| `renderTg` / `renderTgAnalytics` / `renderHashtags` / `renderDigest` | `/api/tg/*`, `mtproto/stats\|views_summary` | todo |
| `renderMentions` | `/api/tg/mtproto/mentions`, `/api/history/mentions` | todo |
| switcher / settings / admin / bug-tracker | `/api/channels*`, `/api/admin/users`, `/api/bugs*`, `/api/prefs` | todo |
| auth / landing / chrome shell | `/api/auth/*` | todo (structural) |
