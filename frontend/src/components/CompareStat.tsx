import type { ReactNode } from 'react';
import { KpiValue } from '@/components/chartWidget/KpiValue';
import { DeltaNote, DeltaPill, deltaBasisTitle, deltaLabel } from '@/components/DeltaPill';
import type { DeltaBasis } from '@/components/DeltaPill';
import type { MetricDelta } from '@/lib/delta';

/**
 * Голова S-карточки (`CompactStatHeadline`) и стат без графика (`StackedStat`) — компактные тела
 * третьих карточек TG и IG. Прежние двухстолбиковые CompareStat/CompareBar и композиционный
 * CompositionStat нигде не монтировались и снесены (CARDS-17): S-карточки давно рисуют искру
 * активного окна.
 */

/**
 * ГОЛОВА S-КАРТОЧКИ — число и дельта на ОДНОЙ базовой линии, слева. Опциональная
 * кнопка разбора несёт общеприложенческую a11y-подпись «Разбор: …».
 *
 * СЛОТ ДЕЛЬТЫ ДЕРЖИТСЯ ВСЕГДА (аудит #554, D9). Раньше «Ср. охват» печатал голое
 * число (пары окон нет → DeltaPill отдавал null), а соседние «Реакции» — число со стрелкой:
 * две карточки одного размера в одном ряду читались как карточки разных типов. Теперь слот говорит
 * всегда и говорит честно: «0%» — сравнили и изменений нет, «нет базы» — сравнивать НЕ С ЧЕМ.
 * Сам DeltaPill не трогаем: его молчание на flat — канон для разбора и таблиц сравнения.
 *
 * `deltaText` — честные «п.п.» там, где относительный процент от процента был бы ложью (ER); выигрывает у пилюли.
 *
 * `basis` — с ЧЕМ сравнили (даты базы и её число). Подсказка стоит на ЛЮБОМ варианте слота:
 * в леджере половина карточек печатает `deltaText`, а не пилюлю, и повесить основание только на
 * пилюлю значило бы оставить их без него.
 *
 * МОЛЧАЩИЙ СЛОТ ГОВОРИТ «нет базы», а не «— к пред.»: прежний текст ссылался на
 * «пред.», которого читатель нигде не видел, и читался как сбой загрузки. Причину
 * приносит `noBasisReason` — её знает только считающий.
 */
export function CompactStatHeadline({
  text,
  delta,
  deltaText,
  basis,
  noBasisReason,
  onDrill,
  drillLabel,
  live,
}: {
  text: string;
  delta?: MetricDelta | null;
  deltaText?: string | null;
  basis?: DeltaBasis | null;
  noBasisReason?: string;
  onDrill?: () => void;
  drillLabel?: string;
  live: boolean;
}) {
  const basisTitle = basis ? deltaBasisTitle(basis) : undefined;
  return (
    <div className="flex items-baseline gap-2">
      <KpiValue
        text={text}
        onDrill={onDrill && live ? onDrill : undefined}
        drillLabel={drillLabel}
      />
      {live ? (
        deltaText ? (
          <DeltaNote text={deltaText} title={basisTitle} />
        ) : deltaLabel(delta) ? (
          <DeltaPill delta={delta} basis={basis} />
        ) : delta ? (
          <DeltaNote text="0%" title={basisTitle} />
        ) : (
          <DeltaNote text="нет базы" title={noBasisReason} />
        )
      ) : null}
    </div>
  );
}

/**
 * СТАТ БЕЗ ГРАФИКА — та же анатомия, что у соседей по ряду: число и дельта одной строкой
 * слева, внизу — одна пояснительная строка вместо искры.
 *
 * БЫЛО ЦЕНТРИРОВАНИЕ (референс владельца, 2026-08-14): крупный процент по центру тела,
 * строкой ниже — сравнение с прошлым периодом. Аудит #554 (D9) снял его: три соседние
 * карточки одного размера держали три разные оси выравнивания, и ряд читался как три разные
 * карточки вместо одной семьи. Всё остальное из того решения цело: графика здесь по-прежнему
 * нет, дельта ER остаётся в честных «п.п.», пояснение стоит внизу тем же тихим набором.
 */
export function StackedStat({
  text,
  delta,
  deltaText,
  basis,
  noBasisReason,
  onDrill,
  drillLabel,
  live,
  note,
}: {
  text: string;
  delta?: MetricDelta | null;
  deltaText?: string | null;
  basis?: DeltaBasis | null;
  noBasisReason?: string;
  onDrill?: () => void;
  drillLabel?: string;
  live: boolean;
  note?: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col justify-between gap-4">
      <CompactStatHeadline
        text={text}
        delta={delta}
        deltaText={live ? deltaText : null}
        basis={basis}
        noBasisReason={noBasisReason}
        onDrill={onDrill}
        drillLabel={drillLabel}
        live={live}
      />
      {note ? <p className="text-2xs leading-relaxed text-muted-foreground">{note}</p> : null}
    </div>
  );
}
