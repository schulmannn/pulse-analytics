import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { ComparisonDelta } from '@/components/metric/comparisonDelta';

/**
 * Строка читалки: метка (с точкой цвета серии) слева, величина справа.
 *
 * `delta` печатается ВТОРОЙ строкой под величиной — оценочной, со стрелкой ▲/▼ и цветом
 * (ComparisonDelta). Прежде дельта приходила ОТДЕЛЬНОЙ строкой с меткой «Δ», и греческая буква
 * читалась как посторонний значок (владелец: «сейчас у нас какой то треугольник»). Цвет здесь
 * канону не противоречит: он разрешён ровно одной оценочной дельте сравнения периодов, а это она.
 *
 * `sub` — приписка под меткой (дата прошлого окна). `mark` различает роль: сплошная точка у
 * измеренных серий, ПОЛОЕ кольцо у цели — она не измерена, а назначена человеком.
 */
export type TooltipRow = {
  label: string;
  value: string;
  color?: string;
  sub?: string;
  delta?: number;
  mark?: 'dot' | 'ring';
};
/** Either a plain `text` readout (legacy callers) or a structured `title` + `rows` card (series
 *  charts showing current vs comparison). `rows` wins when present. */
export type TooltipState =
  | { x: number; y: number; text?: string; title?: string; rows?: TooltipRow[] }
  | null;

/**
 * Делегированный hover-читатель для DOM-хитмапов (не-SVG сетки ячеек): вешает pointer-обработчики
 * на relative-обёртку (`wrapRef`), читает текст из ближайшего `[data-heatmap-tip]` и отдаёт
 * TooltipState в координатах обёртки для {@link ChartTooltip}. Вынесен из TG-хитмапа активности
 * (panels/Charts.tsx) — один канонный скруглённый тултип вместо нативного HTML `title`
 * (нестилизуемый острый прямоугольник). Ячейки остаются пассивными (никаких фокус-целей на
 * каждый час) — hover лишь дублирует то, что aria-label ячейки уже даёт AT. Тултип гасится над
 * пустыми ячейками, при прокрутке и потере фокуса — mouseleave при колесе не срабатывает
 * (канон BarChart/PieChart, дизайн-проход №3).
 */
export function useHeatmapTip(): { wrapRef: RefObject<HTMLDivElement | null>; tip: TooltipState } {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tip, setTip] = useState<TooltipState>(null);
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const clear = () => setTip(null);
    const move = (event: PointerEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>('[data-heatmap-tip]')
        : null;
      const text = target && wrap.contains(target) ? target.dataset.heatmapTip : null;
      if (!text) {
        clear();
        return;
      }
      const rect = wrap.getBoundingClientRect();
      setTip({ x: event.clientX - rect.left, y: event.clientY - rect.top, text });
    };
    wrap.addEventListener('pointermove', move);
    wrap.addEventListener('pointerleave', clear);
    return () => {
      wrap.removeEventListener('pointermove', move);
      wrap.removeEventListener('pointerleave', clear);
    };
  }, []);
  const hasTip = tip !== null;
  useEffect(() => {
    if (!hasTip) return;
    const clear = () => setTip(null);
    window.addEventListener('scroll', clear, true);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('blur', clear);
    };
  }, [hasTip]);
  return { wrapRef, tip };
}

/** Floating readout for the SVG charts — anchored to a point inside a `relative` chart
    container. Placed above the anchor and flipped below when it would clip the container's
    top edge; clamped horizontally to the container bounds. It never escapes the chart
    upward, and its z-10 keeps it under the sticky app header (z-sticky+), so it can't cover
    the page chrome. Shows instantly on hover (vs. the slow native SVG <title>). */
