import { useState } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChartSection as ChartWidget } from '@/components/ChartWidget';
import { ChartSection as RailSection } from '@/components/instagram/shared';
import { SegmentedControl } from '@/components/SegmentedControl';
import { PeriodChips } from '@/components/PeriodChips';
import { SourceIdentity } from '@/components/SourceIdentity';
import { ChartExpandedContext, ExpandedChartHeightContext } from '@/components/ExpandableChart';
import { HeatmapWidgetBody, VelocityWidgetBody } from '@/panels/Charts';
import { usePeriod } from '@/lib/period';
import { WidgetPeriodProvider, widgetPeriodValue } from '@/lib/period';
import { useExplorerChartHeight } from '@/lib/useExplorerChartHeight';
import { isTgExtraMetricKey } from '@/panels/tgMetricKeys';

/**
 * Полностраничные «дополнительные» графики Telegram — `/metrics/tg-*`. Это те карточки вкладок
 * Аналитики, что НЕ входят в числовой drill-набор kpiDerive (views/avgReach/…/subscribers → steep
 * MetricPage): тепловая карта активности и профиль скорости набора просмотров. Раньше они открывали
 * generic `?detail=` оверлей — теперь ведут на выделенный route той же грамматики, что `/metrics/ig-views`
 * и `/metrics/ym-visits`: назад-ссылка, тихая шапка (имя метрики + источник + дескриптор), две колонки
 * (главный блок + rail «О метрике»), контролы под графиком.
 *
 * ЧЕСТНОСТЬ важнее паритета: тепловая карта — своя 7×24 форма без Line/Bar/сравнения; скорость —
 * настоящий кумулятивный профиль с выбором Line/Bar, но без выдуманного baseline-сравнения (это
 * агрегат по всем постам, у него нет «прошлого периода»).
 */
export function TgMetricPage({ metricKey }: { metricKey: string }) {
  if (!isTgExtraMetricKey(metricKey)) return null;
  switch (metricKey) {
    case 'tg-heatmap':
      return <TgHeatmapPage />;
    case 'tg-velocity':
      return <TgVelocityPage />;
    default:
      return null;
  }
}

/** Re-export guard so the route dispatcher can gate `tg-*` extra keys without importing the page eagerly. */
export { isTgExtraMetricKey };

// ── Shared shell ─────────────────────────────────────────────────────────────────────────────

interface AboutDef {
  formula: string;
  included?: string;
  source: string;
}

/** Тихая шапка + две колонки (главный блок + rail «О метрике»/сравнение), как у `/metrics/ig-reach`.
    Назад ведёт на конкретную вкладку Аналитики, откуда карточка засеяла drillTo. */
function TgMetricShell({
  back,
  term,
  descriptor,
  about,
  aside,
  children,
}: {
  back: { to: string; label: string };
  term: string;
  descriptor?: string;
  about: AboutDef;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-5">
      <Link
        to={back.to}
        className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <span aria-hidden="true">←</span> {back.label}
      </Link>

      <div>
        <h1 className="text-2xl font-medium tracking-tight text-foreground">{term}</h1>
        <SourceIdentity network="tg" className="mt-1 max-w-full" />
        {descriptor && <div className="mt-1.5 text-xs text-muted-foreground">{descriptor}</div>}
      </div>

      <div className="grid grid-cols-1 gap-6 xl:gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="min-w-0 space-y-6">{children}</div>
        <aside className="space-y-6">
          {aside}
          <RailSection title="О метрике">
            <dl className="space-y-3 text-sm">
              <AboutRow label="Как считается" text={about.formula} />
              {about.included && <AboutRow label="Что учитывается" text={about.included} />}
              <AboutRow label="Источник" text={about.source} />
            </dl>
          </RailSection>
          <Link
            to={back.to}
            className="inline-flex items-center gap-1 text-xs font-medium text-primary transition-colors hover:text-primary/80"
          >
            Открыть Аналитику <span aria-hidden="true">→</span>
          </Link>
        </aside>
      </div>
    </div>
  );
}

function AboutRow({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <dt className="text-2xs tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm leading-relaxed text-foreground">{text}</dd>
    </div>
  );
}

/** Полноэкранная карточка с раскрытым (не-expandable) телом — та же роль, что у YmReportCard.
    Раскрытые контексты дают LineChart/BarChart полную высоту explorer'а (heatmap их игнорирует). */
