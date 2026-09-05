import type { ReactNode } from 'react';
import { useContext, useRef, useState } from 'react';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { observeSize } from '@/lib/observeSize';
import { useIsoLayoutEffect, useMeasuredBox } from '@/lib/useMeasuredBox';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { fmt } from '@/lib/format';

/**
 * Ранжированный разрез как список ДОЛЕЙ. Один дом для всех разрезов продукта (источники Метрики,
 * статусы и каналы МоегоСклада, площадки упоминаний, разбивки кампаний) — до него идиома была
 * скопирована девять раз в семи файлах и всюду расходилась.
 *
 * Форма — горизонтальный ряд с shadcn/charts (bar): подпись, дорожка, значение и доля снаружи
 * справа (`position="right"`). На узком экране дорожка переносится под текстовую строку: значение
 * не выдавливает подпись и не создаёт горизонтальный overflow.
 *
 * Приём shadcn «label insideLeft» (подпись ВНУТРИ полосы) пробовали и отвергли на реальных данных:
 * он рассчитан на короткие подписи и длинные полосы («January»), а у нас подписи русские и длинные
 * («Переходы из поисковых систем») при малых долях — подпись то не влезает, то повисает в пустоте
 * посреди дорожки, и тёмный текст на заливке читается кнопкой-чипом. Подпись живёт в своей колонке.
 *
 * Саму библиотеку не берём: recharts под нужный набор импортов — 107.7 KB gzip при 15.9 KB
 * свободных в бандл-гейте, и тянет Redux Toolkit ради рисования полосок.
 *
 * ЧТО КОДИРУЕТ ПОЛОСА — доля от ЦЕЛОГО, а не от максимума. Прежние восемь копий делили на максимум,
 * поэтому первая строка всегда была во всю ширину, а хвост — частокол обрубков, и вопрос «сколько
 * это от всего трафика» не отвечался вовсе. `total` обязателен именно поэтому.
 */

/**
 * Сама полоса — один дом для «сколько это от целого». Вынесена отдельно, потому что строки в
 * продукте бывают не только простыми: кликабельный фильтр упоминаний, RFM-сегмент со своим цветом
 * и раскрывающейся сноской, канал продаж с дельтой. Загонять их в общий рендерер значило бы либо
 * раздуть его до свалки пропов, либо потерять поведение — поэтому у них своя разметка, но полоса
 * и её СМЫСЛ общие.
 */
export function ShareTrack({
  pct,
  color,
  height = 'h-2',
  muted = false,
  ariaLabel,
}: {
  /** Доля ОТ ЦЕЛОГО в процентах (не от максимума — см. шапку файла). */
  pct: number;
  /** Полный `hsl(...)`; по умолчанию — роль основного графика. */
  color?: string;
  height?: string;
  muted?: boolean;
  /**
   * Доступное имя полосы. `undefined` даёт каноническое «Доля 12.3%», `null` скрывает
   * декоративный дубль там, где процент уже написан рядом.
   */
  ariaLabel?: string | null;
}) {
  // Визуальная шкала конечна: отрицательное/NaN/Infinity не должны попадать в CSS, а значение
  // >100% не может растянуть layout. Сам исходный конечный процент остаётся в доступном имени —
  // это честнее, чем молча назвать противоречивые 150% сотней.
  const finitePct = Number.isFinite(pct) ? Math.max(0, pct) : 0;
  const widthPct = Math.min(100, finitePct);
  const defaultLabel = `Доля ${finitePct.toFixed(1)}%${
    finitePct > 100 ? ', визуальная шкала ограничена 100%' : ''
  }`;
  const fill = (
    <div
      className="h-full rounded-full transition-[width] dur-base ease-house"
      style={{
        width: `${widthPct}%`,
        backgroundColor: color ?? `hsl(var(--chart-role-primary) / ${muted ? '0.4' : '0.75'})`,
      }}
    />
  );
  if (ariaLabel === null) {
    return (
      <div
        className={`${height} min-w-0 flex-1 overflow-hidden rounded-full bg-muted/70`}
        aria-hidden="true"
        data-share-percent={finitePct}
      >
        {fill}
      </div>
    );
  }
  return (
    <div
      className={`${height} min-w-0 flex-1 overflow-hidden rounded-full bg-muted/70`}
      role="img"
      aria-label={ariaLabel ?? defaultLabel}
      data-share-percent={finitePct}
    >
      {fill}
    </div>
  );
}

export interface ShareRow {
  key: string;
  label: string;
  value: number;
  /** Приписка справа от значения («12.3% CR», «450k ₽»). Узел — строке бывает нужен свой знак. */
  note?: ReactNode;
  /** Приписка ПОСЛЕ подписи (тип канала, сеть) — приглушённая. */
  labelSuffix?: ReactNode;
  /** Точка-метка слева от подписи (палитра статусов МС). */
  dot?: string | null;
}

