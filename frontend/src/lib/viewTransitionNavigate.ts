import { useCallback, useLayoutEffect } from 'react';
import { useLocation, useNavigate, createPath, type NavigateOptions, type To } from 'react-router-dom';

/**
 * Роут-навигация под View Transitions API (волна B). НЕ проп RR: приложение живёт на plain
 * BrowserRouter, где `viewTransition`-пропы инертны.
 *
 * ЯДРО — ASYNC-колбэк, а не flushSync (ревью, high): RR7 BrowserRouter безусловно оборачивает
 * апдейт роутера в React.startTransition, а flushSync transition-lane НЕ флашит — «новый»
 * снапшот был гонкой с шедулером, а на холодном lazy-чанке ловил Suspense-фолбэк. Теперь колбэк
 * возвращает промис, который резолвится ФАКТОМ коммита нового location (сигнал из
 * RouteCommitSignal через useLayoutEffect) — transition-семантика RR сама держит старый экран до
 * готовности чанка, и снапшот снимается с НАСТОЯЩЕЙ новой страницы. Таймаут-предохранитель
 * скипает анимацию, если коммит не пришёл (упавшая навигация не замораживает ввод).
 *
 * SAME-PATH гард (ревью, medium): клик по уже активному разделу повторяет эвристику RR-Link
 * «same-path ⇒ replace» и НЕ запускает VT — иначе history засорялся дублями, а невидимый
 * кроссфейд идентичного контента блокировал ввод на --motion-base.
 *
 * Деградация каноничка: нет API или prefers-reduced-motion → обычный navigate. ТОЛЬКО роут-
 * переходы: внутристраничный стейт (морф графиков, FLIP) не оборачивать — страница на время
 * перехода заморожена снапшотом.
 */

/** Ждуны коммита роута: RouteCommitSignal резолвит всех на КАЖДОЙ смене location. */
let pendingCommits: Array<() => void> = [];

function nextRouteCommit(): Promise<void> {
  return new Promise((resolve) => {
    pendingCommits.push(resolve);
  });
}

/** Смонтируй ОДИН раз внутри роутера (App): useLayoutEffect на location = момент, когда новый
    роут закоммичен в DOM — правильная точка снапшота «нового» состояния VT. */
export function RouteCommitSignal(): null {
  const location = useLocation();
  useLayoutEffect(() => {
    const waiters = pendingCommits;
    pendingCommits = [];
    for (const resolve of waiters) resolve();
  }, [location]);
  return null;
}

/** Предохранитель: коммит не пришёл (навигация упала/чанк завис) — скипаем анимацию, не ввод. */
const VT_COMMIT_TIMEOUT_MS = 1200;

export function useViewTransitionNavigate() {
  const navigate = useNavigate();
  const location = useLocation();
  return useCallback(
    (to: To, options?: NavigateOptions) => {
      const target = typeof to === 'string' ? to : createPath(to);
      const current = createPath(location);
      // Same-path: паритет с RR-Link (replace, без VT) — history не растёт, ввод не мёрзнет.
      if (target === current) {
        navigate(to, { ...options, replace: true });
        return;
      }
      const canTransition =
        typeof document !== 'undefined' &&
        'startViewTransition' in document &&
        !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      if (!canTransition) {
        navigate(to, options);
        return;
      }
      let settle: (() => void) | null = null;
      const transition = document.startViewTransition(() => {
        const committed = nextRouteCommit();
        navigate(to, options);
        return new Promise<void>((resolve) => {
          settle = resolve;
          committed.then(() => {
            settle = null;
            resolve();
          });
        });
      });
      // Скип по таймауту: резолвим колбэк (иначе VT держит оверлей до своего 4с-лимита) и
      // отменяем анимацию — переход завершится мгновенно, как в браузере без поддержки.
      const timeout = setTimeout(() => {
        if (settle) {
          transition.skipTransition();
          settle();
          settle = null;
        }
      }, VT_COMMIT_TIMEOUT_MS);
      transition.finished.finally(() => clearTimeout(timeout)).catch(() => {});
    },
    [navigate, location],
  );
}

/** Гард для перехвата клика по <Link>: модификаторы/средняя кнопка — браузеру. */
export function isPlainLeftClick(event: {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}): boolean {
  return (
    !event.defaultPrevented &&
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}
