import { describe, expect, it, vi } from 'vitest';
import { accountExitLabel, runAccountExit } from './accountExit';

describe('account exit action', () => {
  it('leaves anonymous demo without calling the server logout mutation', () => {
    const exitDemo = vi.fn();
    const logout = vi.fn();

    runAccountExit({ demo: true, exitDemo, logout });

    expect(exitDemo).toHaveBeenCalledOnce();
    expect(logout).not.toHaveBeenCalled();
    expect(accountExitLabel(true, false)).toBe('Выйти из демо');
  });

  it('uses cookie logout outside demo and preserves its pending label', () => {
    const exitDemo = vi.fn();
    const logout = vi.fn();

    runAccountExit({ demo: false, exitDemo, logout });

    expect(logout).toHaveBeenCalledOnce();
    expect(exitDemo).not.toHaveBeenCalled();
    expect(accountExitLabel(false, true)).toBe('Выход…');
  });
});
