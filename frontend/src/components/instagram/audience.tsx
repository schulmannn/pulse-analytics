import { useRef, useState } from 'react';
import { fmt } from '@/lib/format';
import { ChartTooltip, type TooltipState } from '@/components/ChartTooltip';
import { EmptyChart } from '@/components/instagram/shared';
import { ChartSection } from '@/components/ChartWidget';
import { WidgetGroup } from '@/components/widgets/WidgetGroup';
import { breakdownVariants, reorderDefault } from '@/components/widgets/variants';
import type { IgBreakdowns, IgOnline } from '@/api/schemas';
import {
  aggregateOnline,
  igAgeItems,
  igGenderItems,
  igCountryItems,
  igCityItems,
  DAY_NAMES,
} from '@/lib/igMetrics';

export function AudienceBlock({ breakdowns, followers }: { breakdowns: IgBreakdowns | undefined; followers: number }) {
  // Shared derivations (igMetrics): the card and each /metrics/ig-* full page read the SAME math, so
  // their numbers/labels can never diverge. Country/city are full ranked lists here — the card keeps
  // its top-N preview slice, the full page shows all.
  const ageItems = igAgeItems(breakdowns);
  const genderItems = igGenderItems(breakdowns);
  const countryItems = igCountryItems(breakdowns).slice(0, 8);
  const cityItems = igCityItems(breakdowns).slice(0, 8);

  const covered = ageItems.reduce((acc, a) => acc + a.value, 0);
  const coverage = followers > 0 && covered > 0 ? covered / followers : 1;

  return (
    <div className="space-y-6">
      {/* One WidgetGroup keeps the four demographic cards on the shared dashboard grid. Whole-card
          click drills to a dedicated /metrics/ig-* page instead of the generic ?detail= overlay. */}
      <WidgetGroup id="ig-audience" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
        {ageItems.length > 0 ? (
          // Возраст default = столбцы (упорядоченные бакеты читаются гистограммой).
          <ChartSection title="Возраст" drillTo="/metrics/ig-age" variants={reorderDefault(breakdownVariants(ageItems), 'bar')} />
        ) : (
          <ChartSection title="Возраст" drillTo="/metrics/ig-age">
            <EmptyChart />
          </ChartSection>
        )}
        <ChartSection title="Пол" drillTo="/metrics/ig-gender" variants={breakdownVariants(genderItems)} />
        <ChartSection title="Топ стран" drillTo="/metrics/ig-countries" variants={breakdownVariants(countryItems)} />
        <ChartSection title="Топ городов" drillTo="/metrics/ig-cities" variants={breakdownVariants(cityItems)} />
      </WidgetGroup>
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