export interface ShareRowsProps {
  rows: ShareRow[];
  /** Знаменатель долей — итог ПОЛНОГО отчёта. Без него доля не доля. */
  total: number;
  /** Форматирование значения (по умолчанию `fmt.num`). */
  format?: (n: number) => string;
  /** Слово хвоста в родительном множественного: «визитов», «заказов». */
  tailWord: string;
  /** Показать все строки (разворот) вместо топа. */
  expanded?: boolean;
  /** Сколько строк держать в компакте до сворачивания хвоста. */
  compactRows?: number;
  /** Накопленный процент справа — читается «первые пять дают 78%». */
  cumulative?: boolean;
  footnote?: ReactNode;
  /**
   * Имена колонок над списком. Без них правое число — голый абсолют без единицы измерения: «1 240»
   * одинаково читается заказами, рублями и штуками, и разрез отвечает не на тот вопрос, который
   * задан заголовком карточки.
   */
  columns?: { label: string; value: string };
  /** «1 2 3» перед подписью — там, где порядок сам является ответом (товары, каналы, площадки). */
  ranked?: boolean;
}


// Шаг строки списка ДО ПЕРВОГО ЗАМЕРА. Дальше он меряется по факту — см. useRowPitch ниже.
//
// Константа уже один раз разошлась с вёрсткой и порезала карточки. D6 сделал правую колонку
// двухстрочной (число с долей сверху, примечание «1 596 чел. · 24.6% отказов» снизу), строка
// выросла с 26 до ~36px, а делитель остался прежним — вместимость считалась на треть больше
// реальной, и последняя строка вылезала за низ тайла на восьми разрезах Метрики разом
// (аудит #554, проход №2, N1).
//
// Поэтому число здесь — только предположение на первый кадр, а не источник правды: примечание
// приходит из данных, кегль и отступы — из токенов, и обе стороны меняются независимо от этого
// файла. Замер самоисправляется, константа — нет.
const ROW_PITCH_WIDE = 26;
const ROW_PITCH_NARROW = 48;
// Строка хвоста «ещё N» и сноска — не строки списка, но место занимают.
const TAIL_H = 18;
/** Предположение о высоте шапки колонок на ПЕРВЫЙ кадр; дальше она меряется (useMeasuredBox). */
const HEADER_H = 22;

/**
 * Фактический шаг строки списка: расстояние между верхами двух соседних `<li>`.
 *
 * Двух соседних, а не высота одной: между строками стоит `space-y-1`, и шаг — это высота ПЛЮС
 * зазор. При единственной строке зазор взять неоткуда, поэтому там остаётся её собственная высота
 * (ошибка в один зазор ничего не решает: одна строка и так влезает).
 *
 * Состояние обновляется только при расхождении больше пикселя — иначе округления гоняли бы
 * ре-рендер по кругу. Пере-замер по ResizeObserver: ширина тайла меняет и
 * перенос подписи, и число колонок.
 */
function useRowPitch(listRef: React.RefObject<HTMLUListElement | null>, fallback: number): number {
  const [pitch, setPitch] = useState<number | null>(null);
  useIsoLayoutEffect(() => {
    const measure = () => {
      const list = listRef.current;
      if (!list) return;
      const items = list.children as HTMLCollectionOf<HTMLElement>;
      if (items.length === 0) return;
      const next = items.length >= 2 ? items[1].offsetTop - items[0].offsetTop : items[0].offsetHeight;
      if (next > 0) setPitch((prev) => (prev != null && Math.abs(prev - next) <= 1 ? prev : next));
    };
    measure();
    const list = listRef.current;
    return list ? observeSize(list, measure) : undefined;
    // Подписка ставится один раз: дальше ResizeObserver сам будит замер на смене ширины тайла и
    // на смене числа строк (и то и другое меняет высоту списка). Ссылка на ref стабильна.
  }, [listRef]);
  return pitch ?? fallback;
}

