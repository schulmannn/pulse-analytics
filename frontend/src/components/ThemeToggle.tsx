import { useTheme } from '@/lib/theme';

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const isDark = theme === 'dark';

  return (
    <>
      {/* DESIGN: Claude review */}
      <button
        type="button"
        onClick={toggle}
        className="rounded border bg-background p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label={isDark ? 'Включить светлую тему' : 'Включить тёмную тему'}
        title={isDark ? 'Светлая тема' : 'Тёмная тема'}
      >
        {isDark ? (
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41" />
          </svg>
        ) : (
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8Z" />
          </svg>
        )}
      </button>
    </>
  );
}
