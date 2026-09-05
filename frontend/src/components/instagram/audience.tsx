import { useRef, useState } from 'react';
import { fmt, pluralRu } from '@/lib/format';
import { ChartTooltip, type TooltipState } from '@/components/ChartTooltip';
import { Breakdown } from '@/components/Breakdown';
import { EmptyState } from '@/components/EmptyState';
import { HeatmapVerdict } from '@/components/HeatmapVerdict';
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
  // Значение и доля больше НЕ склеиваются здесь вручную: склейка шла мимо formatShare и печатала
  // «71.0%» там, где канон печатает «71%», а страница разбора той же демографии доли не знала вовсе.
  // Теперь доля приходит со слоя данных (igMetrics → withShares) и живёт в СВОЕЙ колонке.
  // Срез топ-8 доли не пересчитывает: они от ПОЛНОГО рейтинга, и сумма видимых честно меньше 100%.

  return (
    <div className="space-y-6">
      {/* One WidgetGroup keeps the four demographic cards on the shared dashboard grid. Whole-card
          click drills to a dedicated /metrics/ig-* page instead of the generic ?detail= overlay. */}
      <WidgetGroup id="ig-audience" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
        <ChartSection title="Возраст" drillTo="/metrics/ig-age">
          {ageItems.length > 0 ? (
            <Breakdown items={ageItems} columns={{ label: 'Возраст', value: 'Подписчики' }} />
          ) : (
            <EmptyChart />
          )}
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
            убран — «выглядит дёшево», владелец): ранг, подпись, значение и доля от полного
            рейтинга — каждое в своей колонке. Футер ведёт на полный список: «+N ещё» называл
            спрятанное, но идти за ним было некуда. */}
        <ChartSection title="Топ стран" drillTo="/metrics/ig-countries">
          {countryItems.length > 0 ? (
            <Breakdown
              items={countryItems}
              columns={{ label: 'Страна', value: 'Подписчики' }}
              ranked
              more={{
                label: `Все ${allCountries.length} ${pluralRu(allCountries.length, ['страна', 'страны', 'стран'])}`,
                to: '/metrics/ig-countries',
              }}
            />
          ) : (
            <EmptyChart />
          )}
        </ChartSection>
        <ChartSection title="Топ городов" drillTo="/metrics/ig-cities">
          {cityItems.length > 0 ? (
            <Breakdown
              items={cityItems}
              columns={{ label: 'Город', value: 'Подписчики' }}
              ranked
              more={{
                label: `Все ${allCities.length} ${pluralRu(allCities.length, ['город', 'города', 'городов'])}`,
                to: '/metrics/ig-cities',
              }}
            />
          ) : (
            <EmptyChart />
          )}
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
  const { grid, max, best, quiet, hasSignal } = aggregateOnline(online);

  if (!hasSignal) {
    // Причина не изменилась — изменилась форма: карточка держит свой силуэт (столбцы почасовой
    // активности) вместо полосы воздуха, как и остальные пустые карточки продукта.
    return (
      <EmptyState
        compact
        size="chart"
        ghost="bars"
        title="Нет почасовой активности"
        reason="Instagram не предоставил почасовую активность аудитории для этого аккаунта (метрика доступна не всегда и требует 100+ подписчиков)."
      />
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
      {/* Вердикт ВЫШЕ сетки: ответ раньше доказательства (см. HeatmapVerdict). «Тише всего» у этой
          карточки не было вовсе — бледная клетка не отличает «мало» от «нет данных». */}
      <HeatmapVerdict
        peak={{ day: DAY_NAMES[best.w] ?? '', hour: best.h, value: `${fmt.short(best.v)} онлайн` }}
        quiet={quiet ? { day: DAY_NAMES[quiet.w] ?? '', hour: quiet.h, value: `${fmt.short(quiet.v)} онлайн` } : null}
      />
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
    </div>
  );
}
