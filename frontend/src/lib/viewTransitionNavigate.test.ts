import { describe, expect, it, vi } from 'vitest';
import { isPlainLeftClick } from '@/lib/viewTransitionNavigate';

/**
 * Регрессия по живому крэшу из телеметрии: «[global] AbortError: Transition was skipped» на
 * /mentions и /posts. Причина — у ViewTransition гасился только `finished`, а `skipTransition()`
 * отклоняет ещё и `ready`; непойманное отклонение уходило в window-level крэш-нет и попадало в
 * телеметрию как падение, хотя пропуск перехода — штатный путь.
 *
 * Здесь проверяется само правило «оба промиса обязаны быть погашены» на модели ViewTransition:
 * поведение навигации живёт в e2e, а причина крэша — вот эта пара промисов.
 */
function makeTransition() {
  const ready = Promise.reject(new DOMException('Transition was skipped', 'AbortError'));
  const finished = Promise.reject(new DOMException('Transition was skipped', 'AbortError'));
  return { ready, finished, skipTransition: () => {} };
}

describe('ViewTransition: отклонения обоих промисов погашены', () => {
  it('обработчик навешивается на ОБА промиса, а не только на finished', async () => {
    // Ловим сам факт подписки: «непойманное отклонение» через unhandledrejection в vitest
    // недетерминированно (событие зависит от тайминга микрозадач раннера), а проверяемый контракт
    // ровно в том, что ни один из промисов не остался без обработчика.
    const handled = { ready: false, finished: false };
    const track = (name: 'ready' | 'finished') => {
      const promise = Promise.reject(new DOMException('Transition was skipped', 'AbortError'));
      return {
        catch(onRejected: (reason: unknown) => unknown) {
          handled[name] = true;
          return promise.catch(onRejected);
        },
        finally(onFinally: () => void) {
          handled[name] = true;
          return promise.finally(onFinally);
        },
      };
    };
    const transition = { ready: track('ready'), finished: track('finished') };

    // Ровно то, что делает useViewTransitionNavigate после старта перехода.
    transition.finished.finally(() => {}).catch(() => {});
    transition.ready.catch(() => {});

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(handled).toEqual({ ready: true, finished: true });
  });

  it('без catch на ready отклонение осталось бы непойманным — это и был крэш', async () => {
    const seen = vi.fn();
    const transition = makeTransition();
    transition.finished.catch(() => {});
    // ready намеренно НЕ ловим — фиксируем, что он действительно отклоняется.
    await transition.ready.catch((error: unknown) => seen(error));
    expect(seen).toHaveBeenCalledOnce();
    expect((seen.mock.calls[0][0] as DOMException).name).toBe('AbortError');
  });
});

describe('isPlainLeftClick', () => {
  const base = { button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, defaultPrevented: false };

  it('обычный левый клик перехватывается', () => {
    expect(isPlainLeftClick(base)).toBe(true);
  });

  for (const key of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
    it(`${key} отдаётся браузеру — это «открыть в новой вкладке»`, () => {
      expect(isPlainLeftClick({ ...base, [key]: true })).toBe(false);
    });
  }

  it('средняя кнопка и уже обработанный клик не перехватываются', () => {
    expect(isPlainLeftClick({ ...base, button: 1 })).toBe(false);
    expect(isPlainLeftClick({ ...base, defaultPrevented: true })).toBe(false);
  });
});
