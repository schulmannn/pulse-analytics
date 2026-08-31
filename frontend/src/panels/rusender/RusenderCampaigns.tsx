import { useMemo, useState } from 'react';
import { EmptyState } from '@/components/EmptyState';
import { ErrorState } from '@/components/ErrorState';
import { TableSkeleton } from '@/components/ui/dataSkeleton';
import { useRusenderCampaigns, type RusenderCampaign } from '@/api/rusender';
import { useGatedSurfaces } from '@/components/layout/nav';
import { useSelectedChannel } from '@/lib/channel-context';
import { fmt } from '@/lib/format';
import { usePagePeriod } from '@/lib/period';

/**
 * «Рассылки» — контент-единицы источника (тот же слот, что «Контент» у TG/IG).
 *
 * ЧТО ЗДЕСЬ ЗА ЧИСЛА. Каждая строка — ИТОГИ рассылки целиком, кумулятивные и живые: открытия
 * письма докапывают неделями после отправки. Поэтому колонки не привязаны к выбранному окну —
 * окно отбирает, какие рассылки ПОКАЗАТЬ (по дню запуска), а не за какой период считать их
 * статистику. Подпись под таблицей проговаривает это словами.
 *
 * СЕМЬИ A/B. Лента показывает только БАЗОВЫЕ рассылки: семья A/B — это одна рассылка с
 * вариантами, и три почти одинаковые строки подряд читались бы как «мы отправили три рассылки».
 * Число вариантов стоит меткой у имени; сами варианты живут в архиве и не входят в итоги
 * (защита от двойного счёта, миграция 040).
 */

/** Доля от доставленных. Знаменатель ОДИН на всю страницу — иначе колонки не сравнимы между собой. */
function rate(part: number | null, whole: number | null): string {
  if (part == null || whole == null || whole <= 0) return '—';
  return `${((part / whole) * 100).toFixed(1)}%`;
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Черновик',
  built: 'Собрана',
  scheduled: 'Запланирована',
  in_progress: 'Идёт',
  paused: 'На паузе',
  completed: 'Завершена',
  banned: 'Заблокирована',
  on_hold: 'Удержана',
};

export function RusenderCampaigns() {
  const { channelId } = useSelectedChannel();
  const { rusenderSurfaces } = useGatedSurfaces();
  const pp = usePagePeriod();
  const days = pp ? pp.days : 30;
  const query = useRusenderCampaigns(channelId, days, rusenderSurfaces);
  const [q, setQ] = useState('');

  const rows = useMemo(() => {
    const all = query.data?.campaigns ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return all;
    return all.filter(
      (c) => (c.name ?? '').toLowerCase().includes(needle) || (c.subject ?? '').toLowerCase().includes(needle),
    );
  }, [query.data, q]);

  // Раздел за фичефлагом: попасть сюда можно только deep-link'ом, пока флаг выключен (нав его
  // не показывает). Честно говорим, что раздела ещё нет, вместо пустой таблицы.
  if (!rusenderSurfaces) {
    return (
      <EmptyState
        title="Раздел ещё не включён"
        reason="Рассылки появятся, когда числа Rusender сверены с живыми данными. Архив тем временем копится."
        action={{ to: '/rusender', label: 'К обзору' }}
      />
    );
  }

  if (query.isPending) return <TableSkeleton />;
  if (query.isError) return <ErrorState onRetry={() => void query.refetch()} />;

  const all = query.data?.campaigns ?? [];
  if (!all.length) {
    return (
      <EmptyState
        title="За период рассылок нет"
        reason="Окно отбирает рассылки по дню запуска. Попробуй расширить период — или дождись первого дневного сбора."
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <label htmlFor="rusender-campaign-search" className="sr-only">
          Поиск по рассылкам
        </label>
        <input
          data-mobile-touch-target=""
          id="rusender-campaign-search"
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Поиск по названию или теме"
          className="h-11 min-w-0 flex-1 rounded border border-border bg-background px-3 text-sm text-foreground outline-hidden placeholder:text-muted-foreground focus:ring-1 focus:ring-primary sm:h-9"
        />
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {rows.length} из {all.length}
        </span>
      </div>

      {!rows.length ? (
        <EmptyState compact title="Ничего не нашлось" glyph={false} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[46rem] border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2 pr-3 font-medium">Рассылка</th>
                <th scope="col" className="py-2 pr-3 font-medium">Запущена</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Доставлено</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Открытия</th>
                <th scope="col" className="py-2 pr-3 text-right font-medium">Клики</th>
                <th scope="col" className="py-2 text-right font-medium">Отписки</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c: RusenderCampaign) => (
                <tr key={c.campaign_id} className="border-b border-border/60 last:border-0">
                  <td className="max-w-[22rem] py-2 pr-3">
                    <div className="truncate font-medium text-foreground">{c.name ?? `Рассылка ${c.campaign_id}`}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {c.subject ?? '—'}
                      {c.parts_count > 0 && (
                        <span className="ml-2 rounded-full border border-border px-1.5 py-0.5 text-2xs">
                          A/B · {c.parts_count}
                        </span>
                      )}
                      {c.is_archived && <span className="ml-2 text-2xs">в архиве</span>}
                    </div>
                  </td>
                  <td className="py-2 pr-3 whitespace-nowrap text-muted-foreground">
                    {c.started_at ? fmt.date(c.started_at) : STATUS_LABEL[c.status ?? ''] ?? '—'}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {c.delivered != null ? fmt.kpi(c.delivered) : '—'}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {c.opens != null ? fmt.kpi(c.opens) : '—'}
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      <span aria-hidden="true" className="mr-1.5">·</span>
                      {rate(c.opens, c.delivered)}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">
                    {c.clicks != null ? fmt.kpi(c.clicks) : '—'}
                    <span className="ml-1.5 text-xs text-muted-foreground">
                      <span aria-hidden="true" className="mr-1.5">·</span>
                      {rate(c.clicks, c.delivered)}
                    </span>
                  </td>
                  <td className="py-2 text-right tabular-nums">
                    {c.unsubscribes != null ? fmt.kpi(c.unsubscribes) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Числа в таблице — итоги рассылки целиком, а не за выбранный период: открытия письма
        докапывают неделями после отправки. Период отбирает, какие рассылки показать, по дню
        запуска. Доли считаются от доставленных.
      </p>
    </div>
  );
}
