import { useCallback, useRef, useState } from 'react';
import { fmt } from '@/lib/format';

/**
 * Составное полукольцо: доли фиксированного малого набора категорий плюс ИТОГ в центре.
 *
 * Геометрия с shadcn/charts (radial → «Stacked»): дуга от 180° до 0°, кольцо между внутренним и
 * внешним радиусом в отношении 80/110, сегменты со скруглёнными торцами, суммарное число и его
 * подпись в центре через PolarRadiusAxis→Label. Библиотеку не берём (см. ShareRows: recharts —
 * 107.7 KB gzip при 15.9 KB свободных в гейте); дуга это два arc-сегмента в path, здесь она
 * посчитана руками.
 *
 * КОГДА ЭТО УМЕСТНО. Только фиксированный малый набор взаимоисключающих категорий, дающих 100%
 * (устройства, пол, возрастные группы). Ранжированный список переменной длины — это ShareRows:
 * кольцо на тридцати источниках превращается в нечитаемую радугу, а «первые три дают 93%» по нему
 * не прочитать. Полукольцо отвечает на «из чего состоит целое», список — на «сколько каждого».
 *
 * ЧЕСТНОСТЬ. Итог в центре — сумма ПОКАЗАННЫХ сегментов. Если сервер дал итог полного отчёта
 * (`total`), берём его и дорисовываем серый остаток: иначе кольцо утверждало бы, что показанные
 * категории и есть всё, хотя часть визитов Метрика скрывает при малой выборке.
 */

export interface RadialSegment {
  key: string;
  label: string;
  value: number;
}

const VB = 240;
const CX = VB / 2;
const CY = 130;
const R_OUT = 110;
const R_IN = 80;
const GAP_DEG = 1.6;

/** Точка на окружности: 180° — левый край полукольца, 0° — правый (как у shadcn startAngle=180). */
function polar(r: number, deg: number) {
  const rad = (deg * Math.PI) / 180;
  return { x: CX + r * Math.cos(rad), y: CY - r * Math.sin(rad) };
}

/** Кольцевой сегмент от `from` до `to` градусов (идём по убыванию: 180 → 0). */
function ringPath(from: number, to: number): string {
  const large = Math.abs(from - to) > 180 ? 1 : 0;
  const oStart = polar(R_OUT, from);
  const oEnd = polar(R_OUT, to);
  const iEnd = polar(R_IN, to);
  const iStart = polar(R_IN, from);
  return [
    `M ${oStart.x} ${oStart.y}`,
    `A ${R_OUT} ${R_OUT} 0 ${large} 1 ${oEnd.x} ${oEnd.y}`,
    `L ${iEnd.x} ${iEnd.y}`,
    `A ${R_IN} ${R_IN} 0 ${large} 0 ${iStart.x} ${iStart.y}`,
    'Z',
  ].join(' ');
}

