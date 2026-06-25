import { useHistory, useVelocity, useTgFull } from '@/api/queries';
import { lttbDownsample } from '@/lib/downsample';
import { LineChart } from '@/components/LineChart';
import { fmt } from '@/lib/format';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { inRangeByDays, usePeriod } from '@/lib/period';

interface HeatmapCell {
  n: number;
  ervSum: number;
  reachSum: number;
}

export function Charts() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold tracking-tight">Графики аналитики</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Динамика развития, активность аудитории и скорость дистрибуции контента
        </p>
      </div>
      <div className="grid grid-cols-1 gap-6">
        <HistoryChartBlock />
        <HeatmapChartBlock />
        <VelocityChartBlock />
      </div>
    </div>
  );
}

function HistoryChartBlock() {
  const { data, isLoading, isError } = useHistory(730);

  if (isLoading) return <ChartSkeleton title="История подписчиков" />;
  if (isError || !data || !data.enabled) return null;

  const rawRows = data.rows ?? [];
  const rows = rawRows.filter((r) => r.subscribers != null);
  if (rows.length < 2) return null;

  const sampled = lttbDownsample(rows, 140, (r) => Number(r.subscribers));
  const val = sampled.map((r) => Number(r.subscribers));

  const ddmm = (dayStr: string) => {
    const parts = dayStr.split('-');
    if (parts.length !== 3) return dayStr;
    const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mIdx = Number(parts[1]) - 1;
    const monthLabel = MON[mIdx] ?? '';
    return `${Number(parts[2])} ${monthLabel}`;
  };

  const titles = sampled.map((r) => `${ddmm(r.day)}: ${fmt.num(r.subscribers)} подписчиков`);

  const firstRow = sampled[0];
  const midRow = sampled[Math.floor(sampled.length / 2)];
  const lastRow = sampled[sampled.length - 1];

  const labels = [
    firstRow ? firstRow.day : '',
    midRow ? midRow.day : '',
    lastRow ? lastRow.day : '',
  ].map(ddmm);

  const isDownsampled = rawRows.length > 140;
  const caption = `${rawRows.length} дн в архиве${isDownsampled ? ' · сглажено' : ''}`;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          История подписчиков
        </CardTitle>
      </CardHeader>
      <CardContent>
        <LineChart
          values={val}
          yMin={Math.min(...val)}
          yMax={Math.max(...val)}
          titles={titles}
          labels={labels}
        />
        <div className="mt-3 text-xs font-medium text-muted-foreground">{caption}</div>
      </CardContent>
    </Card>
  );
}