function TgReportCard({ id, title, action, children }: { id: string; title: string; action?: ReactNode; children: ReactNode }) {
  const chartH = useExplorerChartHeight();
  return (
    <ChartWidget id={id} title={title} defaultSize="full" noExpand action={action}>
      <ChartExpandedContext.Provider value={true}>
        <ExpandedChartHeightContext.Provider value={chartH}>{children}</ExpandedChartHeightContext.Provider>
      </ChartExpandedContext.Provider>
    </ChartWidget>
  );
}

// ── Activity heatmap page ──────────────────────────────────────────────────────────────────────

/** Тепловая карта активности 7×24 — своя форма распределения, БЕЗ Line/Bar/сравнения. Тело
    (HeatmapWidgetBody) само фетчит useTgFull(0) и окном режет по useWidgetPeriod, поэтому оборачиваем
    в WidgetPeriodProvider, засеянный глобальным explorer-периодом (тем, что drillTo протащил из
    фид-топбара). Прямой заход/reload держат контекст: usePeriod URL-persist + канал из useSelectedChannel. */
function TgHeatmapPage() {
  const { days, setDays, range, setRange } = usePeriod();
  return (
    <TgMetricShell
      back={{ to: '/analytics?tab=audience', label: 'Аналитика · Аудитория' }}
      term="Тепловая карта активности"
      descriptor="Когда посты собирают вовлечённость — сетка 7×24 по среднему ERV слота за выбранное окно"
      about={{
        formula:
          'Для каждого слота (день недели × час публикации) — средний ERV постов слота (реакции + репосты + ответы ÷ просмотры). Насыщенность нормирована на максимум окна; рамкой отмечен лучший слот.',
        included:
          'ERV — вовлечённость на просмотр, не абсолют. Часы — в часовом поясе браузера (как в дате поста). Пустые края суток скрываются, чтобы узкое окно не тонуло в мёртвых клетках.',
        source: 'Посты канала (архив Telegram) за выбранное окно.',
      }}
    >
      <TgReportCard id="tg-page-heatmap" title="По дням недели и часам">
        <WidgetPeriodProvider value={widgetPeriodValue(days, range)}>
          <HeatmapWidgetBody />
        </WidgetPeriodProvider>
      </TgReportCard>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-2.5 print:hidden">
        <span className="text-xs font-medium text-muted-foreground">Окно</span>
        <span className="flex-1" />
        <PeriodChips ariaLabel="Окно" value={days} onChange={setDays} range={range} onRangeChange={setRange} />
      </div>
    </TgMetricShell>
  );
}

// ── Views-velocity page ────────────────────────────────────────────────────────────────────────

/** Скорость набора просмотров — кумулятивный профиль (какая доля итоговых просмотров набрана к N-м
    суткам после публикации, усреднённо по постам). Line/Bar оба честны для накопительной кривой;
    сравнения нет — это агрегат-профиль по всем постам, «прошлого периода» у него не существует.
    useVelocity() без периода (ключ — канал), так что окна тут нет, как и у ym-hourly нет Line/Bar. */
function TgVelocityPage() {
  const [kind, setKind] = useState<'line' | 'bar'>('line');
  return (
    <TgMetricShell
      back={{ to: '/analytics?tab=dynamics', label: 'Аналитика · Динамика' }}
      term="Скорость набора просмотров"
      descriptor="Как быстро пост добирает свои просмотры — накопленная доля по суткам после публикации"
      about={{
        formula:
          'Для каждого поста доля итоговых просмотров, набранная к N-м суткам жизни; кривая — среднее по постам. «80% за K дн» — когда накоплено 80% просмотров.',
        included:
          'Это профиль ЖИЗНИ поста (сутки после публикации), а не календарная динамика. Считается по постам с достаточной историей просмотров.',
        source: 'Дневная история просмотров постов канала (Telegram).',
      }}
    >
      <TgReportCard
        id="tg-page-velocity"
        title="Накопленная доля просмотров"
        action={
          <SegmentedControl
            ariaLabel="Тип графика"
            className="shrink-0"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'line', content: 'Линия', ariaLabel: 'Тип графика: Линия' },
              { value: 'bar', content: 'Столбцы', ariaLabel: 'Тип графика: Столбцы' },
            ]}
          />
        }
      >
        <VelocityWidgetBody viz={kind === 'bar' ? 'bar' : 'line'} />
      </TgReportCard>
    </TgMetricShell>
  );
}
