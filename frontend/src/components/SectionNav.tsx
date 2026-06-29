import { useEffect, useRef } from 'react';
import { useScrollSpy } from '@/lib/useScrollSpy';

export interface Section {
  id: string;
  label: string;
  group?: string;
}

/**
 * Sticky in-page section tabs. Highlights the section in view (useScrollSpy), scrolls to a
 * section on click, keeps the active tab auto-centered (horizontal-only, never touches the
 * page's vertical scroll), fades the overflow edges, and draws thin dividers between groups.
 * Focus ring is inset so it isn't clipped by the edge mask. Sticks under the top bar (top-14).
 */
export function SectionNav({ sections }: { sections: readonly Section[] }) {
  const active = useScrollSpy(sections.map((s) => s.id));
  const navRef = useRef<HTMLElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);

  // Center the active tab within the nav by scrolling the nav horizontally only.
  useEffect(() => {
    const nav = navRef.current;
    const btn = activeRef.current;
    if (!nav || !btn) return;
    const target = btn.offsetLeft - nav.clientWidth / 2 + btn.clientWidth / 2;
    nav.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
  }, [active]);

  const go = (id: string) =>
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  return (
    <div className="sticky top-14 z-10 mb-8 border-b bg-background/85 backdrop-blur">
      <nav
        ref={navRef}
        aria-label="Разделы"
        className="flex items-center gap-1 overflow-x-auto py-2 [mask-image:linear-gradient(to_right,transparent,black_1.25rem,black_calc(100%-1.25rem),transparent)] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {sections.map((s, i) => {
          const isActive = active === s.id;
          const newGroup = i > 0 && !!s.group && s.group !== sections[i - 1].group;
          return (
            <span key={s.id} className="flex items-center">
              {newGroup && <span aria-hidden="true" className="mx-1.5 h-4 w-px shrink-0 bg-border" />}
              <button
                ref={isActive ? activeRef : undefined}
                type="button"
                onClick={() => go(s.id)}
                aria-current={isActive ? 'true' : undefined}
                className={`shrink-0 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus-visible:ring-inset focus-visible:ring-offset-0 ${
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                }`}
              >
                {s.label}
              </button>
            </span>
          );
        })}
      </nav>
    </div>
  );
}
