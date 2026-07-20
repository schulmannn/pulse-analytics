/**
 * Авто-восстановление после деплоя: открытая вкладка держит старый index.html, клик по разделу
 * тянет чанк, которого на сервере уже нет → динамический импорт падает («Failed to fetch dynamically
 * imported module: …/MsClients-*.js») и пользователь видит экран ошибки. Обёртка ловит ИМЕННО ошибку
 * загрузки чанка и один раз перезагружает страницу (свежий index → свежие чанки). Одноразовость
 * гарантирует sessionStorage-флаг: если перезагрузка не помогла (реальный сетевой сбой, а не деплой),
 * второй фейл пробрасывается в ErrorBoundary — честный экран вместо вечного цикла reload.
 */

const CHUNK_LOAD_ERROR_RE =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

/** sessionStorage-ключ «одна перезагрузка уже была» (per-tab: у каждой вкладки своя попытка). */
export const CHUNK_RELOAD_FLAG = 'chunk-reload-once';

/** Ошибка загрузки динамического чанка (Chrome/Firefox/Safari формулируют по-разному). */
export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && CHUNK_LOAD_ERROR_RE.test(error.message);
}

interface ChunkRecoveryDeps {
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  reload: () => void;
}

/**
 * Чистое ядро (storage/reload инжектируются — юнит-тестируемо без jsdom-навигации).
 * Успех → снять флаг (следующий деплой снова получит свою одну попытку) и вернуть модуль.
 * Чанк-фейл без флага → поставить флаг, reload(); промис остаётся PENDING — Suspense продолжает
 * показывать скелет до перезагрузки, экран не мигает ошибкой.
 * Чанк-фейл с флагом (перезагрузка не помогла) или любая другая ошибка → проброс.
 */
export function recoverChunkImport<T>(load: () => Promise<T>, deps: ChunkRecoveryDeps): Promise<T> {
  return load().then(
    (mod) => {
      try {
        deps.storage.removeItem(CHUNK_RELOAD_FLAG);
      } catch {
        /* storage недоступен (privacy mode) — не мешаем успешному импорту */
      }
      return mod;
    },
    (error: unknown) => {
      if (!isChunkLoadError(error)) throw error;
      let alreadyReloaded = false;
      try {
        alreadyReloaded = deps.storage.getItem(CHUNK_RELOAD_FLAG) != null;
        if (!alreadyReloaded) deps.storage.setItem(CHUNK_RELOAD_FLAG, '1');
      } catch {
        // Флаг не записать → одноразовость не гарантировать → reload-цикл возможен. Честный экран.
        throw error;
      }
      if (alreadyReloaded) throw error;
      deps.reload();
      // Вечный pending: страница уже перезагружается, resolve/reject никому не нужны.
      return new Promise<T>(() => {
        /* intentionally never settles */
      });
    },
  );
}

/**
 * Обёртка фабрики динамического импорта для React.lazy:
 * `lazy(lazyWithReload(() => import('@/panels/Foo').then(...)))`.
 */
export function lazyWithReload<T>(load: () => Promise<T>): () => Promise<T> {
  return () =>
    recoverChunkImport(load, {
      storage: window.sessionStorage,
      reload: () => window.location.reload(),
    });
}
