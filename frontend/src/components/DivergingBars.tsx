import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { columnIndex } from '@/lib/chartHover';
import { axisLabelIndexSet } from '@/lib/chartLabels';
import { seriesMotionKey } from '@/lib/chartMotion';
import { useMorphValues } from '@/lib/useMorphValues';
import { observeSize } from '@/lib/observeSize';
import { ChartTooltip } from '@/components/ChartTooltip';
import { stackSegmentPath } from '@/components/BarChart';
import { EmptyState } from '@/components/EmptyState';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';

interface DivergingBarsProps {
  values: number[];
  /** Per-bar x-labels; thinned to a readable stride, like BarChart. */
  labels?: string[];
  /** Подписи ОСИ вместо дат (короткое окно ≤ 8 точек: буквы дней недели, канон timeAxisLabels).
      Буквы узкие — подписан каждый столбец. Тултип (`titles`) держит полные даты. */
  axisLabels?: string[];
  titles?: string[];
  height?: number;
  /**
   * Что стоит по оси X. `time` (умолчание) — дни/недели: последний столбец И ЕСТЬ «сейчас», его
   * метку канон семьи графиков красит пилюлей. `category` — разрезы (каналы, товары): там
   * «последнего» не существует, порядок задаёт сортировка по величине, и пилюля на крайнем
   * столбце читалась бы как «этот выбран» — поэтому в категориальном режиме её нет.
   */
  axis?: 'time' | 'category';
  /**
   * Короткие подписи величин у концов столбцов (уже отформатированные вызывающим — компонент
   * не знает ни валюты, ни знака). Без них вклад читается только курсором, а на разборе «кто
   * сколько добавил» число — и есть содержание графика.
   */
  valueLabels?: string[];
}

// Approximate glyph width of the 11px tabular labels (канон BarChart/LineChart).
const CHAR_W = 6.6;
// Полоса подписей оси и посадка пилюли — общие с BarChart (там AXIS_PILL_PAD = 6).
const AXIS_BAND_H = 24;
const AXIS_PILL_GAP = 6.5;
const AXIS_PILL_H = 15;
const AXIS_PILL_PAD = 6;

/**
 * Нулевая линия и масштаб ОДНОГО кадра — из тех же значений, что в этом кадре и рисуются.
 *
 * Это не оформление, а инвариант. Пока морф твинил ПИКСЕЛЬНЫЕ высоты, посчитанные при прошлой
 * нулевой линии, а рисовал их относительно новой, столбцы улетали за `viewBox` и обрезались: на
 * «Что изменило выручку» переключение «Каналы»→«Товары» на ~175мс показывало пустую карточку с
 * огрызками, а на «Чистом приросте» в TG смена периода пробивала столбцами полосу подписей оси.
 * Раньше этого не могло случиться — `mid` был константой `h/2`, и устаревшие высоты всегда
 * оставались в кадре.
 *
 * Отсюда доказуемость: для любого кадра `bh_i = |v_i|·scale ≤ maxUp·scale = mid − padUp`, значит
 * верх плюс-бара `mid − bh_i ≥ padUp ≥ 0`; симметрично низ минус-бара `≤ h − padDown ≤ h`. Ни один
 * столбец не может выйти за поле — если mid, scale и значения взяты из одного кадра.
 *
 * Поля приходят от ЦЕЛИ, а не от текущего кадра: считай их из твинящихся значений — и в момент,
 * когда одна сторона пустеет, поле скакнуло бы с 17 на 4, дёрнув линию в самом конце перелёта.
 */
export function divergingFrame(
  values: ReadonlyArray<number>,
  h: number,
  padUp: number,
  padDown: number,
): { mid: number; scale: number } {
  // Значения сюда приходят уже нормализованными (не-числа заменены нулём), поэтому хватает
  // размаха без отдельной фильтрации.
  const maxUp = Math.max(0, ...values);
  const maxDown = -Math.min(0, ...values);
  const span = maxUp + maxDown;
  const usable = Math.max(h - padUp - padDown, 1);
  if (span <= 0) return { mid: h / 2, scale: 0 };
  return { mid: padUp + (usable * maxUp) / span, scale: usable / span };
}

