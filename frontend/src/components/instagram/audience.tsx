import { useRef, useState } from 'react';
import { fmt } from '@/lib/format';
import { ChartTooltip, type TooltipState } from '@/components/ChartTooltip';
import { Breakdown } from '@/components/Breakdown';
import { EmptyChart } from '@/components/instagram/shared';
import { ChartSection } from '@/components/ChartWidget';
import { RadialShare } from '@/components/RadialShare';
import { WidgetGroup } from '@/components/widgets/WidgetGroup';
import type { IgBreakdowns, IgOnline } from '@/api/schemas';
import {
  aggregateOnline,
  igAgeItems,
  igGenderItems,
  igCountryItems,
  igCityItems,
  DAY_NAMES,
} from '@/lib/igMetrics';
import { useScrollEdgeFade } from '@/lib/useScrollEdgeFade';

export function AudienceBlock({ breakdowns, followers }: { breakdowns: IgBreakdowns | undefined; followers: number }) {
  // Shared derivations (igMetrics): the card and each /metrics/ig-* full page read the SAME math, so
  // their numbers/labels can never diverge. Country/city are full ranked lists here — the card keeps
  // its top-N preview slice, the full page shows all.
  const ageItems = igAgeItems(breakdowns);
  const genderItems = igGenderItems(breakdowns);
  const allCountries = igCountryItems(breakdowns);
  const allCities = igCityItems(breakdowns);
  const countryItems = allCountries.slice(0, 8);
  const cityItems = allCities.slice(0, 8);

  const covered = ageItems.reduce((acc, a) => acc + a.value, 0);
  const coverage = followers > 0 && covered > 0 ? covered / followers : 1;
  // Плотные строки возраста: значение + доля от суммы бакетов, тихий одноцветный трек (без
  // радужного мини-доната — «выглядит дёшево», владелец). Цвета категорий здесь не несут смысла.
  const ageRows = ageItems.map(({ label, value }) => ({
    label,
    value,
    display: covered > 0 ? `${fmt.num(value)} · ${((value / covered) * 100).toFixed(1)}%` : fmt.num(value),
  }));
  // Гео-строки: доля — от ПОЛНОГО рейтинга (не от показанной восьмёрки), значение компактом.
  const geoRows = (all: typeof allCountries, shown: typeof allCountries) => {
    const total = all.reduce((acc, i) => acc + i.value, 0);
    return shown.map(({ label, value }) => ({
      label,
      value,
      display: total > 0 ? `${fmt.short(value)} · ${((value / total) * 100).toFixed(1)}%` : fmt.short(value),
    }));
  };
  const countryRows = geoRows(allCountries, countryItems);
  const cityRows = geoRows(allCities, cityItems);

  return (
    <div className="space-y-6">
      {/* One WidgetGroup keeps the four demographic cards on the shared dashboard grid. Whole-card
          click drills to a dedicated /metrics/ig-* page instead of the generic ?detail= overlay. */}
      <WidgetGroup id="ig-audience" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
        <ChartSection title="Возраст" drillTo="/metrics/ig-age">
          {ageRows.length > 0 ? <Breakdown items={ageRows} /> : <EmptyChart />}
        </ChartSection>
        {/* Полукольцо (выбор владельца) — та же форма, что «Пол» Метрики: фикс-набор долей целого;
            непокрытый демографией остаток кольцо честно дорисует из total приглушённым сегментом. */}
        {genderItems.length > 0 ? (
          <ChartSection title="Пол" drillTo="/metrics/ig-gender">
            <RadialShare
              segments={genderItems.map((g) => ({ key: g.label, label: g.label, value: g.value }))}
              total={followers > 0 ? followers : null}
              unitWord="подписчиков"
              centerCaption="подписчиков"
              format={(v) => fmt.short(v)}
            />
          </ChartSection>
        ) : (
          <ChartSection title="Пол" drillTo="/metrics/ig-gender">
            <EmptyChart />
          </ChartSection>
        )}
        {/* Гео — фикс-строки той же плотности, что «Возраст» (виз-переключатель с мини-донатом
            убран — «выглядит дёшево», владелец): значение · доля от полного рейтинга. */}
        <ChartSection title="Топ стран" drillTo="/metrics/ig-countries">
          {countryRows.length > 0 ? <Breakdown items={countryRows} /> : <EmptyChart />}
        </ChartSection>
        <ChartSection title="Топ городов" drillTo="/metrics/ig-cities">
          {cityRows.length > 0 ? <Breakdown items={cityRows} /> : <EmptyChart />}
        </ChartSection>
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
  const scrollFadeRef = useScrollEdgeFade<HTMLDivElement>();
  const { grid, max, best, hasSignal } = aggregateOnline(online);

  if (!hasSignal) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Instagram не предоставил почасовую активность аудитории для этого аккаунта (метрика доступна не всегда и требует 100+ подписчиков).
      </p>
    );
  }

  const showCellTip = (
    cell: HTMLButtonElement,
    w: number,
    h: number,
    value: number,
    pointer?: { x: number; y: number },
  ) => {
    const wrapRect = wrapRef.current?.getBoundingClientRect();
    if (!wrapRect) return;
    const cellRect = cell.getBoundingClientRect();
    setTip({
      x: pointer?.x ?? cellRect.left - wrapRect.left + cellRect.width / 2,
      y: pointer?.y ?? cellRect.top - wrapRect.top,
      text: `${DAY_NAMES[w]} ${h}:00 · ${fmt.short(value)} онлайн`,
    });
  };

  return (
    <div ref={wrapRef} className="relative">
      <div ref={scrollFadeRef} className="scroll-fade-x overflow-x-auto pb-2">
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
                const cellLabel = `${name}, ${h}:00 — ${fmt.short(v)} онлайн${
                  isBest ? ', лучший слот' : ''
                }`;
                return (
                  <button
                    key={h}
                    type="button"
                    data-heatmap-cell={`${w}-${h}`}
                    tabIndex={isBest ? 0 : -1}
                    aria-label={cellLabel}
                    aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown"
                    className={`flex h-4 cursor-pointer items-center justify-center rounded-sm p-0 transition-[background-color] dur-base ease-house focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary${isBest ? ' border-2 border-verdant' : ' border-0'}`}
                    style={{
                      backgroundColor: `hsl(var(--brand-iris) / ${opacity})`,
                    }}
                    onMouseMove={(event) => {
                      const rect = wrapRef.current?.getBoundingClientRect();
                      if (rect) {
                        showCellTip(event.currentTarget, w, h, v, {
                          x: event.clientX - rect.left,
                          y: event.clientY - rect.top,
                        });
                      }
                    }}
                    onMouseLeave={() => setTip(null)}
                    onFocus={(event) => showCellTip(event.currentTarget, w, h, v)}
                    onBlur={() => setTip(null)}
                    onClick={(event) => showCellTip(event.currentTarget, w, h, v)}
                    onKeyDown={(event) => {
                      let nextW = w;
                      let nextH = h;
                      if (event.key === 'ArrowLeft') nextH = Math.max(0, h - 1);
                      else if (event.key === 'ArrowRight') nextH = Math.min(23, h + 1);
                      else if (event.key === 'ArrowUp') nextW = Math.max(0, w - 1);
                      else if (event.key === 'ArrowDown') nextW = Math.min(DAY_NAMES.length - 1, w + 1);
                      else return;
                      event.preventDefault();
                      wrapRef.current
                        ?.querySelector<HTMLButtonElement>(`[data-heatmap-cell="${nextW}-${nextH}"]`)
                        ?.focus();
                    }}
                  >
                    {isBest && (
                      <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="hsl(var(--primary-foreground))" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
      <ChartTooltip tip={tip} />
      <div className="mt-3 text-xs font-medium text-muted-foreground">
        лучший слот: <strong className="font-medium text-foreground">{DAY_NAMES[best.w]} {best.h}:00</strong>
      </div>
    </div>
  );
}
