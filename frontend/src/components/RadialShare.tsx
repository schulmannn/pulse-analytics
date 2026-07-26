import { useId, useState } from 'react';
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
  const gradId = useId();
  const [hover, setHover] = useState<string | null>(null);

  const shown = segments.filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
  const shownSum = shown.reduce((acc, s) => acc + s.value, 0);
  const whole = Math.max(shownSum, total ?? 0);
  if (!shown.length || whole <= 0) return null;

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
  const label = `Состав: ${arcs.map((a) => `${a.label} ${a.pct.toFixed(0)}%`).join(', ')}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative min-h-0 flex-1">
        <svg viewBox={`0 0 ${VB} ${CY + 14}`} className="h-full w-full" role="img" aria-label={label}>
          <title id={gradId}>{label}</title>
          {arcs.map((a) => (
            <path
              key={a.key}
              d={a.d}
              fill={a.color}
              opacity={hover && hover !== a.key ? 0.4 : 1}
              className="transition-opacity dur-base ease-house"
              onMouseEnter={() => setHover(a.key)}
              onMouseLeave={() => setHover((h) => (h === a.key ? null : h))}
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
      {/* Легенда: свотч, подпись, доля (charts/tooltip). Она же — доступная альтернатива дуге. */}
      <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-2xs">
        {arcs.map((a) => (
          <li key={a.key} className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-[2px]" style={{ backgroundColor: a.color }} />
            <span className="text-muted-foreground">{a.label}</span>
            <span className="font-medium tabular-nums text-foreground">{a.pct.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
