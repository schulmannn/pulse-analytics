import { Suspense, lazy } from 'react';
import { useParams } from 'react-router-dom';
import { Skeleton } from '@/components/ui/skeleton';
import { lazyWithReload } from '@/lib/lazyWithReload';
import { isIgMetricKey } from '@/panels/igMetricKeys';
import { isMentionsMetricKey } from '@/panels/mentions/mentionsMetricKeys';
import { isMsMetricKey } from '@/panels/sklad/msMetricKeys';
import { isTgExtraMetricKey } from '@/panels/tgMetricKeys';
import { isYmMetricKey } from '@/panels/metrika/ymMetricKeys';
import { isCdekMetricKey } from '@/panels/cdek/cdekMetricKeys';
import { isRusenderMetricKey } from '@/panels/rusender/rusenderMetricKeys';

/**
 * The metric dispatcher is deliberately dependency-free apart from the tiny key registries.
 * Every metric family — including generic Telegram and Instagram — is a separate lazy branch.
 * This prevents `/metrics/views` from paying for `IgMetricPage` and `/metrics/ig-reach` from
 * downloading `MetricPage` before its own branch is selected.
 */
const MetricPageLazy = lazy(
  lazyWithReload(() =>
    import('@/panels/MetricPage').then((module) => ({ default: module.MetricPage })),
  ),
);
const IgMetricPageLazy = lazy(
  lazyWithReload(() =>
    import('@/panels/IgMetricPage').then((module) => ({ default: module.IgMetricPage })),
  ),
);
const MsMetricPageLazy = lazy(
  lazyWithReload(() =>
    import('@/panels/sklad/MsMetricPage').then((module) => ({ default: module.MsMetricPage })),
  ),
);
const YmMetricPageLazy = lazy(
  lazyWithReload(() =>
    import('@/panels/metrika/YmMetricPage').then((module) => ({
      default: module.YmMetricPage,
    })),
  ),
);
const CdekMetricPageLazy = lazy(
  lazyWithReload(() =>
    import('@/panels/cdek/CdekMetricPage').then((module) => ({ default: module.CdekMetricPage })),
  ),
);
const RusenderMetricPageLazy = lazy(
  lazyWithReload(() =>
    import('@/panels/rusender/RusenderMetricPage').then((module) => ({
      default: module.RusenderMetricPage,
    })),
  ),
);
const TgMetricPageLazy = lazy(
  lazyWithReload(() =>
    import('@/panels/TgMetricPage').then((module) => ({ default: module.TgMetricPage })),
  ),
);
const MentionsMetricPageLazy = lazy(
  lazyWithReload(() =>
    import('@/panels/mentions/MentionsMetricPage').then((module) => ({
      default: module.MentionsMetricPage,
    })),
  ),
);

export function MetricRoute() {
  const { key } = useParams<{ key: string }>();

  if (isYmMetricKey(key)) {
    return <MetricBranch><YmMetricPageLazy metricKey={key} /></MetricBranch>;
  }
  if (isCdekMetricKey(key)) {
    return <MetricBranch><CdekMetricPageLazy metricKey={key} /></MetricBranch>;
  }
  if (isRusenderMetricKey(key)) {
    return <MetricBranch><RusenderMetricPageLazy metricKey={key} /></MetricBranch>;
  }
  if (isTgExtraMetricKey(key)) {
    return <MetricBranch><TgMetricPageLazy metricKey={key} /></MetricBranch>;
  }
  if (isMentionsMetricKey(key)) {
    return <MetricBranch><MentionsMetricPageLazy metricKey={key} /></MetricBranch>;
  }
  if (isMsMetricKey(key)) {
    return <MetricBranch><MsMetricPageLazy metricKey={key} /></MetricBranch>;
  }
  if (isIgMetricKey(key)) {
    return <MetricBranch><IgMetricPageLazy metricKey={key} /></MetricBranch>;
  }

  // MetricPage validates the canonical numeric TG keys itself and safely redirects an unknown key.
  return <MetricBranch><MetricPageLazy /></MetricBranch>;
}

function MetricBranch({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<MetricRouteFallback />}>{children}</Suspense>;
}

/** Layout-matching scaffold shared by every lazily selected metric family. */
function MetricRouteFallback() {
  return (
    <div className="space-y-5">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-8 w-48" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_300px] xl:gap-8">
        <Skeleton className="h-[420px] w-full" />
        <div className="space-y-4">
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </div>
      </div>
    </div>
  );
}
