import { Link } from 'react-router-dom';
import { buildIgWeekNarrative } from '@/lib/narrative';
import { ChartSection, type WidgetSize } from '@/components/ChartWidget';
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
  // IG-медиа-чипы живут по permalink (карточек IG-постов в приложении нет) → onPost не нужен.
  return <NarrativeProse paragraphs={buildIgWeekNarrative(input).paragraphs} />;
}

/** Виджет-обёртка (IG-Обзор + Home-пин через id/homeKey — паттерн NarrativeWeekBlock). На IG-Обзоре
 *  ведёт на всю ширину ЖЁСТКО (fixedSize — ресайз в треть ломал ряд пустотой), в Home-реестре — half
 *  и свободный ресайз. */
export function IgNarrativeWeekBlock({
  id,
  homeKey,
  defaultSize = 'half',
  fixedSize,
}: { id?: string; homeKey?: string; defaultSize?: WidgetSize; fixedSize?: WidgetSize } = {}) {
  return (
    <ChartSection id={id} homeKey={homeKey} title="IG · Неделя" defaultSize={defaultSize} fixedSize={fixedSize} noExpand>
      <IgNarrativeWeekBody />
    </ChartSection>
  );
}