export function ShareRows({
  rows,
  total,
  format = fmt.num,
  tailWord,
  expanded = false,
  compactRows = 4,
  cumulative = false,
  footnote = null,
  columns,
  ranked = false,
}: ShareRowsProps) {
  // Сервер уже сортирует по убыванию; пересортировка — страховка стабильности вида. Невалидное
  // число не превращается ни в отрицательную полосу, ни в «NaN»: для part-to-whole это ноль.
  const sorted = rows
    .map((row) => ({
      ...row,
      value: Number.isFinite(row.value) ? Math.max(0, row.value) : 0,
    }))
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  const ctxHeight = useContext(ExpandedChartHeightContext);
  const expandedCtx = useContext(ChartExpandedContext);
  const wideRow = useMediaQuery('(min-width: 640px)');
  const safeTotal = Number.isFinite(total) && total >= 0 ? total : null;
  const denom = safeTotal != null && safeTotal > 0 ? safeTotal : null;
  const pctOf = (v: number) => (denom == null ? null : (v / denom) * 100);
  const pctText = (pct: number | null) => (pct == null ? '—' : `${pct.toFixed(1)}%`);

  // Хвост сворачивается ТОЛЬКО в компакте. Разворот — полный список по построению: страница
  // разреза для того и открывается, и прятать там строки значило бы отвечать не на заданный
  // вопрос. Длинный список делает читаемым не сокрытие, а доля от целого и накопленный процент.
  // Сколько строк показать — СЧИТАЕМ ОТ ВЫСОТЫ ТЕЛА ТАЙЛА, а не от фикс-числа.
  //
  // Фикс-число переполняло карточку там, где строка выше: на мобиле гейт «нет внутренних
  // скроллов» ловил это на тринадцати разрезах Метрики разом (+28px каждый). Но бюджет умел
  // только СЖИМАТЬ ниже compactRows — вырасти до того, что тайл реально вмещает, не мог. На борде
  // Метрики это четыре строки в теле на 181px, куда влезает шесть, — пустая нижняя половина
  // карточки при том, что данные есть и прячутся в хвост «ещё N» (аудит #554, D16).
  //
  // Теперь бюджет — авторитет в ОБЕ стороны, а compactRows остаётся подсказкой для тех мест, где
  // высота не опубликована (страница разреза, оверлей «Развернуть»). Переполнить тайл рост не может:
  // строк ровно floor(бюджет / шаг), а хвост вычтен из бюджета заранее.
  const listRef = useRef<HTMLUListElement | null>(null);
  const rowPitch = useRowPitch(listRef, wideRow ? ROW_PITCH_WIDE : ROW_PITCH_NARROW);
  // Шапка съедает высоту тела ДО первой строки. Не вычесть её — значит нарисовать на строку
  // больше, чем тайл держит: ровно тот клиппинг, ради которого бюджет и считается. Ниже 640px
  // шапки нет вовсе, и её измеренная высота там честный ноль — мобильный бюджет не меняется.
  const { ref: headerRef, height: headerH } = useMeasuredBox(columns ? HEADER_H : 0);
  const room =
    ctxHeight == null ? null : ctxHeight - (sorted.length > compactRows || footnote != null ? TAIL_H : 0);
  // ШАПКА НЕ СТОИТ СТРОКИ ДАННЫХ: имя измерения уже стоит в заголовке карточки, и менять восьмой
  // источник на слово «Источник» — убыточный размен. Где высота не ограничена (страница разреза,
  // разворот) шапка есть всегда. Решение принимается по КОНСТАНТЕ, а бюджет — по ЗАМЕРУ: если бы
  // решение зависело от замера, спрятанная шапка мерилась бы в ноль, снова «влезала» и мигала бы.
  const showHeader =
    columns != null &&
    (room == null ||
      expandedCtx ||
      Math.floor((room - HEADER_H) / rowPitch) === Math.floor(room / rowPitch));
  const budget = room == null ? null : room - (showHeader ? headerH : 0);
  const fitRows = budget == null || expandedCtx ? compactRows : Math.max(1, Math.floor(budget / rowPitch));
  const head = expanded ? sorted : sorted.slice(0, fitRows);
  const tail = sorted.slice(head.length);
  const tailValue = tail.reduce((acc, r) => acc + Math.max(0, r.value), 0);

  let running = 0;
  return (
    <div>
      {showHeader && columns && (
        // Только с sm: — мобильная разметка разреза (двухстрочная строка) не переделывается до
        // отдельного mobile-этапа, а строка заголовков там съела бы данные, ради которых открыт
        // тайл. Сетка та же, что у строк, и последняя колонка в обоих гридах прижата к правому
        // краю — поэтому «Визиты» и «1 240 · 12.3%» стоят на одной вертикали, хотя гриды разные.
        // `role="columnheader"` не проставлен намеренно: без предка role="table" он валит
        // axe-правило aria-required-parent, а список таблицей не является.
        <div
          ref={headerRef}
          data-share-header
          className="hidden gap-x-2.5 border-b border-border pb-1.5 text-2xs tracking-wide text-muted-foreground sm:grid sm:grid-cols-[minmax(7rem,42%)_minmax(3rem,1fr)_auto]"
        >
          <span className="truncate">{columns.label}</span>
          <span aria-hidden="true" />
          <span className="text-right">{columns.value}</span>
        </div>
      )}
      <ul
        ref={listRef}
        aria-label={
          safeTotal == null
            ? `Распределение: ${tailWord}`
            : `Распределение, всего ${format(safeTotal)} ${tailWord}`
        }
        className={expanded ? 'space-y-1.5 pt-1' : 'space-y-1'}
      >
        {head.map((r, i) => {
          const pct = pctOf(r.value);
          if (pct != null) running += pct;
          return (
            <li
              key={r.key}
              className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-2 gap-y-1 sm:grid-cols-[minmax(7rem,42%)_minmax(3rem,1fr)_auto] sm:gap-x-2.5"
            >
              {/* Подпись — СВОЯ колонка, а не внутрь полосы. Приём shadcn «label insideLeft» верен
                  для коротких подписей и длинных полос; у нас подписи русские и длинные, а доли
                  малые, поэтому подпись то не влезает, то висит в пустоте посреди дорожки — и
                  читается чипом-кнопкой. Колонка держит левый край ровным: список сканируется
                  сверху вниз, чего ради он и существует. */}
              <span className="col-start-1 row-start-1 flex min-w-0 items-center gap-1.5 text-xs text-foreground sm:max-w-56">
                {/* Ранг — ПЕРВЫМ в колонке подписи и фиксированной ширины: «третье место» должно
                    читаться без пересчёта строк глазами, а левый край подписей обязан остаться
                    ровным при переходе с однозначных номеров на двузначные. */}
                {ranked && (
                  <span className="w-4 shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
                    {i + 1}
                  </span>
                )}
                {r.dot && (
                  <span
                    aria-hidden="true"
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: r.dot }}
                  />
                )}
                <span className="truncate" title={r.label}>{r.label}</span>
                {r.labelSuffix != null && (
                  <span className="shrink-0 text-2xs text-muted-foreground">{r.labelSuffix}</span>
                )}
              </span>
              <div className="col-span-2 row-start-2 flex min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1">
                <ShareTrack pct={pct ?? 0} ariaLabel={null} />
              </div>
              {/* Значение и ТОЧНАЯ доля постоянно видны: hover больше не является единственным
                  способом прочитать процент на touch, с клавиатуры или скринридером.

                  ДВЕ строки, а не один переносимый ряд. Раньше значение, примечание и доля лежали
                  в одном `flex-wrap`: в узкой карточке хвост переносился, «· 47.0%» оставался
                  сиротой на второй строке, и высота росла ТОЛЬКО у тех строк, где случился
                  перенос — столбик полосок терял ритм (аудит #554, D6). Теперь первая строка —
                  число и доля, она не переносится никогда; длинное примечание («1 596 чел. ·
                  24.6% отказов») уезжает во вторую, вторичным кеглем. */}
              <span className="col-start-2 row-start-1 flex min-w-0 flex-col items-end text-right text-xs tabular-nums sm:col-start-3">
                <span className="flex items-baseline gap-x-1 whitespace-nowrap">
                  <span className="font-medium text-foreground">{format(r.value)}</span>
                  <span role="img" className="text-muted-foreground" aria-label={`Доля ${pctText(pct)}`}>
                    · {pctText(pct)}
                  </span>
                  {cumulative && pct != null && (
                    <span
                      role="img"
                      className="text-2xs text-muted-foreground"
                      aria-label={`Накопленная доля ${pctText(running)}`}
                    >
                      · Σ {pctText(running)}
                    </span>
                  )}
                </span>
                {r.note != null && (
                  <span className="min-w-0 max-w-full truncate text-2xs text-muted-foreground">
                    {r.note}
                  </span>
                )}
              </span>
            </li>
          );
        })}

        {tail.length > 0 && (
          <li className="grid min-w-0 grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-left text-2xs text-muted-foreground sm:grid-cols-[minmax(7rem,42%)_minmax(3rem,1fr)_auto] sm:gap-x-2.5">
            <span className="col-start-1 row-start-1 min-w-0 truncate sm:max-w-56">Прочее · {tail.length}</span>
            <div className="col-span-2 row-start-2 flex min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1">
              <ShareTrack
                pct={pctOf(tailValue) ?? 0}
                color="hsl(var(--muted-foreground) / 0.3)"
                ariaLabel={null}
              />
            </div>
            <span className="col-start-2 row-start-1 min-w-0 text-right tabular-nums sm:col-start-3">
              Ещё {format(tailValue)} {tailWord}
              {safeTotal != null && <> из {format(safeTotal)}</>}
              {' · '}
              <span role="img" aria-label={`Доля ${pctText(pctOf(tailValue))}`}>{pctText(pctOf(tailValue))}</span>
            </span>
          </li>
        )}
      </ul>
      {footnote != null && <p className="pt-0.5 text-2xs text-muted-foreground">{footnote}</p>}
    </div>
  );
}
