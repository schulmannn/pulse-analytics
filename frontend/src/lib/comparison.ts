/**
 * Сравнение окна с базой и печать дельты — ОДНО правило и ОДИН формат на все поверхности.
 *
 * Сегодня формула процента скопирована 15+ раз и копии разошлись (PERIOD-8): СДЭК переворачивает
 * знак при отрицательной базе, /metrics/subscribers даёт процент от отрицательного прироста, ноль
 * печатается пустотой, «0%», «±0%», «±0.0%» и зелёным «▲0.0%», а «↑123%» карточки рядом с «▲123.4%»
 * рейла той же метрики. Модуль фиксирует канон:
 *
 *  - процент — только от положительной базы при неотрицательном текущем значении (правило
 *    `pctDelta` из lib/delta, канон карточек; формула не копируется, а вызывается). Иначе —
 *    абсолютный сдвиг (`unitMode: 'abs'`), если база измерена, или «нет базы», если её нет;
 *  - метрика, которая сама процент (ER), сравнивается в процентных пунктах (`'pp'`), никогда не
 *    процентом от процента;
 *  - прошлое окно агрегата (`flow`, `ratio`) сравнивается только при полном покрытии архивом;
 *    уровню (`stock`) достаточно самого замера базы;
 *  - одна точность и ноль — нейтральный «±» (ниже разрешения печати направление недоказуемо).
 *
 * ПОТРЕБИТЕЛЕЙ ПОКА НЕТ: DeltaPill, ComparisonDelta, CompactStatHeadline и инлайн-формулы страниц
 * переходят на модуль отдельными шагами. Точность процента взята у DeltaPill (`deltaLabel`), чтобы
 * переход карточек не менял ни одной напечатанной цифры, кроме нуля.
 */
import type { SeriesKind } from '@/lib/chartSeries';
import { NO_BASIS_SHORT_ARCHIVE, pctDelta } from '@/lib/delta';
import { formatMetricNumber } from '@/lib/metricNumber';
import type { MetricUnit } from '@/lib/widgetMetrics';

/** В чём выражена дельта: относительный процент, процентные пункты или абсолютная разность. */
export type DeltaUnitMode = 'pct' | 'pp' | 'abs';

/** Границы окна: дневные ключи `YYYY-MM-DD` или моменты в мс — та же форма, что у windowRangeLabel. */
export interface ComparisonWindow {
  from: string | number;
  to: string | number;
}

/** Слово пустого слота дельты: сравнивать не с чем (причина — в `noBasisReason`). */
export const NO_BASIS_TEXT = 'нет базы';

export interface MetricComparison {
  /** Изменение со знаком в единицах `unitMode`; `null` — сравнения нет. */
  delta: number | null;
  /** current − previous в единицах самой метрики; `null` — сравнения нет. */
  absolute: number | null;
  /** С чем сравнили: окно базы и её число. Есть ровно тогда, когда есть `delta`. */
  basis: { dates: ComparisonWindow | null; value: number } | null;
  /** Почему сравнивать не с чем; `null`, когда сравнение есть или нет самого текущего значения. */
  noBasisReason: string | null;
  unitMode: DeltaUnitMode;
  /** Единица метрики — формат абсолютного сдвига. */
  unit: MetricUnit;
  /** Несёт ли рост метрики оценку (объём упоминаний — нет). Решает голос, а не формат. */
  evaluative: boolean;
  /** Окно текущего итога — чтобы итог и основание подписывались одной парой. */
  window: ComparisonWindow | null;
}

export interface CompareWindowsInput {
  current: number | null | undefined;
  previous: number | null | undefined;
  kind: SeriesKind;
  /** Единица метрики; `percent` переводит дельту в п.п. По умолчанию `number`. */
  unit?: MetricUnit;
  currentWindow?: ComparisonWindow | null;
  previousWindow?: ComparisonWindow | null;
  /**
   * Покрытие прошлого окна архивом (splitWindowRows, U01). `complete: false` у агрегата окна →
   * «нет базы: архив короче окна». Не передано — вызывающий ручается за базу сам (сервер уже
   * отдал полное прошлое окно).
   */
  coverage?: { complete: boolean } | null;
  /** Причина отсутствия базы, которую знает только считающий («Всё», свой период, короткий архив). */
  noBasisReason?: string;
  evaluative?: boolean;
}

