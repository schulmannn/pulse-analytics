import { useScrollSpy } from '@/lib/useScrollSpy';

export interface Section {
  id: string;
  label: string;
}

/**
 * Sticky in-page section tabs for the scrollable Overview. Highlights the section in view
 * via useScrollSpy and scrolls to a section on click. Sticks just under the app top bar
 * (top-14 ≈ the 56px topbar); sections must carry scroll-mt to clear both sticky bars.
 */
export function SectionNav({ sections }: { sections: readonly Section[] }) {
  const active = useScrollSpy(sections.map((s) => s.id));

  const go = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="sticky top-14 z-10 mb-8 border-b bg-background">
      <nav className="flex gap-1 overflow-x-auto py-2" aria-label="Разделы обзора">
        {sections.map((s) => {
          const isActive = active === s.id;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => go(s.id)}
              aria-current={isActive ? 'true' : undefined}
              className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-primary/15 text-foreground'
                  : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
              }`}
            >
              {s.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
