import type { ReactNode } from 'react';
// Astryx runtime primitives (scoped design-system rollout) — subpath imports for tree-shaking.
import { Theme } from '@astryxdesign/core/theme';
import { neutralTheme } from '@astryxdesign/theme-neutral/built';
// This boundary owns the route-level Astryx CSS: importing it here (once, as a module side-effect)
// keeps the layer order declared in index.css and means consumers never re-import it themselves.
import './data-workspace.css';
import { useTheme } from '@/lib/theme';

/**
 * The data-workspace theme/surface boundary. Wrap any dense table surface that uses Astryx
 * primitives (view toolbar, inspector, tokens) in this component: it mirrors the app's light/dark
 * mode into a scoped Astryx <Theme> and pulls in the route-level Astryx stylesheet. Presentation
 * only — it holds no table/domain state.
 */
export function WorkspaceSurface({ children }: { children: ReactNode }) {
  const { theme } = useTheme();
  return (
    <Theme theme={neutralTheme} mode={theme}>
      {children}
    </Theme>
  );
}
