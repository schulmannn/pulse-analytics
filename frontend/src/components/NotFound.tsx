import { Link } from 'react-router-dom';
import { Cartograph } from '@/components/Cartograph';

/**
 * 404 — a route that isn't on the map. Renders inside the dashboard content area (the shell/nav
 * stay), so a mistyped or dead link lands somewhere navigable rather than redirecting silently.
 * Reached from the feed's unknown-section guard and the catch-all `path="*"` route in App.tsx.
 */
export function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <Cartograph name="off-map" className="h-32 w-auto" />
      <h2 className="mt-6 text-2xl font-medium tracking-tight text-foreground">Этой страницы нет на карте</h2>
      <p className="mt-2 max-w-sm text-sm text-muted-foreground">
        Страница не найдена или переехала. Вернёмся к обзору.
      </p>
      <Link
        to="/"
        className="btn-pill mt-6 bg-primary px-5 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        К обзору
      </Link>
    </div>
  );
}
