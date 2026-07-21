// DOM-reading runtime helpers shared by the chart UPDATE-morph loops (components/MorphingSeries.tsx
// for the full LineChart, components/Sparkline.tsx for the inline micro-charts). Kept OUT of
// lib/chartMorph.ts — that module is documented side-effect-free (pure geometry the RAF loop and the
// unit tests call), whereas these two touch `window`/`document`. One source of truth so the morph's
// duration and the reduced-motion gate stay identical across every chart surface.

/** Morph duration — mirrors the `--motion-morph` token (a RAF loop can't read the CSS var mid-frame). */
const MORPH_MS_FALLBACK = 1500;

export function readMorphMs(): number {
  if (typeof window === 'undefined') return MORPH_MS_FALLBACK;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--motion-morph');
  const ms = Number.parseFloat(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : MORPH_MS_FALLBACK;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
