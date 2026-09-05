import { useContext } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { EmptyState } from '@/components/EmptyState';
import { formatShare } from '@/lib/breakdownShare';
import { useMeasuredBox } from '@/lib/useMeasuredBox';

interface BreakdownItem {
  label: string;
  value: number;
  display?: string;
  color?: string; // optional HSL color for the bar fill + a leading dot
  /** Доля от полной суммы разбивки (0..1) — печатается ОТДЕЛЬНОЙ колонкой. Проставляется на
      слое данных ДО среза топ-N (см. lib/breakdownShare); части целого получают её, средние и
      коэффициенты — нет. */
  share?: number;
}

/**
 * Имена колонок. Без них правая колонка — голое число без единицы измерения: «71» одинаково
 * читается людьми, просмотрами и процентами, и разбивка отвечает не на тот вопрос, который задан
 * заголовком карточки.
 */
export interface BreakdownColumns {
  /** Заголовок колонки подписи: «Страна», «Источник», «Формат». */
  label: string;
  /** Заголовок колонки значения: «Подписчики», «Визиты». */
  value: string;
}

/** Футер-ссылка на полный список вместо тупиковой строки «+N ещё». */
export interface BreakdownMore {
  /** «Все 12 стран» — число и слово подставляет вызывающий: он знает длину ПОЛНОГО списка. */
  label: string;
  /** Маршрут разбора. */
  to: string;
}

interface BreakdownProps {
  items: BreakdownItem[];
  /** Сколько пикселей тела тайла уже занято соседом (переключателем метрики над списком). Без
      этого разбивка считает высоту по ВСЕМУ телу и рисует на строку больше, чем влезает —
      лишняя обрезается нижней кромкой. */
  reserve?: number;
  columns?: BreakdownColumns;
  /** «1 2 3» слева от подписи — только там, где порядок сам по себе является ответом (гео, каналы,
      источники). У долей одного целого (тональность, состав вовлечённости) номер ничего не значит. */
  ranked?: boolean;
  more?: BreakdownMore;
  /**
   * Одна строка примечания ПОД списком — живой факт о самой разбивке (например: демографией
   * охвачено ≈90% базы), а не подпись колонок и не действие.
   *
   * Живёт внутри разбивки, а не абзацем под сеткой карточек, по двум причинам. Оговорка
   * относится к КОНКРЕТНОМУ списку и считается из его же чисел — под сеткой она читалась как
   * общее правило всех соседних карточек. И только здесь её высота попадает в бюджет строк:
   * снаружи тайла её никто не считал, а внутри она молча срезала бы нижнюю строку.
   */
  footnote?: ReactNode;
}

// One row's vertical pitch: p-2 row (36px) + space-y-2 gap.
const ROW_GAP = 8;
const ROW_PITCH = 44;
/** Высота строки «+N ещё» (text-2xs). Она НЕ строка списка: раньше под неё резервировалась целая
    строка в 44px, и разбивка с переключателем показывала два источника из четырёх вместо трёх. */
const HINT_H = 15;
/** Футер-ссылка выше подсказки: у неё свой отступ под палец/курсор. */
const FOOTER_H = 20;
/** Предположение о высоте шапки на ПЕРВЫЙ кадр; дальше она меряется — см. useMeasuredBox. */
const HEADER_H = 20;
/** Предположение о высоте примечания на ПЕРВЫЙ кадр — одна строка text-2xs; дальше меряется. */
const FOOTNOTE_H = 15;

/**
 * Сколько строк списка реально показать при данном бюджете. Вынесено функцией, потому что счёт
 * нужен ДВАЖДЫ: один раз для бюджета с шапкой, другой — без неё (см. `headerFits` ниже).
 */
function fitCount(total: number, avail: number | null, expanded: boolean, tailH: number): number {
  if (avail == null) return total;
  // n строк занимают n*pitch − gap; в развороте высота не ограничивает — там полный список.
  const fitAll = expanded ? total : Math.max(2, Math.floor((avail + ROW_GAP) / ROW_PITCH));
  if (total <= fitAll) return total;
  return Math.max(1, Math.floor((avail - tailH) / ROW_PITCH));
}

