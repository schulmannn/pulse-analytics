import { useTgFull } from '@/api/queries';
import { fmt } from '@/lib/format';

/**
 * Hero greeting — ported from legacy renderHero() (Telegram path). Reads the aggregate
 * /api/tg/full snapshot: total views if available, else subscriber count.
 */
export function Hero() {
  const { data } = useTgFull();
  const members = data?.channel?.memberCount ?? data?.channel?.members ?? 0;
  const totalViews = data?.views_summary?.total_views ?? 0;

  let highlight: string;
  if (totalViews > 0) highlight = `${fmt.short(totalViews)} просмотров`;
  else if (members > 0) highlight = `${fmt.short(members)} подписчиков`;
  else highlight = 'всё под контролем';

  return (
    <section>
      <p className="text-sm text-muted-foreground">{fmt.todayLabel()}</p>
      <h1 className="mt-1 text-3xl font-light tracking-tight">
        {fmt.greeting()}. <span className="font-medium text-primary">{highlight}</span> за последние 30 дн.
      </h1>
    </section>
  );
}
