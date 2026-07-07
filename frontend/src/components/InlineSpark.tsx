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
  const pts = values.map((v, i) => `${(pad + i * step).toFixed(1)},${y(v).toFixed(1)}`);
  const [lx, ly] = pts[pts.length - 1].split(',');
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      className="mx-0.5 inline-block align-[-4px]"
    >
      <polyline
        fill="none"
        stroke="hsl(var(--chart-role-primary))"
        strokeWidth="1.6"
        vectorEffect="non-scaling-stroke"
        points={pts.join(' ')}
      />
      <circle cx={lx} cy={ly} r="2.2" fill="hsl(var(--chart-role-primary))" />
    </svg>
  );
}
