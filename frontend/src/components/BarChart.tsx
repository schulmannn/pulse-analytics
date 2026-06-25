interface BarChartProps {
  values: number[];
  labels?: string[];
  titles?: string[];
  height?: number;
}

export function BarChart({ values, labels, titles, height = 200 }: BarChartProps) {
  if (!values || values.length === 0) {
    return (
      <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
        Нет данных
      </div>
    );
  }

  const max = Math.max(...values, 1);
  const chartWidth = 600;
  const chartHeight = height;
  const paddingBottom = labels && labels.length > 0 ? 24 : 0;
  const graphHeight = chartHeight - paddingBottom;

  const itemWidth = chartWidth / values.length;
  const barWidth = itemWidth * 0.7;
  const barGap = itemWidth * 0.3;

  return (
    <svg
      className="h-auto w-full"
      viewBox={`0 0 ${chartWidth} ${chartHeight}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {values.map((val, i) => {
        const barHeight = (val / max) * graphHeight;
        const x = i * itemWidth + barGap / 2;
        const y = graphHeight - barHeight;

        // Показывать подписи выборочно (первая, последняя, каждая вторая), чтобы избежать наложения
        const showLabel = labels?.[i] && (i === 0 || i === values.length - 1 || i % 2 === 0);

        return (
          <g key={i}>
            <title>{titles?.[i] ?? `${labels?.[i] ?? ''}: ${val}`}</title>
            <rect
              x={x}
              y={y}
              width={barWidth}
              height={Math.max(barHeight, 2)}
              fill="hsl(var(--brand-iris))"
              rx={2}
            />
            {showLabel && (
              <text
                x={x + barWidth / 2}
                y={chartHeight - 6}
                textAnchor="middle"
                className="select-none fill-muted-foreground text-[11px] font-medium"
              >
                {labels?.[i]}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
