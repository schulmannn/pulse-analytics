import { useEffect, useState } from 'react';
import { pickActiveSection } from '@/lib/scrollspy';
import type { ScrollSpyEntry } from '@/lib/scrollspy';

export function useScrollSpy(ids: string[]): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);
  const idsKey = ids.join('\u0000');

  useEffect(() => {
    setActiveId(null);
    if (!idsKey || typeof IntersectionObserver === 'undefined') return;

    const observedIds = idsKey.split('\u0000');
    const entriesById = new Map<string, ScrollSpyEntry>();
    const elements = observedIds
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element != null);

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          const id = (entry.target as HTMLElement).id;
          entriesById.set(id, {
            id,
            top: entry.boundingClientRect.top,
            ratio: entry.isIntersecting ? entry.intersectionRatio : 0,
          });
        });
        setActiveId(pickActiveSection([...entriesById.values()]));
      },
      { threshold: [0, 0.25, 0.5, 0.75, 1] },
    );

    elements.forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [idsKey]);

  return activeId;
}
