import { useSyncExternalStore } from 'react';
import {
  APPEARANCE_CSS_KEY,
  APPEARANCE_CSS_VERSION,
  APPEARANCE_DEFAULT,
  APPEARANCE_KEY,
  APPEARANCE_STYLE_ID,
  appearanceCacheStale,
  isCanonAppearance,
  notifyAppearanceChanged,
  parseAppearance,
  readStoredAppearance,
  sameAppearance,
  type AppearanceSettings,
} from '@/lib/appearanceStorage';

/**
 * Применение пользовательской темы: React-стор поверх localStorage и вставка посчитанного CSS.
 *
 * Ленивый слой (см. заголовок `appearanceStorage`): в оболочку не едет — он поднимается только
 * когда выбор меняется. Таблиц палитр здесь тоже нет, их держит ещё более поздний
 * `appearanceTheme`; отсюда до него один динамический импорт, и он уже загружен, если открыта
 * студия «Оформление».
 */

// ── Стор (localStorage-first, как виджет-префы) ────────────────────────────────────────────────
let current: AppearanceSettings | null = null;
const listeners = new Set<() => void>();

/** Текущий выбор. Снимок стабилен по ссылке — useSyncExternalStore не зациклится. */
export function getAppearance(): AppearanceSettings {
  if (current == null) current = readStoredAppearance() ?? { ...APPEARANCE_DEFAULT };
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAppearance(): AppearanceSettings {
  return useSyncExternalStore(subscribe, getAppearance, () => APPEARANCE_DEFAULT);
}

/**
 * Вставляет/снимает <style> с пользовательскими переменными. Правило БЕЗ каскадного слоя, а весь
 * канон живёт в `@layer base`/`@layer theme` — незаслоённое объявление выигрывает у любого
 * заслоённого независимо от специфичности и порядка, поэтому ничего не нужно переспецифицировать.
 */
export function applyAppearanceCss(css: string): void {
  if (typeof document === 'undefined') return;
  const existing = document.getElementById(APPEARANCE_STYLE_ID);
  if (!css) {
    existing?.remove();
    return;
  }
  const node = existing ?? document.createElement('style');
  if (!existing) {
    node.id = APPEARANCE_STYLE_ID;
    document.head.appendChild(node);
  }
  if (node.textContent !== css) node.textContent = css;
}

function persistSettings(settings: AppearanceSettings): void {
  try {
    if (isCanonAppearance(settings)) localStorage.removeItem(APPEARANCE_KEY);
    else localStorage.setItem(APPEARANCE_KEY, JSON.stringify(settings));
  } catch {
    /* localStorage может быть недоступен — тема тогда живёт до перезагрузки */
  }
}

function persistCss(settings: AppearanceSettings, css: string): void {
  try {
    if (isCanonAppearance(settings)) localStorage.removeItem(APPEARANCE_CSS_KEY);
    else localStorage.setItem(APPEARANCE_CSS_KEY, `${APPEARANCE_CSS_VERSION}\n${css}`);
  } catch {
    /* см. выше */
  }
}

/**
 * Номер последнего намерения. Применение CSS уезжает за динамический импорт, поэтому два выбора
 * в одном тике разрешились бы в непредсказуемом порядке — выигрывает только последний.
 */
let intent = 0;

/**
 * Выбор фиксируется СИНХРОННО (стор, подписчики, localStorage), а CSS применяется, когда
 * подъедет чанк с палитрами. Иначе `patchAppearance` читал бы ещё не обновлённый снимок и два
 * быстрых клика по соседним ручкам теряли бы первый — поймано вживую в предпросмотре.
 */
function commit(settings: AppearanceSettings, notifySync: boolean): void {
  current = settings;
  persistSettings(settings);
  for (const listener of listeners) listener();
  if (notifySync) notifyAppearanceChanged();

  const token = ++intent;
  void import('@/lib/appearanceTheme').then(({ appearanceCss }) => {
    if (token !== intent) return;
    const css = appearanceCss(settings);
    persistCss(settings, css);
    applyAppearanceCss(css);
  });
}

/** Меняет выбор: фиксирует его, будит аккаунтный sync и применяет CSS следующим микротаском. */
export function setAppearance(settings: AppearanceSettings): void {
  commit(settings, true);
}

/** Точечная правка одного измерения. */
export function patchAppearance(patch: Partial<AppearanceSettings>): void {
  setAppearance({ ...getAppearance(), ...patch });
}

/**
 * Единственная точка входа для оболочки после ответа `/api/prefs`.
 *
 * Аккаунтная копия выигрывает (кросс-девайс намерение); `null` означает «в аккаунте темы нет» —
 * тогда остаёмся на локальном выборе. Обратно в blob отсюда не пушим: это чужая запись, а не
 * правка пользователя. Заодно чинится протухший прерисовочный кэш — CSS всё равно уже считается.
 */
export function applyAccountAppearance(raw: unknown): void {
  const next = raw == null ? getAppearance() : parseAppearance(raw);
  if (sameAppearance(next, getAppearance()) && !appearanceCacheStale()) return;
  commit(next, false);
}
