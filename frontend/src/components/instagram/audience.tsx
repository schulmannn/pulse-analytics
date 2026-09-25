import { useRef, useState } from 'react';
import { fmt, pluralRu } from '@/lib/format';
import { ChartTooltip, type TooltipState } from '@/components/ChartTooltip';
import { Breakdown } from '@/components/Breakdown';
import { EmptyState } from '@/components/EmptyState';
import type { EmptyGhost } from '@/components/EmptyGhost';
import { HeatmapVerdict } from '@/components/HeatmapVerdict';
import { InfoTooltip } from '@/components/InfoTooltip';
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
  IG_AUDIENCE_INFO,
  IG_DEMOGRAPHICS_EMPTY,
  IG_DEMOGRAPHICS_MIN_FOLLOWERS,
  igDemographicsCoverage,
} from '@/lib/igMetrics';
import { useScrollEdgeFade } from '@/lib/useScrollEdgeFade';

/**
 * Пустая демография — ОДИН текст на все четыре карточки.
 *
 * Отдельный компонент, а не необязательные пропы у общего EmptyChart, именно поэтому: причина у
 * четырёх карточек буквально одна (порог аккаунта), и четыре её пересказа читались бы как четыре
 * разные причины. Разъехаться вызовам тут негде — расходится только силуэт, потому что форма у
 * карточек разная: рейтинг строк против доли целого.
 */
function DemographyEmpty({ ghost }: { ghost: EmptyGhost }) {
  return (
    <EmptyState
      compact
      size="chart"
      ghost={ghost}
      title={IG_DEMOGRAPHICS_EMPTY.title}
      reason={IG_DEMOGRAPHICS_EMPTY.reason}
    />
  );
}

/** ⓘ карточки демографии. Базовый InfoTooltip, а не MetricInfo: см. IG_AUDIENCE_INFO. */
function AudienceInfo({ term }: { term: keyof typeof IG_AUDIENCE_INFO }) {
  const info = IG_AUDIENCE_INFO[term];
  return <InfoTooltip title={info.title}>{info.text}</InfoTooltip>;
}

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

  // Охват считается из СУММЫ ВОЗРАСТНЫХ ГРУПП — значит, и живёт он примечанием карточки
  // «Возраст», а не абзацем под сеткой. Под сеткой одно число отвечало сразу за четыре разных
  // знаменателя (подписчики у возраста и пола, полный рейтинг у стран и городов) и читалось как
  // общее правило всех соседей, будучи посчитанным ровно по одному из них.
  //
  // Примечание несёт ТОЛЬКО живое число, а «почему меньше 100%» переехало в ⓘ карточки. Замерено:
  // полная фраза переносилась во ВТОРУЮ строку на карточке 430px и отнимала там строку данных, а
  // мобильная подача обязана остаться прежней (CLAUDE.md).
  const coverage = igDemographicsCoverage(ageItems, followers);
  // Значение и доля больше НЕ склеиваются здесь вручную: склейка шла мимо formatShare и печатала
  // «71.0%» там, где канон печатает «71%», а страница разбора той же демографии доли не знала вовсе.
  // Теперь доля приходит со слоя данных (igMetrics → withShares) и живёт в СВОЕЙ колонке.
  // Срез топ-8 доли не пересчитывает: они от ПОЛНОГО рейтинга, и сумма видимых честно меньше 100%.

  // One WidgetGroup keeps the four demographic cards on the shared dashboard grid. Whole-card
  // click drills to a dedicated /metrics/ig-* page instead of the generic ?detail= overlay.
  //
  // ЧЕТЫРЕ РАВНЫЕ карточки: half × 4 = два ряда по две. При third их было три плюс одна, и правило
  // заполнения ряда (useRowFill) честно дотягивало четвёртую до полной ширины — дыры не
  // оставалось, но «Топ городов» выходил втрое шире «Топ стран». Четыре разреза одной природы
  // разной ширины читаются как иерархия, которой нет, а растянутая на 1110px разбивка — это ровно
  // «график посреди пустоты» из правила noStretch. Размер тут ДЕФОЛТНЫЙ: сохранённый выбор
  // владельца (widgetPrefsStore) по-прежнему сильнее.
  return (
    <WidgetGroup id="ig-audience" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
      <ChartSection title="Возраст" defaultSize="half" drillTo="/metrics/ig-age" action={<AudienceInfo term="age" />}>
        {ageItems.length > 0 ? (
          <Breakdown
            items={ageItems}
            columns={{ label: 'Возраст', value: 'Подписчики' }}
            footnote={
              coverage != null ? `Демография охватывает ≈${Math.round(coverage * 100)}% подписчиков` : undefined
            }
          />
        ) : (
          <DemographyEmpty ghost="rows" />
        )}
      </ChartSection>
      {/* Полукольцо (выбор владельца) — та же форма, что «Пол» Метрики: фикс-набор долей целого;
          непокрытый демографией остаток кольцо честно дорисует из total приглушённым сегментом. */}
      <ChartSection title="Пол" defaultSize="half" drillTo="/metrics/ig-gender" action={<AudienceInfo term="gender" />}>
        {genderItems.length > 0 ? (
          <RadialShare
            segments={genderItems.map((g) => ({ key: g.label, label: g.label, value: g.value }))}
            total={followers > 0 ? followers : null}
            unitWord="подписчиков"
            centerCaption="подписчиков"
            format={(v) => fmt.short(v)}
          />
        ) : (
          <DemographyEmpty ghost="ring" />
        )}
      </ChartSection>
      {/* Гео — фикс-строки той же плотности, что «Возраст» (виз-переключатель с мини-донатом
          убран — «выглядит дёшево», владелец): ранг, подпись, значение и доля от полного
          рейтинга — каждое в своей колонке. Футер ведёт на полный список: «+N ещё» называл
          спрятанное, но идти за ним было некуда. */}
      <ChartSection
        title="Топ стран"
        defaultSize="half"
        drillTo="/metrics/ig-countries"
        action={<AudienceInfo term="countries" />}
      >
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
          <DemographyEmpty ghost="rows" />
        )}
      </ChartSection>
      <ChartSection
        title="Топ городов"
        defaultSize="half"
        drillTo="/metrics/ig-cities"
        action={<AudienceInfo term="cities" />}
      >
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
          <DemographyEmpty ghost="rows" />
        )}
      </ChartSection>
    </WidgetGroup>
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
        reason={`Instagram не предоставил почасовую активность аудитории для этого аккаунта (метрика доступна не всегда и требует ${IG_DEMOGRAPHICS_MIN_FOLLOWERS}+ подписчиков).`}
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
