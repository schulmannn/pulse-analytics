import { smoothSvgPath } from '@/lib/format';

/**
 * Спарклайн-В-СТРОКЕ — элемент «текста-с-данными» нарративного слоя: крошечная линия ряда,
 * сидящая в предложении на базовой линии текста («…ниже предыдущей ↘.»). Рисует в
 * --chart-role-primary (наследует акцент виджета), точка на последнем значении; чисто
 * декоративен для AT (данные уже в тексте) — aria-hidden.
 */
export function InlineSpark({ values, width = 92, height = 20 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const pad = 2;
  const step = (width - pad * 2) / (values.length - 1);
  const y = (v: number) => height - pad - (v / max) * (height - pad * 2);
  const points = values.map((value, index) => ({ x: pad + index * step, y: y(value) }));
  const last = points[points.length - 1];
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      data-chart-curve="smooth"
      className="mx-0.5 inline-block align-[-4px]"
    >
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
    </svg>
  );
}
