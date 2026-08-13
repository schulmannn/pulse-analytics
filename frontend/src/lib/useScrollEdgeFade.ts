import { useCallback, useEffect, useRef } from 'react';

type MutableElementRef<T> = { current: T | null };

export function scrollEdgeFadeState({
  scrollLeft,
  scrollWidth,
  clientWidth,
}: Pick<HTMLElement, 'scrollLeft' | 'scrollWidth' | 'clientWidth'>): { start: boolean; end: boolean } {
  const maxScroll = scrollWidth - clientWidth;
  if (maxScroll <= 1) return { start: false, end: false };
  return { start: scrollLeft > 1, end: scrollLeft < maxScroll - 1 };
}

/**
 * Marks a horizontal scroller with the edges that still contain hidden content. The paired CSS
 * mask is purely visual: no overlay, blur or pointer interception. A callback ref handles shells
 * that mount only after loading/empty states.
 */
export function useScrollEdgeFade<T extends HTMLElement>(forwardedRef?: MutableElementRef<T>) {
  const cleanupRef = useRef<(() => void) | null>(null);

  const ref = useCallback(
    (element: T | null) => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (forwardedRef) forwardedRef.current = element;
      if (!element) return;

      let frame = 0;
      const update = () => {
        frame = 0;
        const state = scrollEdgeFadeState(element);
        element.toggleAttribute('data-fade-start', state.start);
        element.toggleAttribute('data-fade-end', state.end);
      };
      const schedule = () => {
        if (frame === 0) frame = window.requestAnimationFrame(update);
      };

      element.addEventListener('scroll', schedule, { passive: true });
      window.addEventListener('resize', schedule, { passive: true });
      const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
      resizeObserver?.observe(element);
      if (element.firstElementChild instanceof HTMLElement) resizeObserver?.observe(element.firstElementChild);
      schedule();

      cleanupRef.current = () => {
        element.removeEventListener('scroll', schedule);
        window.removeEventListener('resize', schedule);
        resizeObserver?.disconnect();
        if (frame !== 0) window.cancelAnimationFrame(frame);
      };
    },
    [forwardedRef],
  );

  useEffect(() => () => cleanupRef.current?.(), []);
  return ref;
}