const isNum = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** Текущее окно против базы → MetricComparison по одному правилу. */
export function compareWindows(input: CompareWindowsInput): MetricComparison {
  const { current, previous, kind } = input;
  const unit = input.unit ?? 'number';
  const pp = unit === 'percent';
  const shell = {
    unit,
    evaluative: input.evaluative ?? true,
    window: input.currentWindow ?? null,
  };
  const none = (noBasisReason: string | null): MetricComparison => ({
    delta: null,
    absolute: null,
    basis: null,
    noBasisReason,
    unitMode: pp ? 'pp' : 'pct',
    ...shell,
  });

  // Нет текущего значения — карточка печатает «—», и слоту дельты сказать нечего.
  if (!isNum(current)) return none(null);
  if (!isNum(previous)) return none(input.noBasisReason ?? NO_BASIS_SHORT_ARCHIVE);
  if (kind !== 'stock' && input.coverage && !input.coverage.complete) return none(NO_BASIS_SHORT_ARCHIVE);

  const absolute = current - previous;
  const measured = { absolute, basis: { dates: input.previousWindow ?? null, value: previous }, noBasisReason: null };
  if (pp) return { delta: absolute, unitMode: 'pp', ...measured, ...shell };
  const pct = pctDelta(current, previous);
  if (pct) return { delta: pct.dir === 'down' ? -pct.pct : pct.pct, unitMode: 'pct', ...measured, ...shell };
  return { delta: absolute, unitMode: 'abs', ...measured, ...shell };
}

/**
 * Направление и модуль дельты, как их увидит читатель. Направление считается ПО НАПЕЧАТАННОМУ
 * модулю: «↑0.0%» — заявка на движение, которую опровергает само число (аудит #554), поэтому всё,
 * что округлилось до нуля, — `flat`. `null` — сравнения нет.
 *
 * Точность: процент — один знак, от 100% — целые (как у DeltaPill); п.п. — один знак; абсолютный
 * сдвиг — по единице метрики ролью `headline` (сжатие от 10 000, рубли через formatMoney).
 */
export function deltaParts(c: MetricComparison): { dir: 'up' | 'down' | 'flat'; magnitude: string } | null {
  if (c.delta == null) return null;
  const abs = Math.abs(c.delta);
  let magnitude: string;
  let zero: boolean;
  if (c.unitMode === 'pct') {
    const fixed = abs >= 100 ? abs.toFixed(0) : abs.toFixed(1);
    zero = Number.parseFloat(fixed) === 0;
    magnitude = `${zero ? '0' : fixed}%`;
  } else if (c.unitMode === 'pp') {
    const fixed = abs.toFixed(1);
    zero = Number.parseFloat(fixed) === 0;
    magnitude = `${zero ? '0' : fixed} п.п.`;
  } else {
    zero = Math.round(abs) === 0;
    magnitude = formatMetricNumber(zero ? 0 : abs, c.unit, 'headline');
  }
  return { dir: zero ? 'flat' : c.delta > 0 ? 'up' : 'down', magnitude };
}

/**
 * Один текст дельты: «+12.3%», «−4.5%», «±0%», «+1.2 п.п.», «+531», «−8 200 ₽» или «нет базы».
 * Знак — «+ − ±» (минус — U+2212, как у fmt.numFixed); голос (стрелка пилюли, ▲▼ рейла, цвет)
 * выбирает компонент по `deltaParts`, число и точность — только здесь. `null` — нет самого текущего
 * значения: слоту нечего сказать.
 */
export function formatDelta(c: MetricComparison): string | null {
  const parts = deltaParts(c);
  if (!parts) return c.noBasisReason != null ? NO_BASIS_TEXT : null;
  const sign = parts.dir === 'up' ? '+' : parts.dir === 'down' ? '−' : '±';
  return `${sign}${parts.magnitude}`;
}
