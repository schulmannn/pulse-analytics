// DOM-reading runtime helpers shared by the chart UPDATE-morph loops (components/MorphingSeries.tsx
// for the full LineChart, components/Sparkline.tsx for the inline micro-charts). Kept OUT of
// lib/chartMorph.ts — that module is documented side-effect-free (pure geometry the RAF loop and the
// unit tests call), whereas these two touch `window`/`document`. One source of truth so the morph's
// duration and the reduced-motion gate stay identical across every chart surface.

/** Morph duration — mirrors the `--motion-morph` token (a RAF loop can't read the CSS var mid-frame). */
const MORPH_MS_FALLBACK = 700;

/**
 * Parse a CSS <time> into milliseconds, honouring the unit. ПРОД-ГРАБЛЯ: минификатор CSS сжимает
 * `700ms` → `.7s` (короче на символ), а голый parseFloat читал это как 0.7 МИЛЛИСЕКУНДЫ — морф
 * завершался первым же кадром, и в проде «перетекания» не было ни у кого, при живом dev-стенде
 * (неминифицированный CSS). Юнит-тест закрепляет оба написания. Невалидное/неположительное → null.
 */
export function parseCssDurationMs(raw: string): number | null {
  const value = raw.trim();
  const num = Number.parseFloat(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return /ms\s*$/i.test(value) ? num : /s\s*$/i.test(value) ? num * 1000 : num;
}

export function readMorphMs(): number {
  if (typeof window === 'undefined') return MORPH_MS_FALLBACK;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--motion-morph');
  return parseCssDurationMs(raw) ?? MORPH_MS_FALLBACK;
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}
