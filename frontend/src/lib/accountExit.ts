export function accountExitLabel(demo: boolean, pending: boolean): string {
  if (demo) return 'Выйти из демо';
  return pending ? 'Выход…' : 'Выйти';
}

/** One shared branch so every account surface leaves fixtures without calling real auth APIs. */
export function runAccountExit({
  demo,
  exitDemo,
  logout,
}: {
  demo: boolean;
  exitDemo: () => void;
  logout: () => void;
}): void {
  if (demo) {
    exitDemo();
    return;
  }
  logout();
}
