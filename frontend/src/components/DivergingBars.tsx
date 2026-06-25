interface DivergingBarsProps {
  values: number[];
  titles?: string[];
  height?: number;
}

/** Bars around a horizontal zero-line (positive up = iris, negative down = ember). */
export function DivergingBars({ values, titles, height }: DivergingBarsProps) {
  if (!values || values.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Нет данных
      </div>
    );
  }

  const h = height ?? 120;
  const mid = h / 2;
  const maxAbs = Math.max(1, ...values.map((v) => Math.abs(v)));

  const totalWidth = 600;
  const step = totalWidth / values.length;
  const barWidth = step * 0.7;
  const gap = step * 0.3;

  return (
    <svg className="h-auto w-full" viewBox={`0 0 ${totalWidth} ${h}`}>
      <line x1={0} y1={mid} x2={totalWidth} y2={mid} stroke="hsl(var(--border))" strokeWidth="1.5" />
      {values.map((v, i) => {
        const bh = Math.max(1, (Math.abs(v) / maxAbs) * (mid - 4));
        const x = i * step + gap / 2;
        const y = v >= 0 ? mid - bh : mid;
        const fill = v >= 0 ? 'hsl(var(--brand-iris))' : 'hsl(var(--brand-ember))';
        return (
          <g key={i}>
            {titles && <title>{titles[i]}</title>}
            <rect x={x} y={y} width={barWidth} height={bh} fill={fill} rx={1} />
          </g>
        );
      })}
    </svg>
  );
}