interface Hover {
  i: number;
}

/** Bars around a horizontal zero-line, MONOCHROME in the card's accent (steep): direction is
    encoded by position around zero, so both directions ride --chart-role-primary — the down bars
    a step quieter (opacity), never the semantic red/green (владелец: бары не кричат; на
    тинтованной карточке бары автоматически берут её пастель через accent-скоуп). Fills the
    height an ancestor dictates — the fixed widget tile or the expand overlay — via
    ExpandedChartHeightContext (like BarChart), else the caller's `height`, else 120px. */
export function DivergingBars({
  values,
  labels,
  axisLabels,
  titles,
  height,
  axis = 'time',
  valueLabels,
}: DivergingBarsProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Hover | null>(null);
  // Measure the render width so the viewBox is 1:1 with CSS pixels — a fixed 600-wide viewBox
  // scaled to fit stretched the zero-line + labels at inconsistent sizes.
  const [width, setWidth] = useState(600);
  // The fixed tile / overlay dictates the height; inline renders fall back to `height`.
  const ctxHeight = useContext(ExpandedChartHeightContext);
  const expanded = useContext(ChartExpandedContext);

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth || 600);
    measure();
    return observeSize(el, measure);
  }, []);

  // The readout must not linger once the chart scrolls away or the window loses focus —
  // mouseleave alone does not fire during wheel scrolling (канон BarChart/PieChart, проход №3).
  const hasHover = hover !== null;
  useEffect(() => {
    if (!hasHover) return;
    const clear = () => setHover(null);
    window.addEventListener('scroll', clear, true);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('scroll', clear, true);
      window.removeEventListener('blur', clear);
    };
  }, [hasHover]);

  // ── Geometry + the static plot, memoized APART from hover ────────────────────────────────
  // The tooltip follows the cursor here (a per-mousemove setState) — the cached layers keep
  // that from re-creating a rect per bar per move, and the per-bar transparent hit-rects are
  // replaced by ONE mouse handler on the svg with O(1) column math (columnIndex).
  // В зависимостях `plot` стоит именно ФЛАГ, а не сам массив: он приходит новым на каждый рендер
  // (`.map(...)` у вызывающего) и обнулял бы мемоизацию, хотя геометрии важно лишь одно — есть
  // числа или нет (от этого зависит ширина полей).
  const hasValueLabels = !!valueLabels;
  const plot = useMemo(() => {
    if (!values || values.length === 0) return null;

    // Буквенная ось короткого окна: буквы узкие, подписан КАЖДЫЙ столбец (канон BarChart).
    const letterAxis = axisLabels && axisLabels.length === values.length ? axisLabels : null;
    const hasLabels = (!!labels && labels.length > 0) || !!letterAxis;
    // Полоса подписей оси — 24px, как у BarChart: пилюля садится на band + 6.5, а не на +2.5.
    // Прежние 20px при просвете 2.5 клали пилюлю вплотную к столбцам, и на плотном ряду она
    // визуально ложилась ПОВЕРХ них (аудит #554, D2 и «десять мелочей»: 6.5 против 2.5 в одной
    // семье графиков).
    const labelPad = hasLabels ? AXIS_BAND_H : 0;
    // The dictated height covers the whole element; reserve the label band inside it so the bars
    // area (mid line ± bars) never grows past the tile.
    const total = ctxHeight ?? height ?? 120;
    const h = Math.max(total - labelPad, 1);
    const normalized = values.map((value) => (Number.isFinite(value) ? value : 0));

    // Нулевая линия ИДЁТ ЗА ДАННЫМИ, а не стоит посередине.
    //
    // Раньше было `mid = h / 2` при масштабе от `maxAbs`: половина площади резервировалась под
    // знак, которого в данных может не быть вовсе. На разборе «Что изменило выручку» все вклады
    // ушли в минус — верхняя половина карточки пустовала всегда, а столбцы делили оставшуюся
    // половину и вырождались в полоски по 1–2px (замечено владельцем: «как-то не наглядно»).
    //
    // Теперь это обычная линейная шкала по НАСТОЯЩЕМУ размаху [−maxDown, +maxUp] (см.
    // divergingFrame): пиксель на единицу ОДИН для обеих сторон, поэтому столбцы по-прежнему
    // сравнимы между собой, а высоту получает только тот знак, который в данных есть.
    // Симметричный размах даёт ровно прежнюю картинку (mid = h/2) — временные ряды со сменой
    // знака ничего не теряют. Сама линия считается НЕ здесь, а покадрово: она зависит от данных,
    // а данные во время морфа промежуточные.
    //
    // Числа печатаются СНАРУЖИ столбца, поэтому поле на их стороне шире. Внутрь их класть нельзя:
    // минус-бары идут на 0.6 прозрачности, и белые чернила по такой пастели проваливают контраст
    // (проверено кадром светлой темы). Поле берётся только с той стороны, где столбцы ЕСТЬ, —
    // иначе односторонний размах опять дарил бы пустоту тому знаку, которого в данных нет.
    //
    // 17 = высота бокса числа (14) + просвет до столбца (3). Меньше — и число касается кромки
    // (первый заход давал ровно 0px и читался как подпись ВНУТРИ столбца), больше — столбцы зря
    // теряют высоту. Столько же остаётся между числом и полосой подписей оси.
    const PAD = 4;
    const LABEL_PAD = 17;
    const padUp = hasValueLabels && normalized.some((value) => value > 0) ? LABEL_PAD : PAD;
    const padDown = hasValueLabels && normalized.some((value) => value < 0) ? LABEL_PAD : PAD;

    const W = Math.max(width, 1);
    const step = W / values.length;
    const barWidth = step * 0.7;
    const gap = step * 0.3;
    const labelIndexes = letterAxis
      ? new Set(values.map((_, i) => i))
      : axisLabelIndexSet(values.length, W, { minLabelPx: expanded ? 68 : 78, maxLabels: expanded ? 12 : 7 });

    const valid = values.map((value) => Number.isFinite(value));

    // «Текущий» индекс оси (пилюля): последний НЕПУСТОЙ тик канонной оси, иначе последний столбец.
    // На категориальной оси «текущего» нет — там крайний столбец это просто крайний по величине,
    // и солидная пилюля на нём читалась бы как «выбран этот разрез». −1 гасит её целиком.
    const axisCurrentIdx =
      axis !== 'time'
        ? -1
        : letterAxis
          ? letterAxis.reduce((acc, text, i) => (text.length > 0 ? i : acc), -1)
          : values.length - 1;
    const labelsLayer = hasLabels
      ? values.map((_, i) => {
          const axisText = letterAxis ? letterAxis[i] : labels?.[i];
          const show = axisText && labelIndexes.has(i);
          if (!show) return null;
          const isLast = i === axisCurrentIdx;
          const isFirst = i === 0;
          const textW = String(axisText).length * CHAR_W;
          /* Крайние подписи ПРИЖИМАЮТСЯ внутрь, а не центрируются под столбцом.
             Центрирование съедало половину текста за кромкой svg: на «Чистом приросте» в узкой
             карточке левая подпись показывала «авг.» вместо «5 авг.», а пилюля справа обрезалась
             до «3 се» (аудит #554, D2). BarChart решает это ровно так же — start у первой, end у
             последней; здесь была единственная в семье копия со старым поведением. */
          const anchor = isLast ? 'end' : isFirst ? 'start' : 'middle';
          const centerX = i * step + step / 2;
          const x = isLast
            ? Math.max(textW + AXIS_PILL_PAD + 1, Math.min(centerX + textW / 2, W - AXIS_PILL_PAD - 1))
            : isFirst
              ? Math.max(1, Math.min(centerX - textW / 2, W - textW - 1))
              : Math.max(textW / 2 + 1, Math.min(centerX, W - textW / 2 - 1));
          // Пилюля текущей (последней) метки — канон семьи графиков (BarChart/LineChart):
          // солидная заливка цветом серии, чернила — фон; тонированная карточка перекрашивает
          // токен в своём скоупе. viewBox 1:1 с px — rect не искажается.
          const pill = isLast
            ? (() => {
                const pillW = Math.max(textW + AXIS_PILL_PAD * 2, AXIS_PILL_H);
                return {
                  x: Math.max(1, Math.min(x - textW - AXIS_PILL_PAD, W - pillW - 1)),
                  w: pillW,
                  h: AXIS_PILL_H,
                };
              })()
            : null;
          return (
            <g key={`l${i}`} data-axis-current={isLast ? '' : undefined}>
              {pill && (
                <rect x={pill.x} y={h + AXIS_PILL_GAP} width={pill.w} height={pill.h} rx={pill.h / 2} fill="hsl(var(--chart-role-primary))" className="pointer-events-none" />
              )}
              <text
                x={x}
                y={h + AXIS_PILL_GAP + AXIS_PILL_H / 2 + 4}
                textAnchor={anchor}
                data-chart-axis-label="x"
                fill={isLast ? 'hsl(var(--background))' : undefined}
                className={`pointer-events-none select-none text-2xs font-medium tabular-nums ${isLast ? '' : 'fill-muted-foreground'}`}
              >
                {axisText}
              </text>
            </g>
          );
        })
      : null;

    return { W, h, step, barWidth, gap, normalized, padUp, padDown, valid, labelsLayer, labelPad };
  }, [values, labels, axisLabels, width, ctxHeight, height, expanded, axis, hasValueLabels]);

  // ── UPDATE morph (canon BarChart): the signed silhouette flows into the new shape ─────────
  // A sign flip mid-flight honestly passes through the midline (the bar shrinks to 0 and re-grows
  // on the other side), switching to the quieter down-opacity at the crossing.
  //
  // Твинятся ЗНАЧЕНИЯ, а не пиксели. Пиксельный морф работал, пока нулевая линия стояла на `h/2`
  // при любых данных; как только она пошла за данными, промежуточные кадры стали рисовать высоты
  // прошлого масштаба относительно новой линии — и столбцы улетали за viewBox (см. divergingFrame).
  // Из значений каждый кадр пересчитывает и линию, и масштаб, поэтому линия ПЛЫВЁТ к новому месту
  // вместо телепорта, а выйти за поле кадр не может по построению.
  const motionKey = seriesMotionKey(values);
  const targetValues = useMemo(() => plot?.normalized ?? [], [plot]);
  const tweened = useMorphValues(targetValues, motionKey, 'silhouette');
  const frame = useMemo(
    () => (plot ? divergingFrame(tweened, plot.h, plot.padUp, plot.padDown) : null),
    [plot, tweened],
  );
  const bars = useMemo(() => {
    if (!plot || !frame) return null;
    return tweened.map((value, i) => {
      // Честный ноль остаётся отметкой в 1px: точка в ряду есть, и она нулевая — это не то же
      // самое, что пропуск (у пропуска op = 0, его не видно вовсе).
      const bh = plot.valid[i] ? Math.max(1, Math.abs(value) * frame.scale) : 0;
      const up = value >= 0;
      return {
        x: i * plot.step + plot.gap / 2,
        y: up ? frame.mid - bh : frame.mid,
        w: plot.barWidth,
        h: bh,
        // Скругляется ВНЕШНИЙ угол (от нулевой линии): у плюс-бара верх, у минус-бара низ —
        // основание на нулевой линии остаётся прямым (канон BarChart, «закруглённое всё»).
        up,
        fill: 'hsl(var(--chart-role-primary))',
        // Down bars: same ink, one luminance step quieter — position already says the direction.
        op: plot.valid[i] ? (up ? 1 : 0.6) : 0,
      };
    });
  }, [plot, frame, tweened]);
  const barsLayer = useMemo(
    () =>
      bars?.map((b, i) => {
        // Пустая геометрия не рендерится (см. BarChart): <path d=""> — невидимый элемент-ловушка.
        const d = stackSegmentPath(b, b.up, !b.up);
        return d ? <path key={i} d={d} fill={b.fill} fillOpacity={b.op} /> : null;
      }) ?? null,
    [bars],
  );

  // ── Числа у концов столбцов ───────────────────────────────────────────────────────────────
  // ВСЕГДА снаружи, в сторону от нуля — там для них зарезервировано поле (LABEL_PAD выше).
  //
  // Первый заход клал число высокого столбца внутрь, чернилами по фону: на плюс-барах это читалось,
  // а минус-бары идут на 0.6 прозрачности, и белое по такой пастели провалило контраст в светлой
  // теме. Одно правило для обоих знаков избавляет и от этого, и от перескока «внутрь/наружу»
  // посреди морфа.
  //
  // Не влезло по ширине столбца — не печатаем вовсе: обрезок врёт сильнее, чем пропуск.
  const valuesLayer = useMemo(() => {
    if (!plot || !bars || !valueLabels) return null;
    return bars.map((b, i) => {
      const text = valueLabels[i];
      if (!text || !plot.valid[i]) return null;
      if (text.length * CHAR_W + 4 > plot.step) return null;
      const x = b.x + b.w / 2;
      // Бокс числа — 14px вокруг базовой линии (11 вверх, 3 вниз), поэтому смещения не
      // симметричны: −6 над кромкой и +14 под ней дают одинаковые 3px просвета с обеих сторон.
      const raw = b.up ? b.y - 6 : b.y + b.h + 14;
      // Одинокий короткий столбец «не в ту сторону» стоит вплотную к краю (поле там узкое) —
      // число прижимается к полю, а не уезжает за верх или в полосу подписей оси.
      const y = Math.min(Math.max(raw, 11), plot.h - 1);
      return (
        <text
          key={`v${i}`}
          x={x}
          y={y}
          textAnchor="middle"
          data-chart-value-label=""
          className="pointer-events-none select-none fill-muted-foreground text-2xs font-medium tabular-nums"
        >
          {text}
        </text>
      );
    });
  }, [plot, bars, valueLabels]);

  // Pointer reading is supplementary to the graphic's full text summary. Listen on the passive
  // SVG node and keep it out of the keyboard order; there is no activation action to expose.
  useEffect(() => {
    const svg = svgRef.current;
    const container = containerRef.current;
    if (!svg || !container || !plot || values.length === 0) return;
    const handleMove = (event: globalThis.MouseEvent) => {
      const svgRect = svg.getBoundingClientRect();
      if (svgRect.width === 0) return;
      const xView = ((event.clientX - svgRect.left) / svgRect.width) * plot.W;
      const i = columnIndex(xView, values.length, 0, plot.step);
      setHover((prev) => (prev && prev.i === i ? prev : { i }));
    };
    const clearHover = () => setHover(null);
    svg.addEventListener('mousemove', handleMove);
    container.addEventListener('mouseleave', clearHover);
    return () => {
      svg.removeEventListener('mousemove', handleMove);
      container.removeEventListener('mouseleave', clearHover);
    };
  }, [plot, values.length]);

  const hasFiniteValue = values?.some((value) => Number.isFinite(value)) ?? false;
  if (!values || values.length === 0 || !hasFiniteValue || !plot || !bars || !frame) {
    return <EmptyState compact size="chart" title="Нет данных" />;
  }

  const { W, h, labelPad } = plot;
  // Нулевая линия — из ТЕКУЩЕГО кадра морфа, не из цели: иначе она телепортируется на новое место,
  // пока столбцы ещё летят, и они на полперелёта отрываются от собственного основания.
  const { mid } = frame;
  const n = values.length;
  const tipText = (i: number) =>
    titles?.[i] ?? (Number.isFinite(values[i]) ? `${values[i]}` : 'Нет данных');
  const finiteValues = values.filter(Number.isFinite);
  const minimum = finiteValues.length > 0 ? Math.min(...finiteValues) : null;
  const maximum = finiteValues.length > 0 ? Math.max(...finiteValues) : null;
  const latestIndex = values.length - 1;
  const latestName = labels?.[latestIndex] ?? `точка ${values.length}`;
  const latestDetail = titles?.[latestIndex];
  const latestValue = Number.isFinite(values[latestIndex]) ? `${values[latestIndex]}` : 'нет данных';
  // На категориальной оси «последней точки» не существует — читалке нужен крайний по ВЕЛИЧИНЕ,
  // а не крайний по порядку сортировки, иначе слышно «последняя: −250000» про то, что на экране
  // подписано именем разреза и стоит там лишь из-за сортировки.
  const extremeIndex =
    axis === 'time'
      ? latestIndex
      : values.reduce(
          (acc, value, i) =>
            Number.isFinite(value) && Math.abs(value) > Math.abs(values[acc] ?? 0) ? i : acc,
          0,
        );
  const extremeName = labels?.[extremeIndex] ?? `разрез ${extremeIndex + 1}`;
  const extremeDetail = titles?.[extremeIndex];
  const accessibleSummary = [
    axis === 'time' ? `Дельта по ${n} точкам.` : `Дельта по ${n} разрезам.`,
    minimum == null ? 'Числовых значений нет.' : `Минимум ${minimum}; максимум ${maximum}.`,
    axis === 'time'
      ? `Последняя — ${latestName}: ${latestValue}${latestDetail ? ` (${latestDetail})` : ''}.`
      : `Наибольший вклад — ${extremeName}${extremeDetail ? ` (${extremeDetail})` : ''}.`,
  ].join(' ');

  return (
    <div ref={containerRef} className="relative w-full">
      <svg
        ref={svgRef}
        role="img"
        aria-label={accessibleSummary}
        className="block w-full cursor-crosshair"
        height={h + labelPad}
        viewBox={`0 0 ${W} ${h + labelPad}`}
        preserveAspectRatio="none"
      >
        {/* БЕЗ svg <title> — см. LineChart/BarChart: aria-label уже именует график, а <title>
            дублировал его нестилизуемым нативным тултипом с острыми углами поверх ChartTooltip. */}
        <line x1={0} y1={mid} x2={W} y2={mid} stroke="hsl(var(--border))" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />

        {/* Bar rects (morphed above); hovering dims the whole group and the overlay below re-draws
            the hovered bar at full opacity — same reading as the old per-bar opacity swap.
            transition-opacity only WHILE hovered so the un-dim on leave snaps back to idle (the
            full-opacity highlight unmounts in the same commit) — no below-idle dip. */}
        <g className={hover ? 'transition-opacity' : undefined} opacity={hover ? 0.55 : 1}>
          {barsLayer}
          {valuesLayer}
        </g>

        {plot.labelsLayer}

        {hover && hover.i < n && (
          <path
            d={stackSegmentPath(bars[hover.i], bars[hover.i].up, !bars[hover.i].up)}
            fill={bars[hover.i].fill}
            fillOpacity={bars[hover.i].op}
            className="pointer-events-none"
          />
        )}
      </svg>
      <ChartTooltip
        tip={
          hover && hover.i < n
            ? { x: bars[hover.i].x + bars[hover.i].w / 2, y: bars[hover.i].y, text: tipText(hover.i) }
            : null
        }
      />
    </div>
  );
}
