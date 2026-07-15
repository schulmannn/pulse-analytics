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

  // Факт-колонка (≥lg) — зеркало TG-«Недели канала» (#111): короткий рассказ оставлял правую
  // половину full-width карточки пустой. Факты из ТОГО ЖЕ входа (никаких новых запросов):
  // пик охвата, движение базы за 7 дней, текущая база — числа сходятся с рассказом по построению.
  const reach7 = input.reachDaily.slice(-7);
  const peak = reach7.length ? reach7.reduce((a, b) => (b.v > a.v ? b : a)) : null;
  const net7 = input.followsDaily.slice(-7).reduce((s, p) => s + p.v, 0);
  const facts: { label: string; value: string }[] = [];
  if (peak && peak.v > 0) facts.push({ label: 'Пик охвата', value: `${fmt.short(peak.v)} · ${fmt.day(peak.day)}` });
  if (input.followsDaily.length > 0 && net7 !== 0)
    facts.push({ label: 'Движение базы', value: `${net7 > 0 ? '+' : '−'}${fmt.num(Math.abs(net7))}` });
  if (input.followersNow != null) facts.push({ label: 'База', value: fmt.kpi(input.followersNow) });

  // IG-медиа-чипы живут по permalink (карточек IG-постов в приложении нет) → onPost не нужен.
  return (
    <div className="flex gap-6">
      <div className="min-w-0 flex-1">
        <NarrativeProse paragraphs={buildIgWeekNarrative(input).paragraphs} />
      </div>
      {facts.length > 0 && (
        <aside className="hidden w-44 shrink-0 space-y-3 border-l border-border pl-5 2xl:block">
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
