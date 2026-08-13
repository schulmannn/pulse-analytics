import { useMemo } from 'react';
import { useTgGraphs } from '@/api/queries';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { ChartSkeleton } from '@/components/ui/dataSkeleton';
import { buildActivityCalendar, type ActivityCalendarModel } from '@/lib/activityCalendar';
import { toYmd } from '@/lib/analyticsExport';
import { fmt } from '@/lib/format';
import { tgDailySeriesFromGraphs } from '@/lib/tgAnalyticsExport';
import { useWidgetInView } from '@/lib/widgetViewport';

const ACTIVITY_LEVEL_CLASS = [
  'bg-muted/40',
  'bg-primary/15',
  'bg-primary/30',
  'bg-primary/55',
  'bg-primary/85',
] as const;

/** Fixed-year body shared by Analytics and the pinnable Home card. It deliberately ignores the
    page/widget period: this view always answers the same trailing-365-day question. */
export function ActivityCalendarBody() {
  const inView = useWidgetInView();
  const graphsQ = useTgGraphs({ enabled: inView });
  const model = useMemo(() => {
    const views = tgDailySeriesFromGraphs(graphsQ.data).find((series) => series.metric === 'Просмотры канала');
    const points = (views?.values ?? []).flatMap((value, index) => {
      const timestamp = Number(views?.x[index]);
      return Number.isFinite(timestamp) && Number.isFinite(value)
        ? [{ day: toYmd(timestamp), views: Number(value) }]
        : [];
    });
    return buildActivityCalendar(points);
  }, [graphsQ.data]);

  if (graphsQ.isPending) return <ChartSkeleton />;
  if (graphsQ.isError) {
    return <ErrorState title="Не удалось загрузить календарь активности" onRetry={() => graphsQ.refetch()} />;
  }
  if (!model.hasHistory) {
    return <EmptyState compact title="Истории просмотров за год пока нет" />;
  }
  return <ActivityCalendar model={model} />;
}

function ActivityCalendar({ model }: { model: ActivityCalendarModel }) {
  const peak = model.peak;
  const ariaLabel = peak
    ? `Календарь активности за год: всего ${fmt.num(model.total)} просмотров, пик ${fmt.day(peak.day)} — ${fmt.num(peak.value)}`
    : `Календарь активности за год: всего ${fmt.num(model.total)} просмотров`;
  const gridColumns = `repeat(${model.weeks.length}, 12px)`;

  return (
    <div role="img" aria-label={ariaLabel}>
      <div className="overflow-x-auto pb-2" data-activity-calendar-scroll>
        <div className="w-max min-w-[824px]">
          <div
            className="ml-8 grid h-4 gap-[3px] text-2xs text-muted-foreground"
            style={{ gridTemplateColumns: gridColumns }}
          >
            {model.weeks.map((week) => (
              <span key={week.key} className="whitespace-nowrap">
                {week.monthDay ? fmt.day(week.monthDay).replace(/^\d+\s+/, '') : ''}
              </span>
            ))}
          </div>
          <div className="mt-1 flex gap-2">
            <div
              aria-hidden="true"
              className="grid w-6 shrink-0 gap-[3px] text-2xs leading-3 text-muted-foreground"
              style={{ gridTemplateRows: 'repeat(7, 12px)' }}
            >
              <span>Пн</span>
              <span />
              <span>Ср</span>
              <span />
              <span>Пт</span>
              <span />
              <span />
            </div>
            <div className="grid gap-[3px]" style={{ gridTemplateColumns: gridColumns }}>
              {model.weeks.map((week) => (
                <div
                  key={week.key}
                  className="grid gap-[3px]"
                  style={{ gridTemplateRows: 'repeat(7, 12px)' }}
                >
                  {week.days.map((cell, weekday) =>
                    cell ? (
                      <div
                        key={cell.day}
                        aria-hidden="true"
                        title={`${fmt.day(cell.day)} — ${fmt.num(cell.value)} просмотров`}
                        className={`h-3 w-3 rounded-[2px] ${ACTIVITY_LEVEL_CLASS[cell.level]}${
                          cell.isToday ? ' ring-1 ring-primary' : ''
                        }`}
                      />
                    ) : (
                      <div key={`${week.key}-${weekday}`} aria-hidden="true" className="h-3 w-3" />
                    ),
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>просмотры по дням · последние 365 дней</span>
        <span className="flex items-center gap-1.5" aria-hidden="true">
          <span>меньше</span>
          {ACTIVITY_LEVEL_CLASS.map((className) => (
            <span key={className} className={`h-3 w-3 rounded-[2px] ${className}`} />
          ))}
          <span>больше</span>
        </span>
      </div>
    </div>
  );
}
