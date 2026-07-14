import { useEffect, useState } from 'react';

const DEFAULT_VIEWPORT_HEIGHT = 900;
const EXPLORER_CHROME_HEIGHT = 340;
const MIN_CHART_HEIGHT = 420;
const MAX_CHART_HEIGHT = 680;

/** Keep the metric explorer chart-first. Secondary panels may continue below the fold. */
export function explorerChartHeight(viewportHeight: number): number {
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0
    ? viewportHeight
    : DEFAULT_VIEWPORT_HEIGHT;
  return Math.max(MIN_CHART_HEIGHT, Math.min(MAX_CHART_HEIGHT, height - EXPLORER_CHROME_HEIGHT));
}

export function useExplorerChartHeight(): number {
  const [height, setHeight] = useState(() =>
    explorerChartHeight(typeof window !== 'undefined' ? window.innerHeight : DEFAULT_VIEWPORT_HEIGHT),
  );

  useEffect(() => {
    const update = () => setHeight(explorerChartHeight(window.innerHeight));
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  return height;
}
