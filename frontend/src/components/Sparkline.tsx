import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { seriesMotionKey } from '@/lib/chartMotion';
import type { MorphPoint } from '@/lib/chartMorph';
import { ChartTooltip, type TooltipState } from '@/components/ChartTooltip';
import { SparklineSeries } from '@/components/SparklineSeries';
import { cn } from '@/lib/utils';
import { sparkDomain } from '@/lib/robustDomain';

interface SparklineProps {
  /**
   * `null` = пропуск измерения. Компактная искра показывает только наблюдения: пропуски
   * отбрасываются вместе со своими подписями (labels + axisLabels синхронно), а не заполняются
   * нулём — рисовать разрыв в 200×32 некуда, а ноль вместо пропуска — прямая ложь. Поэтому
   * bar-вариант карточки (BarChart со штрихованной подложкой пропуска) показывает ПОЛНОЕ окно,
   * а line-вариант — только дни с наблюдениями. Полноразмерный {@link LineChart} разрывы
   * показывает по-настоящему.
   */
  values: Array<number | null>;
  /** Per-point labels (e.g. dates), same length as values — used in the hover read-out. */
  labels?: string[];
  /**
   * Подписи ОСИ вместо дат из `labels` (короткое окно ≤ 8 точек: буквы дней недели, канон
   * weekdayAxis). Выравнены с values и при пропусках отбрасываются синхронно с labels. Буквы
   * узкие, поэтому буквенная ось показывает ВСЕ тики — а не первый/середину/последний, как даты.
   * Полную дату наведённой точки по-прежнему называет тултип (из `labels`).
   */
  axisLabels?: string[];
  /** Full hsl() stroke/fill colour, e.g. 'hsl(var(--brand-iris))'. */
  color?: string;
  /** Add a soft gradient area fill under the line (featured cards). */
  area?: boolean;
  strokeWidth?: number;
  className?: string;
  /** Show peak + current markers and a hover dot/guide. */
  interactive?: boolean;
  /**
   * Idle text shown under the line (e.g. "по дням") when there is no axis to draw. The reserved
   * line otherwise holds the X axis, which STAYS PUT on hover — the hovered date · value · Δ
   * read-out lives in the floating ChartTooltip (владелец, 2026-08-14: «такие же pop-up, как у
   * столбцов»). Omit the prop to suppress the line entirely (compact tiles) — no layout shift.
   */
  caption?: string;
  /** Formats a value for the hover read-out (default: String). */
  formatValue?: (n: number) => string;
}

// Same viewBox the path math in format.ts uses; markers are positioned as %s of it so they stay
// glued to the line under preserveAspectRatio="none" (both axes stretch with the container).
const PAD = 2;
const VBW = 200;
const VBH = 32;

/**
 * Target geometry in viewBox coordinates — the SAME px/py mapping {@link sparkPath} uses (min/max
 * normalisation, PAD inset), so a settled morph frame is byte-identical to the static render. The
 * viewBox is fixed (200×32); geometry depends only on the values, never on container size, so a
 * resize can't change these points and never restarts the morph.
 */
function computeSparkPoints(values: number[], domain: { min: number; max: number }): MorphPoint[] {
  const n = values.length;
  if (n === 0) return [];
  const range = domain.max - domain.min || 1;
  const step = (VBW - PAD * 2) / Math.max(n - 1, 1);
  return values.map((v, i) => ({
    x: PAD + i * step,
    // Клип по домену: точка выше окна упирается в верх и помечается карéткой — иначе один
    // вирусный день снова заберёт всю высоту. Значение при этом не меняется, только геометрия.
    y: VBH - PAD - ((Math.min(v, domain.max) - domain.min) / range) * (VBH - PAD * 2),
  }));
}

/**
 * Tiny inline trend line. `area` adds a gradient fill that fades to transparent (featured
 * KPIs); compact tiles use just the stroke. When `interactive`, it gains a peak marker, a
 * current-value dot, and a hover dot + guide that (with `caption`) surfaces the date/value/Δ
 * read-out. Renders nothing for <2 points (skeleton/empty stays clean).
 */