function HeatmapChartBlock() {
  const { days } = usePeriod();
  const { data: tgData, isLoading } = useTgFull(days);

  if (isLoading) return <ChartSkeleton title="Тепловая карта (день × час)" />;

  const posts = tgData?.posts ?? [];
  const dayNames = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

  const grid: HeatmapCell[][] = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => ({ n: 0, ervSum: 0, reachSum: 0 })),
  );

  posts.forEach((p) => {
    if (!inRangeByDays(p.date, days) || !p.date) return;
    const d = new Date(p.date);
    if (isNaN(d.getTime())) return;

    const weekday = (d.getDay() + 6) % 7;
    const hour = d.getHours();

    const row = grid[weekday];
    if (!row) return;
    const cell = row[hour];
    if (!cell) return;

    const reach = Number(p.views ?? 0);
    const eng = Number(p.reactions ?? 0) + Number(p.forwards ?? 0) + Number(p.replies ?? 0);
    const erv = reach > 0 ? (eng / reach) * 100 : null;

    cell.n++;
    cell.reachSum += reach;
    if (erv !== null) cell.ervSum += erv;
  });

  let maxErv = 0;
  let bestSlot: { weekday: number; hour: number; avgErv: number; n: number; reachSum: number } | null = null;
  let maxScore = -1;

  for (let w = 0; w < 7; w++) {
    const row = grid[w];
    if (!row) continue;
    for (let hr = 0; hr < 24; hr++) {
      const cell = row[hr];
      if (cell && cell.n > 0) {
        const avgErv = cell.ervSum / cell.n;
        if (avgErv > maxErv) maxErv = avgErv;
        const score = avgErv * (cell.n >= 2 ? 1.15 : 1);
        if (score > maxScore) {
          maxScore = score;
          bestSlot = { weekday: w, hour: hr, avgErv, n: cell.n, reachSum: cell.reachSum };
        }
      }
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Тепловая карта активности (день × час)
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto pb-2">
          <div className="min-w-[420px] space-y-[2px]">
            <div className="grid gap-[2px]" style={{ gridTemplateColumns: '30px repeat(24, minmax(14px, 1fr))' }}>
              <div />
              {Array.from({ length: 24 }).map((_, hr) => (
                <div key={hr} className="select-none text-center text-[10px] font-semibold text-muted-foreground">
                  {hr % 3 === 0 ? `${hr}` : ''}
                </div>
              ))}
            </div>

            {dayNames.map((dayName, w) => {
              const currentRow = grid[w] ?? [];
              return (
                <div
                  key={w}
                  className="grid items-center gap-[2px]"
                  style={{ gridTemplateColumns: '30px repeat(24, minmax(14px, 1fr))' }}
                >
                  <div className="select-none text-[11px] font-bold text-muted-foreground">{dayName}</div>
                  {Array.from({ length: 24 }).map((_, hr) => {
                    const cell = currentRow[hr];
                    if (!cell || cell.n === 0) {
                      return <div key={hr} className="h-4 rounded-sm bg-muted/40" title="нет постов" />;
                    }
                    const avgErv = cell.ervSum / cell.n;
                    const opacity = maxErv > 0 ? Math.max(0.18, avgErv / maxErv) : 0;
                    const isBest = bestSlot && bestSlot.weekday === w && bestSlot.hour === hr;
                    const titleText = `${dayName} ${hr}:00 · ${cell.n} пост(ов) · ERV ${avgErv.toFixed(1)}% · ср.охват ${fmt.short(cell.reachSum / cell.n)}`;
                    return (
                      <div
                        key={hr}
                        className="relative h-4 rounded-sm"
                        style={{
                          backgroundColor: 'hsl(var(--brand-iris))',
                          opacity,
                          border: isBest ? '2px solid hsl(var(--brand-verdant))' : undefined,
                        }}
                        title={titleText}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        <div className="mt-3 text-xs font-medium text-muted-foreground">
          {bestSlot ? (
            <span>
              лучший слот:{' '}
              <strong className="text-foreground">
                {dayNames[bestSlot.weekday] ?? ''} {bestSlot.hour}:00
              </strong>{' '}
              · ERV {bestSlot.avgErv.toFixed(1)}%
            </span>
          ) : (
            'Мало постов для тепловой карты.'
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function VelocityChartBlock() {
  const { data, isLoading } = useVelocity();

  if (isLoading) return <ChartSkeleton title="Скорость набора просмотров" />;

  const available = data?.available ?? false;
  const byDay = data?.by_day ?? [];

  if (!available || byDay.length < 2) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Скорость набора просмотров
          </CardTitle>
        </CardHeader>
        <CardContent>
          <LineChart values={[]} />
        </CardContent>
      </Card>
    );
  }

  const cum = byDay.map((p) => p.cum);
  const titles = byDay.map((p) => `${p.day + 1}-е сутки: накоплено ${p.cum}% · доля дня ${p.share}%`);
  const labels = byDay.map((p) => `${p.day + 1}д`);

  const captions: string[] = [];
  if (data?.day1_share != null) captions.push(`за 1-е сутки — ${data.day1_share}%`);
  if (data?.t80_days != null) captions.push(`80% за ${data.t80_days} дн`);
  if (data?.posts_used != null) captions.push(`по ${data.posts_used} постам`);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          Скорость набора просмотров
        </CardTitle>
      </CardHeader>
      <CardContent>
        <LineChart values={cum} yMin={0} yMax={Math.max(...cum, 1)} titles={titles} labels={labels} />
        {captions.length > 0 && (
          <div className="mt-3 text-xs font-medium text-muted-foreground">{captions.join(' · ')}</div>
        )}
      </CardContent>
    </Card>
  );
}

function ChartSkeleton({ title }: { title: string }) {
  return (
    <Card className="animate-pulse">
      <CardHeader>
        <CardTitle className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="h-32 w-full rounded bg-muted" />
        <div className="h-3 w-1/6 rounded bg-muted" />
      </CardContent>
    </Card>
  );
}
