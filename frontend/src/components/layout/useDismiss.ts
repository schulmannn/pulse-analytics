import { useEffect } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';

/** Close a popover/dropdown on Escape, and (when a ref is given) on outside mousedown.
    Outside-click via a document listener instead of a scrim avoids stacking-context traps.
    `triggerRef` (optional) gets focus back on Escape — the focused popover content unmounts, and
    without the restore a keyboard user re-Tabs from the top of the shell. On outside mousedown the
    restore fires only when focus is INSIDE the popover (never steal from the clicked target). */
export function useDismiss(
  active: boolean,
  setOpen: Dispatch<SetStateAction<boolean>>,
  ref?: RefObject<HTMLElement | null>,
  triggerRef?: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef?.current?.focus();
      }
    };
    const onDown = ref
      ? (e: MouseEvent) => {
          if (ref.current && !ref.current.contains(e.target as Node)) {
            setOpen(false);
            if (triggerRef?.current && ref.current.contains(document.activeElement)) triggerRef.current.focus();
          }
        }
      : null;
    document.addEventListener('keydown', onKey);
    if (onDown) document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (onDown) document.removeEventListener('mousedown', onDown);
    };
  }, [active, setOpen, ref, triggerRef]);
}
