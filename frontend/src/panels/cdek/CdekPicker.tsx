import { useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * Выбор значений фильтра СПИСКОМ — устройство Steep, снятое замером живой панели (владелец:
 * «сделай выбор вариантов в фильтре через список, как у Steep»):
 *
 *   строка-токен   значок поиска 16px слева, чипы выбранного тут же, ввод растёт следом
 *   список         строки 32px, только НЕвыбранные: выбранное уже стоит чипом выше
 *
 * Почему не пилюли-переключатели, как было: набор пилюль читается как «шесть равных кнопок», и
 * выбранное от невыбранного отличается только заливкой. Список отвечает на другой вопрос — «что
 * ещё можно добавить», — и потому не растёт вширь: пять каналов и триста товаров выглядят
 * одинаково, а раньше товары требовали своего, отдельно написанного списка с поиском.
 *
 * Одна оговорка против Steep: когда снять последнее значение нельзя (статусы — пустой набор там
 * значит канон, а не «ничего»), у последнего чипа просто нет крестика. Гасить его нечем: крестика
 * либо нет, либо он работает.
 */
export interface CdekPickerOption {
  id: string;
  label: string;
}

/** Поиск появляется, когда глазами уже не найти. Пять каналов и шесть статусов ищут глазами. */
const SEARCH_FROM = 8;

export function CdekPicker({
  options,
  selected,
  onChange,
  mark,
  ariaLabel,
  max,
  lockLast = false,
  emptyHint,
}: {
  options: readonly CdekPickerOption[];
  selected: readonly string[];
  onChange: (ids: string[]) => void;
  /** data-атрибут ветки — на него смотрят e2e (у каждой оси свой якорь). */
  mark: string;
  ariaLabel: string;
  /** Потолок числа значений (товары: дальше запрос не влезает в URL). */
  max?: number;
  /** Последнее значение снять нельзя — см. комментарий выше. */
  lockLast?: boolean;
  /** Подпись пустого списка вариантов. */
  emptyHint?: string;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLocaleLowerCase('ru-RU');
  const chosen = options.filter((o) => selected.includes(o.id));
  const rest = options.filter(
    (o) => !selected.includes(o.id) && (!needle || o.label.toLocaleLowerCase('ru-RU').includes(needle)),
  );
  const full = max != null && selected.length >= max;
  const locked = lockLast && chosen.length <= 1;
  const searchable = options.length >= SEARCH_FROM;

  const add = (id: string) => {
    if (full) return;
    onChange([...selected, id]);
    setQuery('');
  };
  const drop = (id: string) => {
    if (locked) return;
    onChange(selected.filter((x) => x !== id));
  };

  return (
    <div {...{ [`data-${mark}`]: '' }}>
      <div className="flex flex-wrap items-center gap-1 rounded-md border border-border bg-background px-2 py-1">
        <svg viewBox="0 0 16 16" className="h-4 w-4 shrink-0 text-muted-foreground" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
          <circle cx="7.2" cy="7.2" r="4.2" />
          <path d="M10.4 10.4L13.5 13.5" strokeLinecap="round" />
        </svg>
        {chosen.map((o) => (
          <span
            key={o.id}
            className={cn(
              'inline-flex h-6 max-w-full items-center gap-1 rounded-full border border-primary/20 bg-primary/10 pl-2 text-xs text-accent-foreground',
              locked ? 'pr-2' : 'pr-1',
            )}
          >
            <span className="truncate">{o.label}</span>
            {!locked && (
              <button
                type="button"
                aria-label={`Убрать: ${o.label}`}
                onClick={() => drop(o.id)}
                className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-primary/15 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
              >
                <svg viewBox="0 0 16 16" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </span>
        ))}
        {searchable && (
          <input
            type="text"
            aria-label={`Поиск: ${ariaLabel}`}
            placeholder={chosen.length > 0 ? '' : 'Найти'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-6 w-8 min-w-0 grow border-0 bg-transparent px-0.5 text-xs text-foreground outline-hidden placeholder:text-muted-foreground"
          />
        )}
      </div>

      {full && (
        <p className="mt-1.5 px-1 text-2xs text-muted-foreground">
          Выбрано максимум — {max}. Снимите лишний, чтобы добавить другой.
        </p>
      )}

      <div className="mt-1 max-h-56 overflow-y-auto" role="listbox" aria-label={ariaLabel}>
        {rest.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted-foreground">
            {chosen.length === options.length ? (emptyHint ?? 'Выбрано всё.') : 'Ничего не нашлось.'}
          </p>
        ) : (
          rest.map((o) => (
            <button
              key={o.id}
              type="button"
              role="option"
              aria-selected={false}
              disabled={full}
              onClick={() => add(o.id)}
              className="flex min-h-11 w-full items-center rounded-md px-2 text-left text-xs text-ink2 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40 disabled:pointer-events-none disabled:opacity-45 sm:min-h-8"
            >
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
