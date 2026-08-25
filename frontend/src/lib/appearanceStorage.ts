/**
 * Хранилище пользовательской темы — та её часть, которая ОБЯЗАНА лежать в оболочке.
 *
 * Тема разнесена на три слоя, и это не эстетика, а бюджет бандла (frontend/scripts/check-bundle-size):
 *  1. `appearanceStorage` (здесь, в замыкании оболочки) — ключи, чтение выбора и мостик к
 *     аккаунтному sync. Ни цвета, ни математики: аккаунтному blob'у нужен только сам выбор.
 *  2. `appearance` (ленивый) — React-стор, применение CSS и запись. Поднимается, когда выбор
 *     реально меняется: студия «Оформление» или расхождение с другим устройством.
 *  3. `appearanceTheme` (ленивый) — палитры, контрастные солверы, генератор CSS.
 *
 * Пользователь на каноне не грузит ни байта сверх этого файла.
 */
export interface AppearanceSettings {
  /** Акцент: --primary/--ring/--accent/--brand-iris (и, через них, роль primary у графиков). */
  accent: string;
  /** Нейтраль: холст, панели, hairline'ы и шкала чернил. Меняет только тон, не светлоту. */
  base: string;
  /** Палитра данных: --chart-1..6 + категориальные и последовательные производные. */
  chart: string;
  /** Радиус панелей (и связанное семейство rounded-xl/2xl/3xl). */
  radius: string;
  /** Шрифт интерфейса. */
  font: string;
}

export const APPEARANCE_KEYS = ['accent', 'base', 'chart', 'radius', 'font'] as const;

/**
 * Канон. Инвариант всей подсистемы: каждый ключ со значением `canon` не печатает НИЧЕГО, поэтому
 * дефолтный пользователь получает `src/index.css` буква в букву — все существующие контраст-гейты
 * и e2e остаются авторитетными.
 */
export const APPEARANCE_DEFAULT: AppearanceSettings = {
  accent: 'canon',
  base: 'canon',
  chart: 'canon',
  radius: 'canon',
  font: 'canon',
};

/** Выбор (короткие ключи). Дублируется в аккаунтный blob — см. widgetPrefsStore. */
export const APPEARANCE_KEY = 'pulse_appearance';
/** Посчитанный CSS. Читает `public/theme-boot.js` до первого кадра — менять ключ синхронно. */
export const APPEARANCE_CSS_KEY = 'pulse_appearance_css';
/**
 * Штамп генератора в первой строке кэша. Поднимается ВМЕСТЕ с любой правкой палитр в
 * `appearanceTheme.ts` и ЗЕРКАЛИТСЯ в `public/theme-boot.js`: несовпадение = кэш не вставляется до
 * первого кадра, а оболочка пересчитывает его на монтировании. Без штампа пользователь с
 * сохранённой темой годами носил бы CSS от старой таблицы палитр.
 */
export const APPEARANCE_CSS_VERSION = '1';
/** Id <style>-узла. Тоже зеркалится в theme-boot.js. */
export const APPEARANCE_STYLE_ID = 'pulse-appearance';

export const isCanonAppearance = (settings: AppearanceSettings): boolean =>
  APPEARANCE_KEYS.every((key) => settings[key] === 'canon');

export const sameAppearance = (a: AppearanceSettings, b: AppearanceSettings): boolean =>
  APPEARANCE_KEYS.every((key) => a[key] === b[key]);

/**
 * Санитайзер входа — и для localStorage, и для аккаунтного blob'а. Значения уходят в генератор
 * CSS, поэтому пропускаем только короткие enum-подобные слова; всё остальное читается как канон.
 */
export function parseAppearance(raw: unknown): AppearanceSettings {
  const next = { ...APPEARANCE_DEFAULT };
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return next;
  for (const key of APPEARANCE_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (typeof value === 'string' && /^[a-z][a-z0-9-]{0,23}$/.test(value)) next[key] = value;
  }
  return next;
}

/** Сырой выбор из localStorage; null — канон либо недоступное хранилище. */
export function readStoredAppearance(): AppearanceSettings | null {
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY);
    if (!raw) return null;
    const settings = parseAppearance(JSON.parse(raw));
    return isCanonAppearance(settings) ? null : settings;
  } catch {
    return null;
  }
}

/** Тема выбрана, но её прерисовочный кэш устарел или не вставился — нужен пересчёт. */
export function appearanceCacheStale(): boolean {
  if (!readStoredAppearance()) return false;
  if (typeof document !== 'undefined' && !document.getElementById(APPEARANCE_STYLE_ID)) return true;
  try {
    const cached = localStorage.getItem(APPEARANCE_CSS_KEY) ?? '';
    return cached.slice(0, cached.indexOf('\n')) !== APPEARANCE_CSS_VERSION;
  } catch {
    return true;
  }
}

// ── Мостик в аккаунтный sync ──────────────────────────────────────────────────────────────────
let syncHook: (() => void) | null = null;

/** widgetPrefsStore регистрирует сюда свой debounce-push (и снимает его при размонтировании). */
export function setAppearanceSyncHook(hook: (() => void) | null): void {
  syncHook = hook;
}

export function notifyAppearanceChanged(): void {
  syncHook?.();
}
