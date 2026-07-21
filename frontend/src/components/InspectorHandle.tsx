import { useEffect, useRef, useState } from 'react';

/**
 * Ручка-разделитель метрик-эксплорера (Astryx Resize Handle, канон-редакция): тянет ширину правой
 * панели инспектора. Ширина живёт CSS-переменной `--inspector-w` на :root — сетки эксплореров
 * (TG и IG) ссылаются на неё в grid-cols, поэтому хостам не нужны хуки, а перетаскивание
 * обновляет обе поверхности без ре-рендера контента. Персист в localStorage; до первого
 * перетаскивания у каждой поверхности свой выверенный дефолт (TG 280 / IG 300) через фолбэк var().
 *
 * A11y: role=separator (vertical) с клавиатурой — ←/→ по 16px (← шире: ручка у левого края
 * панели), Home/End к пределам; двойной клик/Enter-сброс возвращает дефолты обеих поверхностей.
 */
const STORAGE_KEY = 'pulse_inspector_w';
const MIN_W = 240;
const MAX_W = 460;
const STEP = 16;

const clampW = (value: number): number => Math.min(MAX_W, Math.max(MIN_W, Math.round(value)));

function applyRootWidth(px: number | null): void {
  const root = document.documentElement;
  if (px == null) root.style.removeProperty('--inspector-w');
  else root.style.setProperty('--inspector-w', `${px}px`);
}

function loadStored(): number | null {
  try {
    const raw = Number.parseInt(localStorage.getItem(STORAGE_KEY) ?? '', 10);
    return Number.isFinite(raw) ? clampW(raw) : null;
  } catch {
    return null;
  }
}

export function InspectorHandle({ defaultWidth = 300 }: { defaultWidth?: number }) {
  // null = пользователь не кастомизировал (поверхности живут своими дефолтами).
  const [width, setWidth] = useState<number | null>(loadStored);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);

  // Синхронизируем :root при монтировании (и после reset'а) — источник истины один.
  useEffect(() => {
    applyRootWidth(width);
  }, [width]);

  const commit = (next: number | null) => {
    setWidth(next);
    try {
      if (next == null) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      /* приватный режим — ширина просто не переживёт reload */
    }
  };

  const effective = width ?? defaultWidth;

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Ширина панели инспектора"
      aria-valuemin={MIN_W}
      aria-valuemax={MAX_W}
      aria-valuenow={effective}
      tabIndex={0}
      data-testid="inspector-handle"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragRef.current = { startX: event.clientX, startW: effective };
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (!drag) return;
        // Ручка стоит слева от панели: движение ВЛЕВО делает панель шире.
        applyRootWidth(clampW(drag.startW + (drag.startX - event.clientX)));
      }}
      onPointerUp={(event) => {
        const drag = dragRef.current;
        dragRef.current = null;
        if (!drag) return;
        commit(clampW(drag.startW + (drag.startX - event.clientX)));
      }}
      onPointerCancel={() => {
        dragRef.current = null;
        applyRootWidth(width);
      }}
      onDoubleClick={() => commit(null)}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft') commit(clampW(effective + STEP));
        else if (event.key === 'ArrowRight') commit(clampW(effective - STEP));
        else if (event.key === 'Home') commit(MAX_W);
        else if (event.key === 'End') commit(MIN_W);
        else if (event.key === 'Enter') commit(null);
        else return;
        event.preventDefault();
      }}
      className="group absolute inset-y-0 z-10 hidden w-3 cursor-col-resize touch-none items-center justify-center focus-visible:outline-hidden lg:flex"
      style={{ right: `calc(var(--inspector-w, ${defaultWidth}px) + 8px)` }}
    >
      <span
        aria-hidden="true"
        className="h-full w-px bg-transparent transition-colors group-hover:bg-border group-focus-visible:bg-primary/60 group-active:bg-primary/60"
      />
    </div>
  );
}
