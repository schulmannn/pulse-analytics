import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { observeSize } from '@/lib/observeSize';

/**
 * ПРАВИЛО ЗАПОЛНЕНИЯ РЯДА — одно на всю раскладку виджетов (аудит #554, D1/D16).
 *
 * Сетка шестиколоночная, а размеры карточек — 2 / 3 / 6 колонок, поэтому арифметика ряда
 * сходится далеко не всегда: M(3) + S(2) занимают пять колонок из шести, и шестая остаётся
 * пустой посреди страницы. Читается это не как «воздух», а как выпавшая карточка.
 *
 * До этого хука дыру затыкали ТРЕМЯ разными способами и все три — только хвостовые:
 *   • JS в WidgetGroup тянул одинокую карточку ПОСЛЕДНЕГО ряда на всю ширину;
 *   • CSS-хак `:last-child:nth-child(odd)` в TgAnalytics делал то же самое иначе;
 *   • на двенадцати поверхностях (СДЭК, Метрика, Rusender, МойСклад, отчёты) сетка вообще
 *     голая — ни того, ни другого, дыра просто жила.
 * Ни один из них не видел ряд ВНУТРИ страницы, где дыра и заметнее всего.
 *
 * Правило теперь одно и общее: в каждом ряду считаем занятые колонки и, если остались
 * свободные, последняя карточка ряда дорастает ровно на этот остаток. Ряд из одной карточки
 * — частный случай: остаток равен всей остальной ширине, карточка становится полноширинной.
 *
 * ЧЕГО ПРАВИЛО НЕ ДЕЛАЕТ:
 *   • не трогает карточки с `data-widget-user-sized` — выбранный владельцем размер авторитетен,
 *     иначе ресайз выглядит сломанным сразу после отпускания мыши;
 *   • не трогает `data-widget-no-stretch` — их содержимое шириной не пользуется (дуга, разбивка,
 *     семь столбцов по дням), и растянутая карточка читается как график посреди пустоты;
 *   • не работает на одноколоночной раскладке (мобильная) — там рядов в этом смысле нет.
 *
 * Пролезть в чужой ряд правило не может: дорост ровно до `cols` оставляет поток остальных
 * карточек неизменным, поэтому пере-раскладка не каскадит.
 *
 * Прямой DOM-стиль вместо state: ни ре-рендеров, ни риска React #185; rAF-хоп по паттерну
 * observeSize. Прогон сначала только ЧИТАЕТ: не изменилась сигнатура раскладки → полный no-op
 * без единой записи в style (прежний write-then-read на каждый rAF форсил reflow всей страницы
 * и не давал RO-циклу угаснуть).
 */

export interface RowFillOptions {
  /** Подписка на стор виджетов: ресайз/скрытие карточки → пере-раскладка. Стабильная ссылка. */
  subscribe?: (cb: () => void) => () => void;
}

/** Сколько колонок занимает карточка: меряем по факту, а не по классу — тогда правило одинаково
 *  работает и для карточек с сохранённым размером, и для чужих детей сетки. */
function spanOf(el: HTMLElement, colW: number, gap: number): number {
  if (colW <= 0) return 1;
  return Math.max(1, Math.round((el.offsetWidth + gap) / (colW + gap)));
}

