import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

/**
 * Синхронный hover графиков одной страницы (паттерн Recharts syncId; ресёрч полировки 2026-07-28):
 * наведение на точку в одном графике подсвечивает ТУ ЖЕ дату crosshair-ом во всех соседях.
 *
 * Ключ — ПОДПИСЬ точки (label, «3 июл.»): все карточки страницы делят одно окно и один форматтер
 * дат, так что подпись и есть календарная идентичность точки — без прокладки ISO-дат через каждый
 * производный ряд. Подписи БЕЗ ГОДА, поэтому фолловеры подсвечивают только ОДНОЗНАЧНЫЕ совпадения
 * (label встречается в серии ровно один раз — см. гард в LineChart/Sparkline): на окнах длиннее
 * года дубль «3 июл.» двух лет честно не подсвечивается вместо вранья прошлогодней точкой (ревью).
 * Несовпадающие грануляции (дневная карточка против недельной) так же честно молчат.
 *
 * Публикация ВЛАДЕЛЬЧЕСКАЯ (ревью): publish(null, owner) гасит контекст только если последняя
 * публикация принадлежит этому же владельцу — blur одного графика не затирает живой hover другого
 * (клавиатурный фокус на A + мышь на B: blur A раньше ронял всю подсветку страницы).
 *
 * Провайдер ставится НА СТРАНИЦУ с общим окном (Обзоры TG/IG/Метрики, /analytics «Динамика»).
 * На Главной его нет: там у виджетов собственные периоды, совпадение подписей было бы ложью.
 * Это не анимация — reduced-motion не касается. Тултип показывает только график под курсором;
 * соседям достаётся crosshair + точка (+readout у спарклайнов) — иначе страница кричит.
 */
interface ChartHoverSync {
  /** Подпись наведённой точки или null (никто не наведён). */
  day: string | null;
  /** owner — стабильный id графика (useId): гасить можно только СВОЮ публикацию. */
  publish: (day: string | null, owner: string) => void;
}

const ChartHoverSyncContext = createContext<ChartHoverSync | null>(null);

export function ChartHoverSyncProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ day: string; owner: string } | null>(null);
  const publish = useCallback((day: string | null, owner: string) => {
    setState((current) => {
      if (day == null) return current && current.owner === owner ? null : current;
      return { day, owner };
    });
  }, []);
  const value = useMemo(() => ({ day: state?.day ?? null, publish }), [state, publish]);
  return <ChartHoverSyncContext.Provider value={value}>{children}</ChartHoverSyncContext.Provider>;
}

/** null вне провайдера — график живёт одиночным hover-ом, как раньше. */
export function useChartHoverSync(): ChartHoverSync | null {
  return useContext(ChartHoverSyncContext);
}

/** Индекс ОДНОЗНАЧНОГО совпадения подписи в серии; −1 при отсутствии ИЛИ дубле (окна >года —
    «3 июл.» двух лет: honest-молчание вместо прошлогодней точки). */
export function uniqueLabelIndex(labels: ReadonlyArray<string>, day: string): number {
  const first = labels.indexOf(day);
  if (first < 0) return -1;
  return labels.lastIndexOf(day) === first ? first : -1;
}
