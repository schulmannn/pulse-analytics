import { useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { SIZE_RANK } from '@/components/widgets/variants';
import type { WidgetSize } from '@/lib/widgetPrefsStore';
import { stepWidgetSize, widgetResizeTarget, widgetSizeWidths } from './widgetResize';

const SIZE_LABEL: Record<WidgetSize, string> = {
  third: 'S',
  half: 'M',
  full: 'L',
};

interface ResizeGesture {
  pointerId: number;
  startX: number;
  startSize: WidgetSize;
  containerWidth: number;
  columnGap: number;
  lastSize: WidgetSize;
  section: HTMLElement;
  previousWidth: string;
  previousZIndex: string;
}

export function WidgetResizeHandle({
  label,
  size,
  minSize,
  onResize,
}: {
  label: string;
  size: WidgetSize;
  minSize: WidgetSize;
  onResize: (size: WidgetSize) => void;
}) {
  const gesture = useRef<ResizeGesture | null>(null);
  const [resizing, setResizing] = useState(false);

  const begin = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    event.stopPropagation();
    const section = event.currentTarget.closest('section');
    // Home wraps config cards in `display: contents` migration shells, so parentElement is not
    // necessarily the measuring grid. Resolve the explicit WidgetGroup root instead.
    const grid = section?.closest('[data-widget-group-root]') as HTMLElement | null;
    if (!grid || !section) return;
    const style = getComputedStyle(grid);
    const columnGap = Number.parseFloat(style.columnGap) || 0;
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startSize: size,
      containerWidth: grid.clientWidth,
      columnGap,
      lastSize: size,
      section,
      previousWidth: section.style.width,
      previousZIndex: section.style.zIndex,
    };
    section.dataset.widgetResizing = '';
    section.style.zIndex = '25';
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // A touch can disappear before capture; pointercancel still performs the same cleanup.
    }
    setResizing(true);
  };

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    const widths = widgetSizeWidths(active.containerWidth, active.columnGap);
    const desired = Math.max(
      widths[minSize],
      Math.min(widths.full, widths[active.startSize] + event.clientX - active.startX),
    );
    // The grid still snaps semantically to S/M/L, but the card edge itself tracks the pointer
    // continuously during the gesture. Crossing a midpoint reflows neighbours to the next slot;
    // pointer-up drops the temporary width and lands exactly on that slot.
    active.section.style.width = `${desired}px`;
    const next = widgetResizeTarget({
      startSize: active.startSize,
      minSize,
      deltaX: event.clientX - active.startX,
      containerWidth: active.containerWidth,
      columnGap: active.columnGap,
    });
    if (next === active.lastSize) return;
    active.lastSize = next;
    onResize(next);
  };

  const end = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    gesture.current = null;
    active.section.style.width = active.previousWidth;
    active.section.style.zIndex = active.previousZIndex;
    delete active.section.dataset.widgetResizing;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setResizing(false);
  };

  return (
    <div
      role="slider"
      tabIndex={0}
      aria-label={`Изменить размер виджета «${label}»`}
      aria-orientation="horizontal"
      aria-valuemin={SIZE_RANK[minSize]}
      aria-valuemax={SIZE_RANK.full}
      aria-valuenow={SIZE_RANK[size]}
      aria-valuetext={SIZE_LABEL[size]}
      title={`Размер ${SIZE_LABEL[size]} — потяните за угол`}
      data-widget-resize-handle
      data-resizing={resizing ? '' : undefined}
      className="group/resize absolute -bottom-2 -right-2 z-20 hidden size-11 cursor-nwse-resize touch-none select-none items-end justify-end rounded-br-2xl focus-visible:outline-hidden lg:flex"
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onKeyDown={(event) => {
        const direction =
          event.key === 'ArrowRight' || event.key === 'ArrowUp'
            ? 1
            : event.key === 'ArrowLeft' || event.key === 'ArrowDown'
              ? -1
              : null;
        if (direction == null) return;
        event.preventDefault();
        event.stopPropagation();
        const next = stepWidgetSize(size, minSize, direction);
        if (next !== size) onResize(next);
      }}
    >
      <span
        aria-hidden="true"
        className="mb-0.5 mr-0.5 size-6 rounded-br-[14px] border-b-[5px] border-r-[5px] border-muted-foreground/65 transition-colors group-hover/resize:border-foreground/80 group-focus-visible/resize:border-primary group-data-[resizing]/resize:border-primary"
      />
    </div>
  );
}