export function useRowFill(rootRef: RefObject<HTMLElement | null>, options: RowFillOptions = {}): void {
  const { subscribe } = options;
  const stretchedRef = useRef<HTMLElement[]>([]);
  const appliedSigRef = useRef('');

  useEffect(() => {
    let handle = 0;
    // Сигнатура ПРИМЕНЁННОЙ раскладки (ширина корня + offsetLeft:offsetWidth карточек): высоты в
    // неё не входят намеренно — принадлежность ряду и ширины колонок от них не зависят, а именно
    // высоты дёргаются при доезде данных/ховерах и будят RO группы каждый кадр.
    const layoutSig = (root: HTMLElement, els: HTMLElement[]) =>
      `${root.clientWidth}|${els
        .map((el) => `${el.offsetLeft}:${el.offsetWidth}:${el.hasAttribute('data-widget-user-sized') ? 1 : 0}`)
        .join(',')}`;

    const cards = (root: HTMLElement) =>
      ([...root.children] as HTMLElement[]).filter((el) => el.offsetWidth > 0 && el.offsetParent !== null);

    const clear = () => {
      for (const el of stretchedRef.current) el.style.gridColumn = '';
      stretchedRef.current = [];
    };

    const apply = () => {
      const root = rootRef.current;
      if (!root) return;
      // Только чтение на чистом layout'е — reflow не форсится.
      const els = cards(root);
      const sig = layoutSig(root, els);
      if (sig === appliedSigRef.current) return;
      // Раскладка реально изменилась — единственный момент, когда позволены записи в style.
      const hadStretch = stretchedRef.current.length > 0;
      clear();

      const style = getComputedStyle(root);
      const tracks = style.gridTemplateColumns.split(' ').filter(Boolean);
      const colW = Number.parseFloat(tracks[0] ?? '') || 0;
      const gap = Number.parseFloat(style.columnGap) || 0;
      // Одна колонка (мобильная раскладка) или нечитаемые треки — правило молчит.
      if (tracks.length >= 2 && colW > 0) {
        const rows = new Map<number, HTMLElement[]>();
        for (const el of els) {
          const row = rows.get(el.offsetTop);
          if (row) row.push(el);
          else rows.set(el.offsetTop, [el]);
        }
        for (const row of rows.values()) {
          row.sort((a, b) => a.offsetLeft - b.offsetLeft);
          const free = tracks.length - row.reduce((sum, el) => sum + spanOf(el, colW, gap), 0);
          if (free <= 0) continue;
          // Растёт ПОСЛЕДНЯЯ карточка ряда: любая другая вытолкнула бы соседей в следующий ряд.
          const target = row[row.length - 1];
          if (target.hasAttribute('data-widget-user-sized') || target.hasAttribute('data-widget-no-stretch')) continue;
          target.style.gridColumn = `span ${spanOf(target, colW, gap) + free}`;
          stretchedRef.current.push(target);
        }
      }
      // Запоминаем сигнатуру ИТОГОВОЙ раскладки: без записей она равна уже посчитанной, после
      // записей — перемеряем, чтобы следующий прогон no-op'нулся на ней же.
      appliedSigRef.current = hadStretch || stretchedRef.current.length > 0 ? layoutSig(root, els) : sig;
    };

    const schedule = () => {
      cancelAnimationFrame(handle);
      handle = requestAnimationFrame(apply);
    };
    schedule();
    const unsub = subscribe?.(schedule);
    window.addEventListener('resize', schedule);
    // Данные доезжают ПОСЛЕ маунта и меняют высоты карточек БЕЗ notify стора — одноразовый прогон
    // на скелетонах примет решение по неверному layout'у (прод-находка). Рост/сжатие корня группы
    // = единственный надёжный сигнал «раскладка изменилась» → пере-меряем.
    const unobserve = rootRef.current ? observeSize(rootRef.current, schedule) : undefined;
    // Появление/исчезновение карточки может НЕ поменять высоту корня (условная карточка встаёт в
    // уже растянутый хвост), и тогда ResizeObserver промолчит, а ряд поедет. Правки самого правила
    // сюда не возвращаются: мы пишем в style дочерних узлов, а слушаем childList корня.
    const mo =
      typeof MutationObserver !== 'undefined' && rootRef.current ? new MutationObserver(schedule) : null;
    if (mo && rootRef.current) mo.observe(rootRef.current, { childList: true });
    return () => {
      cancelAnimationFrame(handle);
      unsub?.();
      unobserve?.();
      mo?.disconnect();
      window.removeEventListener('resize', schedule);
      clear();
      appliedSigRef.current = '';
    };
  }, [rootRef, subscribe]);
}