export function RadialShare({
  segments,
  total = null,
  unitWord,
  centerCaption,
  format = fmt.num,
}: {
  segments: RadialSegment[];
  /** Итог ПОЛНОГО отчёта. null → сумма сегментов (тогда остатка нет по построению). */
  total?: number | null;
  /** Слово для подписи центра и легенды: «визитов». */
  unitWord: string;
  /** Подпись под числом в центре (по умолчанию — unitWord). */
  centerCaption?: string;
  format?: (n: number) => string;
}) {
  const [hover, setHover] = useState<string | null>(null);
  const detachSvgListeners = useRef<(() => void) | null>(null);
  // The arcs are passive parts of one named graphic. Pointer hover only mirrors a value already
  // present in the persistent legend, so event delegation belongs on the DOM node rather than
  // turning every decorative path into a fake focusable control.
  const bindSvg = useCallback((node: SVGSVGElement | null) => {
    detachSvgListeners.current?.();
    detachSvgListeners.current = null;
    if (!node) return;
    const handleMove = (event: PointerEvent) => {
      const target = event.target instanceof Element
        ? event.target.closest<SVGPathElement>('[data-radial-segment]')
        : null;
      const key = target?.dataset.radialSegment ?? null;
      setHover((current) => (current === key ? current : key));
    };
    const clearHover = () => setHover(null);
    node.addEventListener('pointermove', handleMove);
    node.addEventListener('pointerleave', clearHover);
    detachSvgListeners.current = () => {
      node.removeEventListener('pointermove', handleMove);
      node.removeEventListener('pointerleave', clearHover);
    };
  }, []);

  // Граница компонента не пропускает отрицательные/NaN/Infinity в SVG-геометрию. Ноль честно
  // означает отсутствие сегмента; невалидный `total` не превращает path в `NaN`, а возвращает
  // построение к сумме валидных показанных значений.
  const shown = segments
    .map((segment) => ({
      ...segment,
      value: Number.isFinite(segment.value) ? Math.max(0, segment.value) : 0,
    }))
    .filter((segment) => segment.value > 0)
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  const shownSum = shown.reduce((acc, s) => acc + s.value, 0);
  if (!shown.length || !Number.isFinite(shownSum) || shownSum <= 0) return null;
  const safeTotal = total != null && Number.isFinite(total) && total >= 0 ? total : null;
  const whole = Math.max(shownSum, safeTotal ?? 0);
  if (!Number.isFinite(whole) || whole <= 0) return null;

  // Остаток — то, что сервер посчитал в итоге, но не отнёс ни к одной категории (Метрика скрывает
  // демографию при малой выборке). Рисуем его приглушённым, а не растягиваем сегменты на 100%.
  const rest = Math.max(0, whole - shownSum);
  const parts = rest > 0
    ? [...shown, { key: '__rest', label: 'Не определено', value: rest }]
    : shown;

  let cursor = 180;
  const arcs = parts.map((p, i) => {
    const span = (p.value / whole) * 180;
    const from = cursor;
    const to = cursor - span;
    cursor = to;
    const gap = i < parts.length - 1 ? Math.min(GAP_DEG, span / 3) : 0;
    return {
      ...p,
      d: ringPath(from, Math.min(from, to + gap)),
      pct: (p.value / whole) * 100,
      // Последовательная шкала одного тона, а не категориальная палитра: сегменты УПОРЯДОЧЕНЫ по
      // величине, и разные тона этот порядок прячут — 60% и 3% выглядят одинаково заметными.
      // Ступеней пять; шестая и далее держат последнюю (различает их подпись в легенде, не цвет).
      color: p.key === '__rest'
        ? 'hsl(var(--muted-foreground) / 0.35)'
        : `hsl(var(--chart-seq-${Math.min(i + 1, 5)}))`,
    };
  });

  const active = arcs.find((a) => a.key === hover) ?? null;
  const totalCaption = centerCaption ?? unitWord;
  const label = `Всего ${format(whole)} ${totalCaption}. Состав: ${arcs
    .map((a) => `${a.label} — ${format(a.value)} ${unitWord}, ${a.pct.toFixed(1)}%`)
    .join('; ')}`;

  // Легенда фикс-тайла компактится по канону ShareRows: топ-4 построчно + сводный хвост «Ещё N».
  // Без этого 7 возрастных групп съедали высоту тайла, и flex-1 регион дуги схлопывался в
  // крошечное кольцо (владелец: «график стал слишком маленьким»). Дуга рисует ВСЕ сегменты,
  // hover/центр читают каждый, aria-label перечисляет всё — сжимается только легенда.
  const LEGEND_MAX = 4;
  const legendShown = arcs.slice(0, LEGEND_MAX);
  const legendRest = arcs.slice(LEGEND_MAX);
  const legendRestSum = legendRest.reduce((acc, a) => acc + a.value, 0);
  const legendRestPct = legendRest.reduce((acc, a) => acc + a.pct, 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* min-h держит кольцо читаемым независимо от числа строк легенды. */}
      <div className="relative min-h-[104px] flex-1">
        {/* aria-label вместо svg <title>: у <title> есть побочный нативный браузерный тултип —
            нестилизуемый прямоугольник с острыми углами (канон: только свои скруглённые читалки). */}
        <svg
          ref={bindSvg}
          viewBox={`0 0 ${VB} ${CY + 14}`}
          className="h-full w-full"
          role="img"
          aria-label={label}
          focusable="false"
        >
          {arcs.map((a) => (
            <path
              key={a.key}
              data-radial-segment={a.key}
              d={a.d}
              fill={a.color}
              opacity={hover && hover !== a.key ? 0.4 : 1}
              className="transition-opacity dur-base ease-house"
              focusable="false"
            />
          ))}
          {/* Итог в центре — как Label внутри PolarRadiusAxis у shadcn. На наведении подменяется
              значением сегмента: одно место для числа, а не второй читалки сбоку. */}
          <text x={CX} y={CY - 26} textAnchor="middle" className="fill-foreground text-2xl font-medium tabular-nums">
            {active ? format(active.value) : format(whole)}
          </text>
          <text x={CX} y={CY - 6} textAnchor="middle" className="fill-muted-foreground text-2xs">
            {active ? `${active.label} · ${active.pct.toFixed(1)}%` : (centerCaption ?? unitWord)}
          </text>
        </svg>
      </div>
      {/* Легенда — постоянная доступная читалка дуги: touch/keyboard не зависят от mouse hover,
          а сырое значение не теряется за одним процентом. На 320/390px остаётся одна колонка. */}
      <ul
        aria-label="Легенда состава"
        className="mt-1 grid min-w-0 grid-cols-1 gap-x-3 gap-y-1 text-2xs sm:grid-cols-2"
      >
        {legendShown.map((a) => (
          <li
            key={a.key}
            className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-1.5"
          >
            <span
              aria-hidden="true"
              className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
              style={{ backgroundColor: a.color }}
            />
            <span className="min-w-0 truncate text-muted-foreground" title={a.label}>{a.label}</span>
            <span className="col-start-2 min-w-0 tabular-nums text-foreground">
              <span className="font-medium">{format(a.value)} {unitWord}</span>
              <span className="text-muted-foreground"> · {a.pct.toFixed(1)}%</span>
            </span>
          </li>
        ))}
        {legendRest.length > 0 && (
          <li
            className="min-w-0 truncate text-muted-foreground"
            title={legendRest.map((a) => a.label).join(', ')}
          >
            Ещё {legendRest.length} · {format(legendRestSum)} {unitWord} · {legendRestPct.toFixed(1)}%
          </li>
        )}
      </ul>
    </div>
  );
}
