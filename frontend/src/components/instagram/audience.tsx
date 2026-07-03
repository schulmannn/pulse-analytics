import { useRef, useState } from 'react';
import { fmt } from '@/lib/format';
import { ChartTooltip, type TooltipState } from '@/components/ChartTooltip';
import { EmptyChart } from '@/components/instagram/shared';
import { ChartSection, breakdownVariants, reorderDefault } from '@/components/ChartWidget';
import type { IgBreakdowns, IgOnline } from '@/api/schemas';
import {
  tvBreakdown,
  aggregateOnline,
  cityName,
  countryName,
  GENDER_LABEL,
  AGE_ORDER,
  CHART_CYCLE,
  DAY_NAMES,
} from '@/lib/igMetrics';

export function AudienceBlock({ breakdowns, followers }: { breakdowns: IgBreakdowns | undefined; followers: number }) {
  const ageRaw = tvBreakdown(breakdowns?.data, 'follower_demographics', 'age');
  const age = AGE_ORDER.map((bucket) => ageRaw.find((a) => a.label === bucket)).filter(Boolean) as { label: string; value: number }[];
  const gender = tvBreakdown(breakdowns?.data, 'follower_demographics', 'gender');
  const countries = tvBreakdown(breakdowns?.data, 'follower_demographics', 'country').sort((a, b) => b.value - a.value).slice(0, 8);
  const cities = tvBreakdown(breakdowns?.data, 'follower_demographics', 'city').sort((a, b) => b.value - a.value).slice(0, 8);

  const covered = age.reduce((acc, a) => acc + a.value, 0);
  const coverage = followers > 0 && covered > 0 ? covered / followers : 1;

  // Every demographic widget goes through breakdownVariants — the full presentation set
  // (Список/Столбцы/Круговая/Столбцы+значения) + the edit-dialog carousel, like TG widgets.
  const ageItems = age.map((a) => ({ label: a.label, value: a.value, display: fmt.short(a.value) }));
  const genderItems = gender
    .sort((a, b) => b.value - a.value)
    .map((g, i) => ({
      label: GENDER_LABEL[g.label] ?? g.label,
      value: g.value,
      display: fmt.short(g.value),
      color: CHART_CYCLE[i % CHART_CYCLE.length],
    }));
  const countryItems = countries.map((c) => ({ label: countryName(c.label), value: c.value, display: fmt.short(c.value) }));
  const cityItems = cities.map((c) => ({ label: cityName(c.label), value: c.value, display: fmt.short(c.value) }));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        {ageItems.length > 0 ? (
          // Возраст default = столбцы (упорядоченные бакеты читаются гистограммой).
          <ChartSection title="Возраст" variants={reorderDefault(breakdownVariants(ageItems), 'bar')} />
        ) : (
          <ChartSection title="Возраст">
            <EmptyChart />
          </ChartSection>
        )}
        <ChartSection title="Пол" variants={breakdownVariants(genderItems)} />
      </div>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ChartSection title="Топ стран" variants={breakdownVariants(countryItems)} />
        <ChartSection title="Топ городов" variants={breakdownVariants(cityItems)} />
      </div>
      {coverage < 0.98 && (
        <p className="px-1 text-2xs text-muted-foreground/70">
          Охвачено ≈{Math.round(coverage * 100)}% аудитории — Instagram показывает только топ-сегменты.
        </p>
      )}
    </div>
  );
}

/**
 * Best-time heatmap. The Instagram-Login API's online_followers metric is frequently empty (empty
 * hour maps) — when there's no real activity we show an honest empty state instead of a faded grid
 * or a fabricated "best slot".
 */
export function BestTimeHeatmap({ online }: { online: IgOnline | undefined }) {
  const [tip, setTip] = useState<TooltipState>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { grid, max, best, hasSignal } = aggregateOnline(online);

  if (!hasSignal) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Instagram не предоставил почасовую активность аудитории для этого аккаунта (метрика доступна не всегда и требует 100+ подписчиков).
      </p>
    );
  }

  return (
    <div ref={wrapRef} className="relative" onMouseLeave={() => setTip(null)}>
      <div className="overflow-x-auto pb-2">
        <div className="min-w-full space-y-[2px] lg:min-w-[440px]">
          <div className="grid gap-[2px]" style={{ gridTemplateColumns: '30px repeat(24, minmax(14px, 1fr))' }}>
            <div />
            {Array.from({ length: 24 }).map((_, h) => (
              <div key={h} className="select-none text-center text-2xs font-medium text-muted-foreground">
                {h % 3 === 0 ? `${h}` : ''}
              </div>
            ))}
          </div>
          {DAY_NAMES.map((name, w) => (
            <div key={w} className="grid items-center gap-[2px]" style={{ gridTemplateColumns: '30px repeat(24, minmax(14px, 1fr))' }}>
              <div className="select-none text-2xs font-medium text-muted-foreground">{name}</div>
              {Array.from({ length: 24 }).map((_, h) => {
                const v = grid[w][h];
                const opacity = max > 0 ? Math.max(0.06, v / max) : 0;
                const isBest = best.w === w && best.h === h;
                return (
                  <div
                    key={h}
                    className={`flex h-4 cursor-pointer items-center justify-center rounded-sm${isBest ? ' border-2 border-verdant' : ''}`}
                    style={{
                      backgroundColor: 'hsl(var(--brand-iris))',
                      opacity,
                    }}
                    aria-label={isBest ? `Лучший слот: ${name} ${h}:00` : undefined}
                    onMouseMove={(event) => {
                      const rect = wrapRef.current?.getBoundingClientRect();
                      if (rect) setTip({ x: event.clientX - rect.left, y: event.clientY - rect.top, text: `${name} ${h}:00 · ${fmt.short(v)} онлайн` });
                    }}
                  >
                    {isBest && (
                      <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="hsl(var(--primary-foreground))" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <ChartTooltip tip={tip} />
      <div className="mt-3 text-xs font-medium text-muted-foreground">
        лучший слот: <strong className="text-foreground">{DAY_NAMES[best.w]} {best.h}:00</strong>
      </div>
    </div>
  );
}