export function Sparkline({
  values: rawValues,
  labels: rawLabels,
  axisLabels: rawAxisLabels,
  color = 'hsl(var(--brand-iris))',
  area = false,
  strokeWidth = 1.6,
  className,
  interactive = false,
  caption,
  formatValue = String,
}: SparklineProps) {
  // Отбрасываем пропуски вместе с их подписями ОДИН раз, до всей геометрии и морфа: дальше по
  // компоненту `values` — это уже только наблюдения, и ни min/max, ни ховер-тултип, ни
  // aria-label не могут случайно наткнуться на null. Мемо по ссылке входного массива, чтобы
  // ховер-перерисовка не порождала новый `values` и не перезапускала морф.
  const { values, labels, axis } = useMemo(() => {
    const source = rawValues ?? [];
    if (!source.some((value) => value == null)) {
      return { values: source as number[], labels: rawLabels, axis: rawAxisLabels };
    }
    const kept: number[] = [];
    const keptLabels: string[] = [];
    const keptAxis: string[] = [];
    source.forEach((value, index) => {
      if (value == null) return;
      kept.push(value);
      if (rawLabels) keptLabels.push(rawLabels[index] ?? '');
      if (rawAxisLabels) keptAxis.push(rawAxisLabels[index] ?? '');
    });
    return {
      values: kept,
      labels: rawLabels ? keptLabels : undefined,
      axis: rawAxisLabels ? keptAxis : undefined,
    };
  }, [rawValues, rawLabels, rawAxisLabels]);

  // Strip colons from useId — they're valid in ids but break SVG url(#…) refs in some browsers.
  const gradientId = `sl${useId().replace(/:/g, '')}`;
  // Ховер несёт индекс точки И размер поверхности на момент движения: тултип якорится в px
  // относительно relative-обёртки (контракт ChartTooltip), а проценты xPct/yPct переводятся в px
  // ровно тем прямоугольником, по которому считался индекс, — отдельный замер не нужен.
  const [hover, setHover] = useState<{ i: number; w: number; h: number } | null>(null);
  const hoverSurfaceRef = useRef<HTMLDivElement>(null);
  // Target morph geometry, memoised on the VALUES reference: a hover rerender keeps the same `values`
  // ref (hover is local state — the parent doesn't re-render), so the morph layer sees a stable
  // `points` and never restarts; a period/filter swap hands down a new array → new geometry → morph.
  // Домен считается ОДИН раз и делится между геометрией морфа и разметкой ниже: если посчитать
  // его дважды, кадр морфа и статический рендер разъедутся. Мемо по той же ссылке `values`.
  const domain = useMemo(() => sparkDomain(values ?? []), [values]);
  const clippedSet = useMemo(() => new Set(domain.clipped), [domain]);
  const points = useMemo(() => computeSparkPoints(values ?? [], domain), [values, domain]);

  /**
   * Разметка оси. Буквенная ось короткого окна (axisLabels: «M T W T F S S») показывает ВСЕ
   * тики — буквы узкие, и только полный ряд даёт ритм недели (референс владельца, 2026-08-14).
   * Даты остаются тройкой «первая, середина, последняя»: больше в ширину карточки в треть экрана
   * не влезает без наложения, а прореживать «сколько поместится» без замера текста значит гадать.
   * Ровно два лейбла (начало и конец) при коротком ряде — тоже валидная ось, поэтому середина
   * добавляется, только если она НЕ совпадает с краями. Конкретный день называет ховер-тултип.
   */
  const axisTicks = useMemo(() => {
    if (axis && axis.length >= 2) {
      return axis.map((text, i) => ({ i, text })).filter((tick) => tick.text.length > 0);
    }
    if (!labels || labels.length < 2) return [] as { i: number; text: string }[];
    const last = labels.length - 1;
    const mid = Math.floor(last / 2);
    const idx = mid > 0 && mid < last ? [0, mid, last] : [0, last];
    return idx
      .map((i) => ({ i, text: labels[i] ?? '' }))
      .filter((tick) => tick.text.length > 0);
  }, [axis, labels]);

  // Pointer scrubbing is supplementary to the SVG's detailed accessible name, not an activation
  // action. Keep the surface passive and listen for its coordinates on the DOM node.
  useEffect(() => {
    const surface = hoverSurfaceRef.current;
    if (!surface || !interactive || values.length < 2) return;
    const handleMove = (event: globalThis.MouseEvent) => {
      const rect = surface.getBoundingClientRect();
      if (rect.width === 0) return;
      const ratio = (event.clientX - rect.left) / rect.width;
      const i = Math.max(0, Math.min(values.length - 1, Math.round(ratio * (values.length - 1))));
      setHover((prev) =>
        prev && prev.i === i && prev.w === rect.width && prev.h === rect.height
          ? prev
          : { i, w: rect.width, h: rect.height },
      );
    };
    const clearHover = () => setHover(null);
    surface.addEventListener('mousemove', handleMove);
    surface.addEventListener('mouseleave', clearHover);
    return () => {
      surface.removeEventListener('mousemove', handleMove);
      surface.removeEventListener('mouseleave', clearHover);
    };
  }, [interactive, values.length]);

  if (!values || values.length < 2) return null;

  // Stable DATA signature (see index.css «Chart motion») — a change (period / filter swap, longer /
  // shorter window) tells the morph layer to flow from the old shape into the new one; hover (separate
  // state), a container resize (viewBox geometry is size-independent) and a value-identical refetch all
  // yield the SAME key, so none of them restart the morph.
  const motionKey = seriesMotionKey(values);

  const n = values.length;
  const min = domain.min;
  const max = domain.max;
  const range = max - min || 1;
  const step = (VBW - PAD * 2) / Math.max(n - 1, 1);
  const xPct = (i: number) => ((PAD + i * step) / VBW) * 100;
  // Тот же клип, что в геометрии морфа, иначе ховер-точка уехала бы выше линии.
  const yPct = (v: number) => ((VBH - PAD - ((Math.min(v, max) - min) / range) * (VBH - PAD * 2)) / VBH) * 100;

  const active = hover?.i ?? null;

  // Плавающий тултип у наведённой точки — тот же канонный ChartTooltip, что у столбцов/линий
  // (владелец, 2026-08-14: «такие же pop-up для линейных графиков»). Содержимое повторяет формат
  // бар-карточек («11 авг.: 391») плюс Δ к предыдущей точке, которую несла прежняя читалка.
  // У клипнутой точки тултип обязан назвать НАСТОЯЩЕЕ число: домен режется, данные — нет.
  let tip: TooltipState = null;
  if (interactive && hover != null && hover.w > 0) {
    const v = values[hover.i];
    const label = labels?.[hover.i];
    const prev = hover.i > 0 ? values[hover.i - 1] : null;
    const diff = prev != null ? v - prev : null;
    const diffStr =
      diff != null && diff !== 0 ? ` ${diff > 0 ? '↑' : '↓'}${formatValue(Math.abs(diff))}` : '';
    const clipNote = clippedSet.has(hover.i) ? ' · пик срезан' : '';
    tip = {
      x: (xPct(hover.i) / 100) * hover.w,
      y: (yPct(v) / 100) * hover.h,
      text: `${label ? `${label}: ` : ''}${formatValue(v)}${diffStr}${clipNote}`,
    };
  }

  // Ховер-точка — единственный HTML-оверлей: полюса (начало/конец) рисует SparklineSeries из
  // текущего кадра морфа, а peak-маркер посередине линии убран целиком (владелец: «точки по
  // середине графика — лишнее; точки начала и конца нужно анимировать»).
  const dot = (i: number) => (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-background"
      style={{
        left: `${xPct(i)}%`,
        top: `${yPct(values[i])}%`,
        background: color,
      }}
    />
  );

  return (
    // Flex column so the chart fills the height that's LEFT after the caption — otherwise the chart
    // took the full height (h-full) and the caption overflowed below the box onto whatever followed.
    <div className={cn('flex flex-col', className)}>
      <div
        ref={hoverSurfaceRef}
        className="relative min-h-0 w-full flex-1"
      >
        {/* Декоративная искра рядом с числом действительно ничего не добавляет скринридеру и
            остаётся aria-hidden. Но `interactive` — уже не украшение: у неё есть hover-читалка со
            значениями, которую мышиный пользователь видит, а AT — нет. Такая искра получает тот же
            режим, что и полный LineChart: role="img" плюс подпись, несущая данные (макс/последнее).
            Точечная клавиатурная навигация — отдельный пункт роадмапа, общий с LineChart. */}
        {/* БЕЗ svg <title> — см. LineChart: aria-label (interactive-режим) уже именует график, а
            <title> дублировал его нестилизуемым нативным тултипом с острыми углами. Атрибуты —
            ПРЯМЫЕ ternary, не спред: Biome (noSvgWithoutTitle) статически ищет aria-label/hidden. */}
        <svg
          viewBox={`0 0 ${VBW} ${VBH}`}
          preserveAspectRatio="none"
          className="h-full w-full"
          role={interactive && values.length ? 'img' : undefined}
          aria-label={
            interactive && values.length
              ? `График: ${values.length} точек, макс ${formatValue(Math.max(...values))}, ` +
                `последнее ${formatValue(values[values.length - 1])}` +
                (domain.clipped.length > 0 ? `, ${domain.clipped.length} пик срезан по шкале` : '')
              : undefined
          }
          aria-hidden={interactive && values.length ? undefined : true}
          data-chart-kind="sparkline"
        >
          {area && (
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.32" />
                <stop offset="100%" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>
          )}
          {/* The line/area MORPH from the previous shape into the new one on a data change (same as the
              full LineChart) instead of remounting + fading — one stable node whose point geometry
              interpolates. The mount-only reveal fade lives on data-chart-motion="morph" in index.css. */}
          <SparklineSeries
            points={points}
            signature={motionKey}
            color={color}
            strokeWidth={strokeWidth}
            area={area}
            gradientId={gradientId}
            poles={interactive}
          />
        </svg>

        {interactive && (
          <>
            {/* Vertical guide at the hovered point. */}
            {active != null && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 w-px bg-border"
                style={{ left: `${xPct(active)}%` }}
              />
            )}
            {/* Карéтка на срезанной точке. Клип без пометки — та же ложь, что логарифм без оси
                (Observable Plot: «Clamped values may need an annotation»). Настоящее число
                показывает ховер-читалка, а в aria-label уходит счётчик срезанных пиков. */}
            {/* CSS-треугольник, а не глиф и не SVG-path: глиф потребовал бы магического размера
                шрифта мимо шкалы токенов (ловит lint:motion), а залитая фигура внутри растянутого
                viewBox перекосилась бы вместе с ним — та же причина, по которой все обводки несут
                non-scaling-stroke. HTML-оверлей от растяжения не зависит. */}
            {/* Тише и на самой кривой (владелец: «странно смотрится»). Было: 4×3px цветом
                muted-foreground, приколотые к `top: 0` — то есть на PAD выше зажатой точки, отчего
                они читались как две самостоятельные крапины, висящие над графиком, а не как пометка
                НА пике. Теперь 3×2px цветом ink3 (ступень вниз по иерархии чернил) с основанием
                ровно на зажатой точке: yPct сам клампит значение к домену, так что это та самая
                координата, где линия упёрлась в потолок шкалы. */}
            {domain.clipped.map((i) => (
              <span
                key={`clip${i}`}
                aria-hidden="true"
                title="пик срезан по шкале"
                className="pointer-events-none absolute h-0 w-0 -translate-x-1/2 -translate-y-[2px] border-x-[1.5px] border-b-[2px] border-x-transparent border-b-ink3"
                style={{ left: `${xPct(i)}%`, top: `${yPct(values[i])}%` }}
              />
            ))}
            {active != null && dot(active)}
            {/* Канонный плавающий тултип (общий с BarChart/LineChart) — якорится к точке внутри
                этой же relative-обёртки; на низкой искре его lowHost-логика сама уводит плашку
                вбок, не накрывая линию. */}
            <ChartTooltip tip={tip} />
          </>
        )}
      </div>

      {interactive && caption !== undefined && (
        // min-h резервирует строку и при ПУСТОМ idle-caption (caption="" — ось без idle-текста):
        // без резерва пустой div схлопывался в 0 и график «скакал» (владелец, Метрика/МойСклад).
        // Высота = line-box text-2xs.
        //
        // Ось X живёт в ЭТОЙ ЖЕ строке (владелец: «сделай подписи по оси X, в днях») и с 2026-08-14
        // НЕ уступает место ховер-читалке: конкретный день называет плавающий ChartTooltip, а ось
        // стоит на месте — вместе с пилюлей ТЕКУЩЕЙ (последней) метки, которая отвечает на «где
        // сейчас» (референс владельца: «Aug» / обведённая «T»).
        <div className="mt-1 min-h-4 truncate text-2xs tabular-nums text-muted-foreground">
          {axisTicks.length > 1 ? (
            <span aria-hidden="true" className="flex items-center justify-between gap-2">
              {axisTicks.map((tick, index) =>
                index === axisTicks.length - 1 ? (
                  // Пилюля не выше строки: leading-none (11px) + py-px (2px) = 13px < min-h-4,
                  // фикс-тайл 264px не растёт ни на пиксель. ЦВЕТ = цвет серии (владелец,
                  // референс steep): солидная заливка тем же `color`, что рисует линию, чернила —
                  // фон карточки. На тонированных карточках токен серии переопределён в скоупе
                  // карточки, и пилюля перекрашивается вместе с линией — вечно-синий primary
                  // там выбивался.
                  <span
                    key={tick.i}
                    data-axis-current=""
                    className="shrink-0 rounded-full px-1.5 py-px font-medium leading-none"
                    style={{ backgroundColor: color, color: 'hsl(var(--background))' }}
                  >
                    {tick.text}
                  </span>
                ) : (
                  <span key={tick.i} className="truncate">{tick.text}</span>
                ),
              )}
            </span>
          ) : (
            caption
          )}
        </div>
      )}
    </div>
  );
}
