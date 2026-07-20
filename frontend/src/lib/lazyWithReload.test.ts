import { describe, expect, it, vi } from 'vitest';
import { CHUNK_RELOAD_FLAG, isChunkLoadError, recoverChunkImport } from './lazyWithReload';

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
    map,
  };
}

const chunkError = () =>
  new TypeError('Failed to fetch dynamically imported module: https://x.app/assets/MsClients-C1a2b3.js');

/** Промис не должен settle-иться в течение таймер-тика (reload берёт навигацию на себя). */
async function expectPending(p: Promise<unknown>): Promise<void> {
  let settled = false;
  p.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((r) => setTimeout(r, 0));
  expect(settled).toBe(false);
}

describe('isChunkLoadError', () => {
  it('матчит все три браузерные формулировки, регистронезависимо', () => {
    expect(isChunkLoadError(chunkError())).toBe(true);
    expect(isChunkLoadError(new Error('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('FAILED TO FETCH DYNAMICALLY IMPORTED MODULE: x'))).toBe(true);
  });

  it('не матчит прочие ошибки и не-Error значения', () => {
    expect(isChunkLoadError(new Error('boom'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('recoverChunkImport', () => {
  it('первый чанк-фейл: ставит флаг, зовёт reload, промис остаётся pending (экран не мигает)', async () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    const p = recoverChunkImport(() => Promise.reject(chunkError()), { storage, reload });
    await expectPending(p);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(CHUNK_RELOAD_FLAG)).toBe('1');
  });

  it('повторный чанк-фейл (флаг уже стоит): пробрасывает ошибку, reload НЕ зовёт', async () => {
    const storage = fakeStorage({ [CHUNK_RELOAD_FLAG]: '1' });
    const reload = vi.fn();
    await expect(
      recoverChunkImport(() => Promise.reject(chunkError()), { storage, reload }),
    ).rejects.toThrow(/Failed to fetch dynamically imported module/);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.getItem(CHUNK_RELOAD_FLAG)).toBe('1');
  });

  it('успешный импорт: снимает флаг и возвращает модуль как есть', async () => {
    const storage = fakeStorage({ [CHUNK_RELOAD_FLAG]: '1' });
    const reload = vi.fn();
    const mod = { default: 'Component' };
    await expect(recoverChunkImport(() => Promise.resolve(mod), { storage, reload })).resolves.toBe(mod);
    expect(storage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it('НЕ-чанковая ошибка пробрасывается без reload и без флага', async () => {
    const storage = fakeStorage();
    const reload = vi.fn();
    await expect(
      recoverChunkImport(() => Promise.reject(new Error('module eval crashed')), { storage, reload }),
    ).rejects.toThrow('module eval crashed');
    expect(reload).not.toHaveBeenCalled();
    expect(storage.getItem(CHUNK_RELOAD_FLAG)).toBeNull();
  });

  it('storage бросает (privacy mode): одноразовость не гарантировать → честный проброс без reload', async () => {
    const throwing = {
      getItem: () => {
        throw new Error('storage disabled');
      },
      setItem: () => {
        throw new Error('storage disabled');
      },
      removeItem: () => {
        throw new Error('storage disabled');
      },
    };
    const reload = vi.fn();
    await expect(
      recoverChunkImport(() => Promise.reject(chunkError()), { storage: throwing, reload }),
    ).rejects.toThrow(/Failed to fetch dynamically imported module/);
    expect(reload).not.toHaveBeenCalled();
  });
});
