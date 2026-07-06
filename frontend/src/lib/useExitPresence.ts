import { useEffect, useRef, useState } from 'react';

/**
 * Presence with an EXIT beat — keeps a node mounted for `exitMs` after `active` flips false, so it
 * can play a leave animation instead of teleporting out. Steep-like edit-mode choreography: the card
 * «×» controls fade/scale OUT when «Готово» is pressed rather than vanishing the instant the mode
 * closes ("remove buttons не размонтировать мгновенно, а дать exit opacity/scale").
 *
 * Returns `{ mounted, exiting }`:
 *   active = true          → mounted=true,  exiting=false  (render the enter state)
 *   active flips → false   → mounted=true,  exiting=true   (play the exit animation for exitMs)
 *   after exitMs           → mounted=false, exiting=false  (unmounted)
 *
 * Re-activating mid-exit cancels the pending unmount. This is the deliberate hand-rolled stand-in for
 * framer's <AnimatePresence> (framer is landing-only per DESIGN_TOKENS.md); the exit itself is a CSS
 * animation on `home-remove-exit`, so the global prefers-reduced-motion cap already collapses it —
 * pass `exitMs=0` under reduced motion so the unmount is immediate too.
 */
export function useExitPresence(active: boolean, exitMs: number): { mounted: boolean; exiting: boolean } {
  const [mounted, setMounted] = useState(active);
  const [exiting, setExiting] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (active) {
      // (Re)entered — cancel any pending unmount and show the enter state.
      if (timer.current != null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      setExiting(false);
      setMounted(true);
      return;
    }
    // Deactivated: nothing to animate out if it was never on screen.
    if (!mounted) return;
    setExiting(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setMounted(false);
      setExiting(false);
    }, exitMs);
    return () => {
      if (timer.current != null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [active, exitMs, mounted]);

  return { mounted, exiting };
}
