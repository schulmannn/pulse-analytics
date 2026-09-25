import { Link } from 'react-router-dom';
import { buildIgWeekNarrative } from '@/lib/narrative';
import { ChartSection } from '@/components/ChartWidget';
import type { WidgetSize } from '@/lib/widgetPrefsStore';
import { fmt } from '@/lib/format';
import { Skeleton } from '@/components/ui/skeleton';
import { NarrativeProse, useIgWeekInput } from '@/panels/NarrativeWeek';

/**
 * «IG · Неделя» — IG-фокусный нарратив на IG-Обзоре, симметрия с TG-«Неделя канала». Тот же движок
 * (buildIgWeekNarrative) и тот же самофетч-вход (useIgWeekInput), общий рендерер NarrativeProse —
 * числа сходятся со страницами /metrics/ig-* 1-в-1. Instagram ведёт: охват-сдвиг → движение базы →
 * IG-герой. Не подключён → зовём подключить; подключён, но мало данных → тихий честный текст.
 */
export function IgNarrativeWeekBody() {
  const { input, loading, notConnected } = useIgWeekInput();
  if (loading) {
    return (
      <div className="max-w-prose space-y-3" aria-hidden="true">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-11/12" />
        <Skeleton className="h-3.5 w-4/5" />
      </div>
    );
  }
  if (notConnected) {
    return (
      <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm text-muted-foreground">Подключите Instagram — рассказ недели появится здесь.</p>
        <Link to="/connect" className="text-xs font-medium text-primary hover:underline">
          Подключить →
        </Link>
      </div>
    );
  }
  if (!input) return null; // недостижимо после гейтов выше — сужение типа для tsc

  // Недельный леджер — зеркало TG-«Недели канала»: там он ПОЛОСА под рассказом, здесь была
  // правая колонка под гейтом 2xl, то есть на обычном десктопе карточка жила коротким текстом и
  // пустотой справа. Факты из ТОГО ЖЕ входа (никаких новых запросов): пик охвата, публикации
  // недели, база с движением — числа сходятся с рассказом по построению.
  const reach7 = input.reachDaily.slice(-7);
  const peak = reach7.length ? reach7.reduce((a, b) => (b.v > a.v ? b : a)) : null;
  const net7 = input.followsDaily.slice(-7).reduce((s, p) => s + p.v, 0);
  const net7Text = `${net7 > 0 ? '+' : '−'}${fmt.num(Math.abs(net7))}`;
  const hasNet7 = input.followsDaily.length > 0 && net7 !== 0;
  const facts: { label: string; value: string }[] = [];
  if (peak && peak.v > 0) facts.push({ label: 'Пик охвата', value: `${fmt.short(peak.v)} · ${fmt.day(peak.day)}` });
  // «Публикаций» — медиа недели С ОХВАТОМ: ровно тот набор, по которому рассказ ищет героя
  // (mediaWeek), поэтому счёт и герой не могут разойтись. Медиа без охвата в карточке не участвует.
  const weekMedia = input.mediaWeek ?? [];
  if (weekMedia.length > 0) facts.push({ label: 'Публикаций', value: fmt.num(weekMedia.length) });
  // База несёт движение приклеенным хвостом (как TG: «24,5K · +128»); без базы движение честно
  // выходит отдельным фактом, а не теряется.
  if (input.followersNow != null)
    facts.push({ label: 'База', value: `${fmt.kpi(input.followersNow)}${hasNet7 ? ` · ${net7Text}` : ''}` });
  else if (hasNet7) facts.push({ label: 'Движение базы', value: net7Text });

  // IG-медиа-чипы живут по permalink (карточек IG-постов в приложении нет) → onPost не нужен.
  return (
    <div className="flex h-full flex-col gap-3">
      {/* overflow-y-auto — страховка половинной карточки (264px): хвост рассказа доскроллится,
          а не обрежется посреди строки. Леджер при этом остаётся приколоченным к низу. */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        <NarrativeProse paragraphs={buildIgWeekNarrative(input).paragraphs} />
      </div>
      {facts.length > 0 && (
        <aside className="flex shrink-0 flex-wrap gap-x-8 gap-y-2 border-t border-border pt-3">
          {facts.map((f) => (
            <div key={f.label}>
              <div className="text-2xs tracking-wide text-muted-foreground">{f.label}</div>
              <div className="mt-0.5 text-sm font-medium tabular-nums text-foreground">{f.value}</div>
            </div>
          ))}
        </aside>
      )}
    </div>
  );
}

/** Виджет-обёртка (IG-Обзор + Home-пин через id/homeKey — паттерн NarrativeWeekBlock). На IG-Обзоре
 *  ведёт на всю ширину ЖЁСТКО (fixedSize — ресайз в треть ломал ряд пустотой), в Home-реестре — half
 *  и свободный ресайз. */
export function IgNarrativeWeekBlock({
  id,
  homeKey,
  defaultSize = 'half',
  fixedSize,
  // Внутри IG-хаба сетевой префикс избыточен — Обзор передаёт «Неделя аккаунта» (зеркало
  // TG-«Недели канала»); Home-пин живёт среди смешанных сетей и оставляет дефолт «IG · Неделя».
  title = 'IG · Неделя',
}: { id?: string; homeKey?: string; defaultSize?: WidgetSize; fixedSize?: WidgetSize; title?: string } = {}) {
  return (
    <ChartSection id={id} homeKey={homeKey} title={title} defaultSize={defaultSize} fixedSize={fixedSize} noExpand>
      <IgNarrativeWeekBody />
    </ChartSection>
  );
}
