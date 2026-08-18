import { cn } from '@/lib/utils';

/**
 * Спидометр-дуга 240° (волна «слабых виджетов», 2026-08-18; референс Amicro Speedometer Arc,
 * взята форма — не код): скруглённый трек, заливка «часть от целого» цветом серии, маркер-точка
 * на конце заливки (язык концевой точки Sparkline), крупное число в центре.
 *
 * История формы: у «Динамики оттока» когда-то был красно-зелёный ДОНАТ — аудит снял его за
 * оценочные цвета и за «единственную круговую в продукте». Оба довода устарели (RadialShare
 * давно в проде; дуга МОНОХРОМНА — доли различает позиция и трек, не цвет), владелец вернул
 * круговую форму референсом.
 *
 * Механика: один и тот же path трека и заливки, заливка режется stroke-dasharray; смена доли
 * перетекает transition'ом по канону (dur-base + ease-house). viewBox масштабируется РАВНОМЕРНО
 * (meet) — окружность остаётся окружностью, non-scaling-stroke не нужен.
 */
export function GaugeArc({
  share,
  centerValue,
  centerLabel,
  ariaLabel,
  className,
}: {
  /** Доля заливки 0..1 (часть от целого — например, подписки в валовом движении). */
  share: number;
  centerValue: string;
  centerLabel?: string;
  /** Полное словесное описание для AT — svg остаётся одним именованным графиком. */
  ariaLabel: string;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(1, share));
  // Геометрия: центр (100, 100), радиус 78, дуга 240° от 210° к −30° (просвет снизу).
  const R = 78;
  const CX = 100;
  const CY = 100;
  const SWEEP = 240;
  const START = 210; // градусы, отсчёт от оси X против часовой
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const point = (deg: number) => ({
    x: CX + R * Math.cos(rad(deg)),
    y: CY - R * Math.sin(rad(deg)),
  });
  const start = point(START);
  const end = point(START - SWEEP);
  // Одна большая дуга по часовой (sweep-flag 1), large-arc для 240° всегда 1.
  const arcPath = `M ${start.x.toFixed(2)} ${start.y.toFixed(2)} A ${R} ${R} 0 1 1 ${end.x.toFixed(2)} ${end.y.toFixed(2)}`;
  const arcLen = (rad(SWEEP) * R);
  const fillLen = arcLen * clamped;
  const tip = point(START - SWEEP * clamped);
  return (
    <div className={cn('relative mx-auto w-full max-w-56', className)}>
      <svg viewBox="0 0 200 148" role="img" aria-label={ariaLabel} className="block w-full">
        {/* Трек — тихая подложка целого. */}
        <path d={arcPath} fill="none" stroke="hsl(var(--muted))" strokeWidth={16} strokeLinecap="round" />
        {/* Заливка — доля цветом серии; смена окна перетекает по канону. */}
        <path
          d={arcPath}
          fill="none"
          stroke="hsl(var(--chart-role-primary))"
          strokeWidth={16}
          strokeLinecap="round"
          strokeDasharray={`${fillLen.toFixed(2)} ${(arcLen + 40).toFixed(2)}`}
          className="transition-[stroke-dasharray] dur-base ease-house"
        />
        {/* Маркер конца заливки — язык концевой точки Sparkline: солид-точка с кольцом фона. */}
        <circle cx={tip.x} cy={tip.y} r={5.5} fill="hsl(var(--card))" />
        <circle cx={tip.x} cy={tip.y} r={3.5} fill="hsl(var(--chart-role-primary))" className="transition-[cx,cy] dur-base ease-house" />
      </svg>
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-[38%] flex flex-col items-center gap-0.5 text-center">
        <div className="text-2xl font-medium leading-none tabular-nums tracking-tight text-foreground">{centerValue}</div>
        {centerLabel ? <div className="text-2xs text-muted-foreground">{centerLabel}</div> : null}
      </div>
    </div>
  );
}
