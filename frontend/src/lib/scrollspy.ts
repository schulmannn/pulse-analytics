export interface ScrollSpyEntry {
  id: string;
  top: number;
  ratio: number;
}

export function pickActiveSection(entries: ScrollSpyEntry[]): string | null {
  const visible = entries
    .map((entry, index) => ({ ...entry, index }))
    .filter((entry) => entry.ratio > 0 && Number.isFinite(entry.ratio) && Number.isFinite(entry.top));

  if (visible.length === 0) return null;

  visible.sort((a, b) => {
    if (a.ratio !== b.ratio) return b.ratio - a.ratio;
    if (Math.abs(a.top) !== Math.abs(b.top)) return Math.abs(a.top) - Math.abs(b.top);
    return a.index - b.index;
  });

  return visible[0]?.id ?? null;
}
