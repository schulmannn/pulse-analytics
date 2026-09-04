import { useLayoutEffect } from 'react';

/**
 * Пришпиливает тему документа на время жизни поверхности и возвращает её как было при уходе.
 *
 * Почему не класс на поддереве: в Tailwind v4 цветовые алиасы объявлены один раз в `@theme`
 * (`--color-background: hsl(var(--background))`), поэтому подставляются на `:root`, а потомки
 * наследуют УЖЕ вычисленный цвет. Переопределение сырых HSL-каналов ниже по дереву (как это
 * делал `.force-light` во времена v3) в v4 не красит ничего. Тему реально переключает только
 * класс на <html> — тем же способом, что и ThemeProvider (`lib/theme.tsx`).
 *
 * `useLayoutEffect`, а не `useEffect`: класс обязан встать до первой отрисовки, иначе публичная
 * страница моргает чужой темой.
 */
export function useForcedTheme(theme: 'light' | 'dark'): void {
  useLayoutEffect(() => {
    const html = document.documentElement;
    const hadDark = html.classList.contains('dark');
    const prevScheme = html.style.colorScheme;

    html.classList.toggle('dark', theme === 'dark');
    html.style.colorScheme = theme;

    return () => {
      html.classList.toggle('dark', hadDark);
      html.style.colorScheme = prevScheme;
    };
  }, [theme]);
}
