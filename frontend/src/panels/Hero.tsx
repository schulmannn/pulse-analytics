import { useTgFull } from '@/api/queries';
import { fmt } from '@/lib/format';
import { usePeriod } from '@/lib/period';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Hero greeting — ported from legacy renderHero() (Telegram path). Reads the aggregate
 * /api/tg/full snapshot: total views if available, else subscriber count.
 */
export function Hero() {
  const { days, range } = usePeriod();
  const { data, isLoading } = useTgFull(days);

  if (isLoading) {
    return (
      <section className="space-y-2">
        {/* DESIGN: Claude review */}
        <Skeleton className="h-4 w-36" />
        <Skeleton className="h-9 w-3/4 max-w-xl" />
      </section>
    );
  }

  if (!data) {
    return <p className="text-sm text-muted-foreground">Данные канала пока недоступны.</p>;
  }
  const members = data?.channel?.memberCount ?? data?.channel?.members ?? 0;
  const totalViews = data?.views_summary?.total_views ?? 0;

  let highlight: string;
  if (totalViews > 0) highlight = `${fmt.short(totalViews)} просмотров`;
  else if (members > 0) highlight = `${fmt.short(members)} подписчиков`;
  else highlight = 'всё под контролем';
  const fmtDay = (ms: number) => new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
  const periodLabel = range
    ? `за ${fmtDay(range.from)} – ${fmtDay(range.to)}`
    : days === 0
      ? 'за всё время'
      : `за последние ${days} дн.`;

  return (
    <section>
      <p className="text-sm text-muted-foreground">{fmt.todayLabel()}</p>
      <h1 className="mt-1 text-3xl font-light tracking-tight">
        {fmt.greeting()}. <span className="font-medium text-primary">{highlight}</span> {periodLabel}
      </h1>
    </section>
  );
}
