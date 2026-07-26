import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { fmt } from '@/lib/format';

/**
 * Ранжированный разрез как список ДОЛЕЙ. Один дом для всех разрезов продукта (источники Метрики,
 * статусы и каналы МоегоСклада, площадки упоминаний, разбивки кампаний) — до него идиома была
 * скопирована девять раз в семи файлах и всюду расходилась.
 *
 * Форма — горизонтальный ряд с shadcn/charts (bar): подпись, дорожка, значение снаружи справа
 * (`position="right"`), плюс тултип со свотчем оттуда же (charts/tooltip). Одна строка вместо двух
 * (подпись сверху, полоса под ней) — на развороте в тридцать строк это половина высоты, и полоса
 * перестаёт быть украшением под текстом.
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
}: {
  /** Доля ОТ ЦЕЛОГО в процентах (не от максимума — см. шапку файла). */
  pct: number;
  /** Полный `hsl(...)`; по умолчанию — роль основного графика. */
  color?: string;
  height?: string;
  muted?: boolean;
}) {
  return (
    <div className={`${height} min-w-0 flex-1 overflow-hidden rounded-full bg-muted/70`}>
      <div
        className="h-full rounded-full transition-[width] dur-base ease-house"
        style={{
          width: `${Math.max(1.5, Math.min(100, pct))}%`,
          backgroundColor: color ?? `hsl(var(--chart-role-primary) / ${muted ? '0.4' : '0.75'})`,
        }}
      />
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
}: ShareRowsProps) {
  const tipId = useId();
  const [hover, setHover] = useState<string | null>(null);

  // Сервер уже сортирует по убыванию; пересортировка — страховка стабильности вида.
  const ranked = [...rows].sort((a, b) => b.value - a.value || a.key.localeCompare(b.key));
  const denom = Math.max(1, total);
  const pctOf = (v: number) => (Math.max(0, v) / denom) * 100;

  // Хвост сворачивается ТОЛЬКО в компакте. Разворот — полный список по построению: страница
  // разреза для того и открывается, и прятать там строки значило бы отвечать не на заданный
  // вопрос. Длинный список делает читаемым не сокрытие, а доля от целого и накопленный процент.
  const head = expanded ? ranked : ranked.slice(0, compactRows);
  const tail = ranked.slice(head.length);
  const tailValue = tail.reduce((acc, r) => acc + Math.max(0, r.value), 0);

  let running = 0;
  return (
    <div className={expanded ? 'space-y-1.5 pt-1' : 'space-y-1'}>
      {head.map((r) => {
        const pct = pctOf(r.value);
        running += pct;
        const active = hover === r.key;
        return (
          <div
            key={r.key}
            className="relative"
            onMouseEnter={() => setHover(r.key)}
            onMouseLeave={() => setHover((h) => (h === r.key ? null : h))}
          >
            <div className="flex items-center gap-2.5">
              {/* Подпись — СВОЯ колонка, а не внутрь полосы. Приём shadcn «label insideLeft» верен
                  для коротких подписей и длинных полос; у нас подписи русские и длинные, а доли
                  малые, поэтому подпись то не влезает, то висит в пустоте посреди дорожки — и
                  читается чипом-кнопкой. Колонка держит левый край ровным: список сканируется
                  сверху вниз, чего ради он и существует. */}
              <span className="flex w-[42%] min-w-0 max-w-56 shrink-0 items-center gap-1.5 text-xs text-foreground">
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
              <ShareTrack pct={pct} color={active ? 'hsl(var(--chart-role-primary))' : undefined} />
              {/* Значение снаружи справа (shadcn: position="right") — колонка чисел выровнена. */}
              <span className="shrink-0 text-xs tabular-nums">
                <span className="font-medium text-foreground">{format(r.value)}</span>
                {r.note != null && <span className="text-muted-foreground"> · {r.note}</span>}
              </span>
              {cumulative && (
                <span className="w-9 shrink-0 text-right text-2xs tabular-nums text-muted-foreground">
                  {running.toFixed(0)}%
                </span>
              )}
            </div>

            {/* Тултип по наведению: цветной свотч, доля, значение (shadcn → charts/tooltip). До
                этого у списков разрезов hover-читалки не было вовсе — доля нигде не называлась. */}
            {active && (
              <div
                role="tooltip"
                id={`${tipId}-${r.key}`}
                className="pointer-events-none absolute -top-1 left-2 z-30 -translate-y-full rounded-md border border-border bg-popover px-2 py-1.5 text-2xs shadow-md"
              >
                <div className="flex items-center gap-1.5 whitespace-nowrap">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-[2px]"
                    style={{ backgroundColor: 'hsl(var(--chart-role-primary))' }}
                  />
                  <span className="text-muted-foreground">{r.label}</span>
                  <span className="font-medium tabular-nums text-foreground">{format(r.value)}</span>
                  <span className="tabular-nums text-muted-foreground">{pct.toFixed(1)}%</span>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {tail.length > 0 && (
        <div
          className="flex w-full items-center gap-2.5 text-left text-2xs text-muted-foreground"
        >
          <span className="w-[42%] max-w-56 shrink-0 truncate">Прочее · {tail.length}</span>
          <ShareTrack pct={pctOf(tailValue)} color="hsl(var(--muted-foreground) / 0.3)" />
          <span className="shrink-0 tabular-nums">
            Ещё {format(tailValue)} {tailWord} из {format(total)}
          </span>
        </div>
      )}

      {footnote != null && <p className="pt-0.5 text-2xs text-muted-foreground">{footnote}</p>}
    </div>
  );
}
