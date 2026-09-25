import type { DateRange, PeriodDays } from '@/lib/period';

/**
 * Окно ленты, ОБЩЕЕ для всех сетей и переживающее перемонтирование.
 *
 * Зачем: `PagePeriodProvider` держал days/range в обычном стейте React, а провайдер у каждой сети
 * СВОЙ (TG / IG / МойСклад / Метрика монтируют по экземпляру). Переход на источник другой сети
 * создавал новый провайдер, тот стартовал с дефолта, и выбранное окно исчезало — особенно заметно
 * на своём периоде, который вдобавок инициализировался как null (владелец: «выбрал кастомный
 * таймфрейм, перешёл на другой источник — сбросился»).
 *
 * Поэтому окно живёт здесь: один модульный store на приложение + запись в localStorage. Провайдеры
 * становятся его читателями, и смена сети больше ничего не теряет.
 *
 * Почему НЕ per-channel: «за какой срок я смотрю» — это вопрос пользователя, а не канала. Разные
 * окна на разных источниках как раз и мешали бы их сравнивать.
 */

const STORAGE_KEY = 'pulse_page_period';

export interface PagePeriodState {
  days: PeriodDays;
  /** Свой период (epoch ms). Пусто = действует пресет `days`. */
  range: DateRange | null;
}

const VALID_DAYS: readonly PeriodDays[] = [7, 30, 90, 0];

/** Разбор сохранённого значения. Любая кривизна → null (нет выбора), а не молчаливый дефолт. */
export function parsePagePeriod(raw: string | null | undefined): PagePeriodState | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { days, range } = parsed as { days?: unknown; range?: unknown };
    if (!VALID_DAYS.includes(days as PeriodDays)) return null;
    let parsedRange: DateRange | null = null;
    if (typeof range === 'object' && range !== null) {
      const { from, to } = range as { from?: unknown; to?: unknown };
      // Диапазон принимаем только целиком и в правильном порядке: половинчатый бросил бы карточки
      // в окно, которого пользователь не выбирал.
      if (Number.isFinite(from) && Number.isFinite(to) && (from as number) <= (to as number)) {
        parsedRange = { from: from as number, to: to as number };
      }
    }
    return { days: days as PeriodDays, range: parsedRange };
  } catch {
    return null;
  }
}

function read(): PagePeriodState | null {
  try {
    return parsePagePeriod(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function write(state: PagePeriodState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* приватный режим / переполненное хранилище — персист не обязателен для работы */
  }
}

let state: PagePeriodState | null = read();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribePagePeriod(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Снимок для useSyncExternalStore. null = пользователь ещё ничего не выбирал. */
export function getPagePeriod(): PagePeriodState | null {
  return state;
}

/** Пресет: свой период при этом снимается — иначе он молча пережил бы клик по «30д». */
export function setPagePeriodDays(days: PeriodDays): void {
  state = { days, range: null };
  write(state);
  emit();
}

export function setPagePeriodRange(range: DateRange | null, days: PeriodDays): void {
  state = { days, range };
  write(state);
  emit();
}

/** Только для тестов: вернуть модуль в исходное состояние. */
export function resetPagePeriodForTest(): void {
  state = null;
  listeners.clear();
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* нечего чистить */
  }
}