export function ChartTooltip({ tip, appearance = 'default' }: { tip: TooltipState; appearance?: 'default' | 'rhea' | 'comparison' }) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0, cw: 0, ch: 0 });
  // The tooltip fades in on mount and GLIDES between points via the shared [data-chart-tooltip]
  // transform transition (index.css). But the very first (measured) frame moves the box by half its
  // width as the clamp resolves from an unmeasured origin — with the transition live that would read
  // as an unwanted slide-in. So the glide is armed one frame AFTER the tooltip appears: the first
  // placement snaps (transition suppressed inline), every subsequent point-to-point move glides.
  const hasTip = tip !== null;
  const [glide, setGlide] = useState(false);
  useEffect(() => {
    if (!hasTip) {
      setGlide(false);
      return;
    }
    const id = requestAnimationFrame(() => setGlide(true));
    return () => cancelAnimationFrame(id);
  }, [hasTip]);

  // Re-measure after every render: the text (and thus the box) changes per hovered point,
  // and the offsetParent is the chart container whose width we clamp against.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const parent = el.offsetParent as HTMLElement | null;
    const cw = parent?.clientWidth ?? 0;
    const ch = parent?.clientHeight ?? 0;
    setBox((prev) =>
      prev.w === w && prev.h === h && prev.cw === cw && prev.ch === ch ? prev : { w, h, cw, ch },
    );
  });

  if (!tip) return null;

  const compact = appearance !== 'default';

  const gap = 10;
  const measured = box.w > 0 && box.h > 0;
  const half = box.w / 2;
  const clampX = (x: number) =>
    measured && box.cw > 0
      ? Math.min(Math.max(x, half + 2), Math.max(box.cw - half - 2, half + 2))
      : x;
  // Above the anchor by default; flip below when clipped by the container's top edge.
  const fitsAbove = tip.y - gap - box.h >= 0;
  // На НИЗКОМ плоте (компактная карточка третьей ширины: тултип ~40px в поле ~150px) флип вниз
  // клал непрозрачную плашку прямо на столбцы — соседние бары пропадали под ней, и карточка
  // читалась как «график недорисован» (владелец, прод-скриншоты «Реакции» / «Ср. охват»).
  // Здесь плашка вместо этого прижимается к ВЕРХУ плота (полоса над самым высоким столбцом
  // почти всегда пуста) и уходит вбок от курсора, освобождая наведённую колонку. У высоких
  // хостов (метрик-страница, развёртка) места хватает и поведение прежнее.
  const lowHost = box.ch > 0 && box.ch < 220;
  const dodge = !fitsAbove && lowHost;
  const top = fitsAbove ? tip.y - gap - box.h : dodge ? 0 : tip.y + gap;
  const sideRight = tip.x + gap + box.w <= box.cw - 2;
  const cx = clampX(dodge ? tip.x + (sideRight ? gap + half : -(gap + half)) : tip.x);

  // ⚠️ Позиция ТОЛЬКО через transform + ширина w-max (не left/top): у absolute-элемента
  // shrink-to-fit ширина зависит от `left` (доступное место до правого края контейнера), а left
  // здесь сам вычисляется из измеренной ширины (cx − half). Эта взаимозависимость у края при
  // неудачной длине строк не сходится — текст перескакивает между двумя переносами, layout-effect
  // ставит box заново, и React падает с #185 «Maximum update depth exceeded» (прод-краши w-1-4jty
  // donut «Вовлечённость по формату» и home-velocity — общий тултип всех графиков). transform не
  // участвует в layout, w-max фиксирует ширину от контента → измерение сходится за один проход.
  return (
    <div
      ref={ref}
      data-chart-tooltip
      data-chart-tooltip-appearance={appearance}
      className={`pointer-events-none absolute left-0 top-0 z-10 w-max border bg-popover/98 px-3 py-2.5 text-xs font-medium leading-snug text-popover-foreground backdrop-blur-xs ${
        compact
          ? 'min-w-[148px] max-w-[220px] rounded-xl border-foreground/10 shadow-[0_10px_30px_rgba(0,0,0,0.14)] dark:border-white/10 dark:shadow-[0_14px_36px_rgba(0,0,0,0.4)]'
          // rounded-xl и у default-подачи (владелец, 2026-08-14: «острые углы → закруглённое всё») —
          // один радиус на обе подачи тултипа.
          : 'max-w-[240px] rounded-xl border-border shadow-[0_12px_32px_rgba(0,0,0,0.22)] dark:border-white/10 dark:shadow-[0_14px_36px_rgba(0,0,0,0.48)]'
      } ${
        // На низком плоте плашка неизбежно стоит НАД столбцами: тогда она сжимается по контенту
        // («8 авг.: 354» ≈ 110px вместо 176px) и закрывает вдвое меньше соседних баров.
        // Ширина зависит от ХОСТА, а не от наведённой точки, поэтому при движении курсора
        // геометрия не прыгает (см. предупреждение выше про #185).
        compact || lowHost ? '' : 'min-w-[176px]'
      }`}
      style={{ transform: `translate(${cx - half}px, ${Math.max(top, 0)}px)`, visibility: measured ? 'visible' : 'hidden', transition: glide ? undefined : 'none' }}
    >
      {tip.rows ? (
        <>
          {tip.title && <div data-chart-tooltip-title className="mb-2 whitespace-nowrap text-xs font-medium text-foreground">{tip.title}</div>}
          <div className="space-y-1">
            {tip.rows.map((r, i) => (
              <div key={i} data-chart-tooltip-row className="flex items-start justify-between gap-4 whitespace-nowrap">
                <span className="flex min-w-0 items-start gap-1.5 text-muted-foreground">
                  {r.color && (
                    <span
                      aria-hidden="true"
                      className={
                        compact
                          ? 'mt-0.5 h-2.5 w-2.5 shrink-0 rounded-[3px]'
                          : 'mt-1 h-2 w-2 shrink-0 rounded-full'
                      }
                      // Кольцо у назначенной величины (цель), заливка — у измеренной: точка
                      // говорит «столько было», кольцо — «столько хотели».
                      style={
                        r.mark === 'ring'
                          ? { border: `1.5px solid ${r.color}` }
                          : { backgroundColor: r.color }
                      }
                    />
                  )}
                  <span className="min-w-0">
                    {r.label}
                    {r.sub && <span className="block text-2xs text-muted-foreground/80">{r.sub}</span>}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block tabular-nums text-foreground">{r.value}</span>
                  {r.delta != null && Number.isFinite(r.delta) && (
                    // Формат и оценочность — по умолчанию модуля: тот же один знак после запятой,
                    // что у всех дельт продукта. Передавать их отдельно значило бы держать в
                    // читалке собственную версию правила.
                    <ComparisonDelta delta={r.delta} className="text-2xs" />
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : (
        tip.text
      )}
    </div>
  );
}
