import { fmt } from '@/lib/format';
import { KpiValue } from '@/components/chartWidget/KpiValue';

/**
 * Кольцевой прогресс с числом в центре — форма shadcn «Radial Chart – Text», посчитанная руками
 * (Recharts не берём: bundle-гейт; см. RadialShare — тот же подход для полукольца долей).
 *
 * ЧЕСТНОСТЬ: дуга — ДОЛЯ ОТ ИЗВЕСТНОГО ЦЕЛОГО (0..1): «% от цели», «доля повторных покупателей».
 * Метрика без естественного 100% (ER, охват) сюда не подходит — дуга против выдуманного максимума
 * была бы декорацией. Начало — 12 часов, по часовой; >100% дуга честно останавливается на полном
 * круге, а превышение называет caption («124% от цели»). Тон — тихий канон: трек из --border,
 * дуга в --chart-role-primary (наследует акцент карточки), без градиентов и оценочных цветов.
 */
export function RadialGauge({
  fraction,
  value,
  label,
  caption,
  size = 148,
}: {
  /** Доля целого 0..1 (может быть >1 — дуга клампится, текст остаётся честным). */
  fraction: number;
  /** Крупное число в центре (уже отформатированное). */
  value: string;
  /** Подпись под числом («от цели», «повторных»). */
  label?: string;
  /** Строка под кольцом (например «124% от цели» при переполнении). */
  caption?: string;
  size?: number;
}) {
  const safe = Number.isFinite(fraction) ? Math.max(0, fraction) : 0;
  const shown = Math.min(1, safe);
  const stroke = 10;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  // Полный круг при shown=1 — без щели округлых торцов (linecap round добавляет по полрадиуса).
  const dash = shown >= 1 ? c : Math.max(0.001, shown * c - (shown > 0 ? stroke : 0));
  const pct = Math.round(safe * 100);
  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-2">
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          viewBox={`0 0 ${size} ${size}`}
          width={size}
          height={size}
          role="img"
          aria-label={`${value}${label ? ` ${label}` : ''} — ${pct}%`}
          className="-rotate-90"
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="hsl(var(--border) / 0.6)"
            strokeWidth={stroke}
          />
          {shown > 0 && (
            // Дуга ПЕРЕТЕКАЕТ при смене значения (канон Chart motion): длина штриха — одно число,
            // CSS-переход на stroke-dasharray дешевле RAF-морфа и гаснет под reduced-motion
            // глобальной сетью. Появление (mount) честно снапает — переходить не с чего.
            <circle
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke="hsl(var(--chart-role-primary))"
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${dash} ${c}`}
              className="transition-[stroke-dasharray] dur-reveal ease-house"
            />
          )}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          {/* Размер зависит от диаметра кольца, но рецепт числа — общий (KpiValue), иначе центр
              кольца жил бы по своим правилам набора. */}
          <KpiValue
            size={size < 132 ? 'small' : 'compact'}
            text={value}
            className="text-foreground"
          />
          {label && <span className="mt-0.5 text-2xs text-muted-foreground">{label}</span>}
        </div>
      </div>
      {caption && <p className="text-2xs text-muted-foreground">{caption}</p>}
    </div>
  );
}

/** «N% от цели» → доля для дуги + честный caption (переполнение остаётся в тексте). */
export function targetGauge(targetPct: number): { fraction: number; caption: string } {
  return { fraction: targetPct / 100, caption: `${fmt.num(Math.round(targetPct))}% от цели` };
}
