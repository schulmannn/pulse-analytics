import { smoothSvgPath } from '@/lib/format';

/**
 * Спарклайн-В-СТРОКЕ — элемент «текста-с-данными» нарративного слоя: крошечная линия ряда,
 * сидящая в предложении на базовой линии текста («…ниже предыдущей. ↘ Главный вклад…»); пунктуацию
 * за собой не тянет — предложение закрывается точкой ДО неё, а зазор вокруг дают настоящие пробелы
 * соседних сегментов, а не margin (см. narrative.ts). Рисует в
 * --chart-role-primary (наследует акцент виджета), точка на последнем значении; чисто
 * декоративен для AT (данные уже в тексте) — aria-hidden.
 *
 * ДОМЕН — ПО ДАННЫМ, А НЕ ОТ НУЛЯ (аудит #554, D17). Прежний `max(...values, 1)` строил шкалу от
 * нуля: доля около 30% ± 3 превращалась в плоскую линию у верхней трети, то есть искра рисовала
 * УРОВЕНЬ, который и так написан числом рядом, вместо ФОРМЫ, ради которой её и ставят. На 16px
 * высоты и 30 точках это читалось зигзагом-каракулей в «Качестве трафика» Метрики.
 */

/** Ниже этой доли размаха от уровня ряд считается плоским: рисовать там нечего. */
const FLAT_SPREAD_RATIO = 0.005;
/** Плотнее одной точки на столько пикселей — сглаживаем скользящим окном, иначе каша. */
const DENSE_POINT_PX = 4;
const SMOOTH_WINDOW = 3;

/** Скользящее среднее по трём точкам: убирает дневной шум, сохраняя направление недели. */
function smoothSeries(values: number[]): number[] {
  if (values.length < SMOOTH_WINDOW) return values;
  const half = Math.floor(SMOOTH_WINDOW / 2);
  return values.map((_, i) => {
    const from = Math.max(0, i - half);
    const to = Math.min(values.length - 1, i + half);
    let sum = 0;
    for (let k = from; k <= to; k++) sum += values[k];
    return sum / (to - from + 1);
  });
}

export function InlineSpark({ values, width = 92, height = 20 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return null;

  // Слишком много точек на пиксель — сглаживаем: 30 дневных значений на 72px дают шаг 2.4px,
  // и кубическая интерполяция по ним рисует зигзаг вместо тренда.
  const dense = finite.length > width / DENSE_POINT_PX;
  const series = dense ? smoothSeries(finite) : finite;

  const min = Math.min(...series);
  const max = Math.max(...series);
  const spread = max - min;
  const level = Math.max(Math.abs(max), Math.abs(min), 1);
  // Ряд без динамики: линия была бы прямой, а прямая в тексте читается как зачёркивание.
  if (spread / level < FLAT_SPREAD_RATIO) return null;

  const pad = 2;
  const plot = Math.max(height - pad * 2, 1);
  const step = (width - pad * 2) / (series.length - 1);
  const y = (v: number) => height - pad - ((v - min) / spread) * plot;
  const points = series.map((value, index) => ({ x: pad + index * step, y: y(value) }));
  const last = points[points.length - 1];
  // Stable data signature for the reveal (see index.css «Chart motion») — the tiny line fades in when
  // its series changes; keyed on content so it never replays on a re-render with the same values.
  const motionKey = values.join(',');
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      data-chart-curve="smooth"
      data-spark-smoothed={dense ? '' : undefined}
      className="mx-0.5 inline-block align-[-4px]"
    >
      <g key={motionKey} data-chart-motion="reveal">
        <path
          fill="none"
          stroke="hsl(var(--chart-role-primary))"
          strokeWidth="1.6"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
          strokeLinecap="round"
          d={smoothSvgPath(points, 1)}
        />
        <circle cx={last.x} cy={last.y} r="2.2" fill="hsl(var(--chart-role-primary))" />
      </g>
    </svg>
  );
}
