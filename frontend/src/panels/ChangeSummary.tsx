import { useTgFull } from '@/api/queries';
import { normalizeTgPosts } from '@/lib/posts';
import { useWidgetPeriod } from '@/lib/period';
import { describeChange, explainChange } from '@/lib/whyChanged';
import { fmt } from '@/lib/format';
import { periodMedian } from '@/lib/postMedian';

export function ChangeSummary() {
  const { data } = useTgFull(0);
  const { days, inRange } = useWidgetPeriod();
  const posts = normalizeTgPosts(data?.posts ?? [], data?.channel ?? {});

  if (days === 0 || posts.length === 0) {
    return <p className="py-5 text-sm text-muted-foreground">Выберите конечный период, чтобы сравнить его с предыдущим окном.</p>;
  }

  const dated = posts
    .filter((post) => post.date && Number.isFinite(Date.parse(post.date)))
    .sort((a, b) => Date.parse(a.date!) - Date.parse(b.date!));
  const now = Date.now();
  const change = explainChange(dated.map((post) => ({ day: post.date!, v: post.reach })), days, now);
  const story = describeChange(change, 'Просмотры публикаций');
  const directionClass = change.direction === 'up' ? 'text-verdant' : change.direction === 'down' ? 'text-ember' : 'text-foreground';

  if (change.insufficient) {
    const current = posts.filter((post) => inRange(post.date));
    const typical = periodMedian(current.map((post) => post.reach));
    const best = [...current].sort((a, b) => b.reach - a.reach)[0];
    return (
      <div className="grid gap-5 py-1 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.65fr)]">
        <div>
          <p className="text-xl font-medium tracking-tight text-foreground">
            {current.length} публикаций · {fmt.short(current.reduce((sum, post) => sum + post.reach, 0))} просмотров
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {typical != null ? `Медианный охват публикации — ${fmt.short(typical)}.` : 'Для устойчивой медианы нужно не меньше пяти публикаций.'}
          </p>
        </div>
        <div className="border-l border-border pl-4">
          {best ? (
            <>
              <div className="text-xs text-muted-foreground">Лучшая публикация периода</div>
              <div className="mt-1 text-sm font-medium text-foreground">{fmt.short(best.reach)} просмотров</div>
              <p className="mt-1 line-clamp-1 text-xs text-muted-foreground">{best.caption || 'Без подписи'}</p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">В выбранном окне нет публикаций.</p>
          )}
          <p className="mt-2 text-2xs text-ink3">Сравнение появится, когда будет полное предыдущее окно.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="grid gap-5 py-1 lg:grid-cols-[minmax(0,1fr)_minmax(260px,0.65fr)]">
      <div>
        <p className={`text-xl font-medium tracking-tight ${directionClass}`}>{story.headline}</p>
        <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
          <span>Текущий период <strong className="ml-1 font-medium tabular-nums text-foreground">{fmt.short(change.current)}</strong></span>
          <span>Предыдущий <strong className="ml-1 font-medium tabular-nums text-foreground">{fmt.short(change.previous)}</strong></span>
        </div>
      </div>
      <div className="border-l border-border pl-4">
        {story.evidence.length > 0 ? (
          <ul className="space-y-1.5 text-sm text-muted-foreground">
            {story.evidence.slice(0, 2).map((line) => <li key={line}>{line}</li>)}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            Сдвиг не выходит за порог значимого изменения.
          </p>
        )}
        {story.caveat && <p className="mt-2 text-2xs text-ink3">{story.caveat}</p>}
      </div>
    </div>
  );
}