export function Breakdown({ items, reserve = 0, columns, ranked = false, more, footnote }: BreakdownProps) {
  // Inside a fixed-height tile the card feeds its body height here — show only the rows that
  // FIT plus a «+N ещё» line, so a widget never scrolls (steep). The expand overlay
  // (ChartExpandedContext) and free-height surfaces keep the full list.
  const expanded = useContext(ChartExpandedContext);
  const ctxHeight = useContext(ExpandedChartHeightContext);
  const { ref: headerRef, height: headerH } = useMeasuredBox(columns ? HEADER_H : 0);
  // Примечание меряется по той же причине, что и шапка: на узкой карточке текст переносится во
  // вторую строку, и константа обещала бы бюджету на 15px меньше, чем занято, — ровно те лишние
  // пиксели, которыми нижняя строка уезжает под кромку (замерено на 430px). Замер не зациклится:
  // примечание рисуется всегда, его высота от собственной видимости не зависит.
  const { ref: footRef, height: footH } = useMeasuredBox(footnote != null ? FOOTNOTE_H : 0);

  if (!items || items.length === 0) {
    return <EmptyState compact size="chart" ghost="rows" title="Нет данных" />;
  }

  // Внутри фикс-тайла строки ДЕЛЯТ высоту тела поровну, а не жмутся к верхней кромке: у разбивки
  // из трёх строк (например «Тональность реакций») нижняя треть карточки пустовала, тогда как
  // соседние разбивки из четырёх строк заполняли тайл. Потолок строки (max-h-14) не даёт двум
  // строкам разъехаться в толстые полосы. Оверлей «Развернуть» и страничные поверхности живут
  // свободной высотой — там прежний естественный ритм.
  const fillSlot = !expanded && ctxHeight != null;
  const tailH = more ? FOOTER_H : HINT_H;
  // Примечание вычитается из бюджета ДО решения о шапке — и это осознанный размен, а не экономия
  // пикселей. Замерено на «Возрасте» демо (тело тайла 181px, семь групп): не пройди примечание
  // через бюджет, оно съело бы ТРЕТЬЮ строку данных из трёх. Пройдя — вытесняет ШАПКУ, по уже
  // принятому здесь правилу «шапка не стоит строки данных»: имена колонок повторяют заголовок
  // карточки, а охват демографии не повторяет ничего.
  const footBudget = footnote != null && footH > 0 ? footH + ROW_GAP : 0;
  const room = ctxHeight != null ? ctxHeight - reserve - footBudget : null;

  // ШАПКА НЕ СТОИТ СТРОКИ ДАННЫХ. В фикс-тайле она съедает половину строки, и на тесном S-тайле
  // вытеснила бы восьмой язык ради слова «Язык» — а имя измерения уже стоит в заголовке карточки,
  // поэтому такой размен убыточен. Где высота не ограничена (страница разреза, разворот) шапка
  // есть всегда.
  //
  // Решение принимается по КОНСТАНТЕ, а бюджет ниже — по ЗАМЕРУ. Если бы решение зависело от
  // замера, спрятанная шапка мерилась бы в ноль, снова «влезала» бы и мигала каждый кадр.
  const headerFits =
    room == null ||
    expanded ||
    fitCount(items.length, room - (HEADER_H + ROW_GAP), expanded, tailH) ===
      fitCount(items.length, room, expanded, tailH);
  const showHeader = columns != null && headerFits;

  // Шапка занимает СВОЮ высоту плюс зазор до первой строки (gap-2 / space-y-2). Не вычесть их —
  // значит нарисовать на строку больше, чем тайл держит: ровно тот клиппинг, ради которого
  // бюджет и считается. Ниже 640px шапка скрыта и меряется в ноль, поэтому мобильный бюджет
  // остаётся прежним.
  const headBudget = showHeader && headerH > 0 ? headerH + ROW_GAP : 0;
  const avail = room != null ? room - headBudget : null;
  const shown = items.slice(0, fitCount(items.length, avail, expanded, tailH));
  const extra = items.length - shown.length;

  // ОТНОСИТЕЛЬНО КРУПНЕЙШЕЙ строки, а не доля от целого — и это осознанно, в отличие от полос в
  // ShareRows/ShareTrack, где доля обязательна. Заливка идёт ПОД ПОДПИСЬЮ, и на долях она
  // перестаёт быть мерой: проверено на этой же карточке — при семи днях недели (7…19% каждый)
  // тинт схлопывается в чип за подписью, и разница между 10.4k и 4k пропадает, тогда как при
  // делении на лидера ранжирование видно сразу. «Относительно крупнейшего» — правдивое
  // утверждение, просто другое; долю называет своя колонка.
  const maxValue = Math.max(...items.map((item) => item.value), 1);
  const showShare = items.some((item) => item.share != null);

  // Одна сетка на шапку и на строки. Хвостовая колонка доли фиксирована (3rem), поэтому граница
  // между значением и долей стоит на одном и том же расстоянии от правого края в ОБОИХ гридах —
  // правые края «Подписчики» и «1 310» совпадают, хотя гриды разные. Ширины в inline-стиле, а не
  // в классе: Tailwind не видит склеенных из условий имён классов и вырезал бы такой шаблон.
  const gridStyle = {
    gridTemplateColumns: [ranked ? '1rem' : null, 'minmax(0,1fr)', 'auto', showShare ? '3rem' : null]
      .filter(Boolean)
      .join(' '),
  };

  return (
    <div className={fillSlot ? 'flex h-full flex-col gap-2' : 'space-y-2'}>
      {showHeader && columns && (
        // Ниже 640px шапки нет: мобильная разметка разбивки не переделывается до отдельного
        // mobile-этапа, а строка заголовков там съела бы данные, ради которых открыт тайл.
        // `role="row"/"columnheader"` СОЗНАТЕЛЬНО не проставлены: без предка role="table" они
        // валят axe-правило aria-required-parent, а список таблицей не является — подпись,
        // значение и доля и так читаются подряд в каждой строке.
        <div
          ref={headerRef}
          data-breakdown-header
          className="hidden shrink-0 items-center gap-x-2 border-b border-border px-2 pb-1 text-2xs tracking-wide text-muted-foreground sm:grid"
          style={gridStyle}
        >
          {ranked && <span aria-hidden="true" />}
          <span className="truncate">{columns.label}</span>
          <span className="text-right">{columns.value}</span>
          {showShare && <span className="text-right">Доля</span>}
        </div>
      )}
      {shown.map((item, i) => {
        const percentage = (item.value / maxValue) * 100;
        // Fill alpha is a theme token (--row-tint-*): the light-theme 0.15 pastel turns muddy
        // olive-brown on the dark canvas, so dark ships lower alphas; the coloured dot next to
        // the label stays the category signal in both themes.
        const bgStyle = item.color
          ? { backgroundColor: item.color, opacity: 'var(--row-tint-colored, 0.15)' }
          : { backgroundColor: 'hsl(var(--chart-role-primary))', opacity: 'var(--row-tint-neutral, 0.08)' };

        return (
          <div
            key={i}
            className={`relative grid items-center gap-x-2 overflow-hidden rounded p-2${
              fillSlot ? ' min-h-9 max-h-12 flex-1' : ''
            }`}
            style={gridStyle}
          >
            {ranked && (
              <span className="text-right text-2xs tabular-nums text-muted-foreground">{i + 1}</span>
            )}
            {/* Заливка живёт В ЯЧЕЙКЕ ПОДПИСИ, а не под всей строкой: значение, лежащее на тинте,
                читалось частью полосы, и правая колонка теряла ровный край. `self-stretch` тянет
                ячейку на всю высоту строки (в фикс-тайле строка выше своего контента), а
                отрицательные -left-2/-top-2/-bottom-2 добирают паддинг строки, чтобы полоса
                начиналась от кромки карточки — правый край при этом остаётся ровно на доле
                ЯЧЕЙКИ, а не строки. */}
            <span className="relative flex min-w-0 items-center gap-1.5 self-stretch text-sm font-medium text-foreground">
              <span
                aria-hidden="true"
                className="absolute -bottom-2 -left-2 -top-2 rounded-sm transition-[width] dur-base ease-house"
                style={{ width: `calc(${percentage}% + 0.5rem)`, ...bgStyle }}
              />
              {item.color && (
                <span
                  className="relative h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: item.color }}
                  aria-hidden="true"
                />
              )}
              <span className="relative truncate">{item.label}</span>
            </span>
            <span className="text-right text-sm tabular-nums text-foreground">
              {item.display ?? item.value}
            </span>
            {showShare && (
              <span className="text-right text-xs tabular-nums text-muted-foreground">
                {item.share != null ? formatShare(item.share) : ''}
              </span>
            )}
          </div>
        );
      })}
      {extra > 0 &&
        (more ? (
          // Ссылка, а не подсказка: «+N ещё — в «Развернуть»» называет спрятанное, но идти за ним
          // некуда. Клик по ссылке НЕ открывает карточку вторым переходом — карточный жест
          // (ChartSection) сам пропускает клики внутри `a`, поэтому stopPropagation тут лишний.
          <Link
            to={more.to}
            className="shrink-0 px-2 text-2xs font-medium text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            {more.label} →
          </Link>
        ) : (
          <div className="shrink-0 px-2 text-2xs text-muted-foreground">+{extra} ещё — полный список в «Развернуть»</div>
        ))}
      {/* Полный muted, а не приглушённый: у примечания ЕСТЬ что сказать, и это текст, а не
          декорация. Прежний `muted-foreground/70` того же абзаца под сеткой даёт 2.96 на светлой
          карточке и 3.59 на тёмной (посчитано по палитрам index.css той же формулой, что и в
          scripts/contrast-tokens.mjs) — обе ниже AA 4.5; полный токен даёт 5.48 и 6.08. */}
      {footnote != null && (
        <div ref={footRef} data-breakdown-footnote className="shrink-0 px-2 text-2xs text-muted-foreground">
          {footnote}
        </div>
      )}
    </div>
  );
}
