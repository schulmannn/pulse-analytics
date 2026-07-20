import { Fragment } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { DeltaPill } from '@/components/DeltaPill';
import { ChartSection } from '@/components/instagram/shared';
import { fmt } from '@/lib/format';
import { isDrillKey } from '@/lib/kpiDerive';
import type { DrillKey } from '@/lib/kpiDerive';
import { useSelectedChannel } from '@/lib/channel-context';
import { setActiveNetwork } from '@/lib/networkStore';
import { cellTint } from '@/lib/reportTables';
import { isReportBlockKey } from '@/lib/reportBlocks';
import type { ReportBlock, ReportBlockKey, ReportBlockType } from '@/lib/reportBlocks';
import { Insights } from '@/panels/Insights';
import { NarrativeWeekBody } from '@/panels/NarrativeWeek';
import { TopPosts } from '@/panels/TopPosts';
import { BlockControls, BlockFrame, MiniSelect, Segmented } from '@/panels/report/blockChrome';
import {
  CHART_METRICS,
  InlineAdd,
  LEDGER,
  MapBlock,
  NotEnough,
  ReportChart,
  ReportMetricCard,
  TABLE_SOURCES,
  TextBlock,
} from '@/panels/report/blocks';
import type { ReportData } from '@/panels/report/useReportData';

interface CompositionProps {
  blocks: ReportBlock[];
  data: ReportData;
  /** true → inline editing chrome (add gaps, block toolbar, config selects, textarea). */
  editable: boolean;
  onInsert: (at: number, type: ReportBlockType, presetKey?: ReportBlockKey) => void;
  onMove: (idx: number, dir: -1 | 1) => void;
  onRemove: (idx: number) => void;
  onSetConfig: (idx: number, patch: Record<string, unknown>) => void;
}

function ReportSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="report-section">
      <ChartSection title={title}>{children}</ChartSection>
    </div>
  );
}

/**
 * The composed report body — config.blocks in order, single-column. Rendering is identical in
 * read and edit mode; only the chrome differs: when `editable`, every gap grows a hover «+», each
 * block gets a move/remove toolbar and its own config selects, and text is a textarea. In read
 * mode the same blocks render as a clean document (text is a paragraph, no controls, no add gaps).
 * Desktop toggles it with the read/edit switch. The frozen mobile document still owns its legacy
 * renderer and is intentionally not migrated in this release.
 */
export function ReportComposition({ blocks, data, editable, onInsert, onMove, onRemove, onSetConfig }: CompositionProps) {
  const { drillMeta, viewsSeries, reactionsSeries, subsSpark, weekly, chartSpec } = data;
  const { channelId, setChannelId } = useSelectedChannel();
  const openPinnedTelegramSource = () => {
    if (channelId == null) return;
    setActiveNetwork('tg');
    setChannelId(channelId);
  };

  const renderKpiLedger = (): ReactNode => (
    <div className="grid grid-cols-2 gap-px border-t border-border bg-border sm:grid-cols-3 lg:grid-cols-6">
      {LEDGER.map(({ key: k, label }) => (
        <Link
          key={k}
          to={`/metrics/${k}`}
          onClick={openPinnedTelegramSource}
          className="bg-background p-3 transition-colors hover:bg-muted/60"
        >
          <div className="text-2xs tracking-wide text-muted-foreground">{label}</div>
          <div className="mt-1 flex items-baseline gap-1.5">
            <span className="text-2xl font-medium tabular-nums tracking-tight">{drillMeta[k].total}</span>
            <DeltaPill delta={drillMeta[k].trend} subtle />
          </div>
        </Link>
      ))}
    </div>
  );

  const renderWeeklyTable = (): ReactNode => {
    if (!weekly) return null;
    return (
      <div className="report-table-group">
        <div className="report-table-shell overflow-x-auto">
          <table className="report-table w-full min-w-[560px] border-collapse text-sm">
            <thead>
              <tr>
                <th className="report-table__heading py-1.5 pr-2 text-left text-2xs font-medium tracking-wide text-muted-foreground">нед. с</th>
                {weekly.weeks.map((w) => (
                  <th key={w.key} className="report-table__heading px-1 py-1.5 text-right text-2xs font-medium tabular-nums text-muted-foreground">
                    {w.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {weekly.rows.map((row) => {
                const rowMax = Math.max(...row.values.map((v) => (v == null ? 0 : Math.abs(v))), 0);
                return (
                  <tr key={row.label} className="report-table__row border-t border-border">
                    <td className="report-table__label py-1 pr-2 text-xs text-muted-foreground">{row.label}</td>
                    {row.values.map((value, i) => (
                      <td key={weekly.weeks[i].key} className="report-table__cell px-1 py-1">
                        <div className="report-table__value relative overflow-hidden rounded px-2 py-1 text-right tabular-nums">
                          <div aria-hidden="true" className="absolute inset-0" style={cellTint(value, rowMax, row.signed)} />
                          <span className="relative">
                            {value == null
                              ? '—'
                              : row.signed
                                ? `${value > 0 ? '+' : value < 0 ? '−' : ''}${fmt.num(Math.abs(value))}`
                                : fmt.short(value)}
                          </span>
                        </div>
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="report-table__note mt-2 text-2xs text-muted-foreground">
          Заливка — доля от максимума строки; источник — дневной архив, последняя неделя может быть неполной.
        </p>
      </div>
    );
  };

  const renderPreset = (key: ReportBlockKey): ReactNode => {
    switch (key) {
      case 'kpi-summary':
        return <ReportSection title="Сводка">{renderKpiLedger()}</ReportSection>;
      case 'week':
      // 'digest' is the deprecated alias — the narrative replaces the old Digest «Инсайт» block.
      case 'digest':
        return (
          <ReportSection title="Неделя канала">
            <NarrativeWeekBody />
          </ReportSection>
        );
      case 'metric-views':
        return (
          <ReportMetricCard title="Просмотры по дням" total={drillMeta.views.total} trend={drillMeta.views.trend}
            series={viewsSeries} valueFmt={fmt.short} zeroBase to="/metrics/views" onOpen={openPinnedTelegramSource}
            chartAppearance="rhea" chartLabel="Просмотры" />
        );
      case 'metric-subscribers':
        return (
          <ReportMetricCard title="Подписчики по дням" total={drillMeta.subscribers.total} trend={drillMeta.subscribers.trend}
            series={subsSpark} valueFmt={fmt.num} to="/metrics/subscribers" onOpen={openPinnedTelegramSource}
            chartAppearance="rhea" chartLabel="Подписчики" />
        );
      case 'metric-reactions':
        return (
          <ReportMetricCard title="Реакции по дням" total={drillMeta.reactions.total} trend={drillMeta.reactions.trend}
            series={reactionsSeries} valueFmt={fmt.short} zeroBase to="/metrics/reactions" onOpen={openPinnedTelegramSource}
            chartAppearance="rhea" chartLabel="Реакции" />
        );
      case 'weekly-table': {
        const table = renderWeeklyTable();
        return table && <ReportSection title="По неделям · последние 6">{table}</ReportSection>;
      }
      case 'insights':
        return (
          <ReportSection title="Наблюдения">
            <Insights />
          </ReportSection>
        );
      case 'top-posts':
        return (
          <ReportSection title="Лучшие публикации">
            <div className="report-top-posts-table">
              <TopPosts />
            </div>
          </ReportSection>
        );
    }
  };

  const renderContent = (block: ReportBlock, idx: number): ReactNode => {
    switch (block.type) {
      case 'preset': {
        const key = block.config.key;
        return typeof key === 'string' && isReportBlockKey(key) ? renderPreset(key) : null;
      }
      case 'divider':
        return <hr className="border-0 border-t border-border" />;
      case 'text': {
        const text = typeof block.config.text === 'string' ? block.config.text : '';
        return editable ? (
          <TextBlock value={text} onChange={(t) => onSetConfig(idx, { text: t })} />
        ) : (
          <p className="whitespace-pre-wrap text-base leading-relaxed text-foreground">{text}</p>
        );
      }
      case 'bignumber': {
        const metric: DrillKey = typeof block.config.metric === 'string' && isDrillKey(block.config.metric) ? block.config.metric : 'views';
        const label = LEDGER.find((l) => l.key === metric)?.label ?? metric;
        return (
          <div>
            {editable && (
              <BlockControls>
                <MiniSelect ariaLabel="Метрика" value={metric} onChange={(v) => onSetConfig(idx, { metric: v })}
                  options={LEDGER.map((l) => ({ value: l.key, label: l.label }))} />
              </BlockControls>
            )}
            <div className="text-xs font-medium tracking-wider text-muted-foreground">{label}</div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-3xl font-medium tabular-nums tracking-tight">{drillMeta[metric].total}</span>
              <DeltaPill delta={drillMeta[metric].trend} />
            </div>
          </div>
        );
      }
      case 'chart': {
        const rawMetric = typeof block.config.metric === 'string' ? block.config.metric : 'views';
        const metric = CHART_METRICS.some((m) => m.value === rawMetric) ? rawMetric : 'views';
        const viz: 'line' | 'bar' = block.config.viz === 'bar' ? 'bar' : 'line';
        const spec = chartSpec(metric);
        const chartLabel = CHART_METRICS.find((option) => option.value === metric)?.label ?? spec.label;
        return (
          <section className="report-section min-w-0 space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="report-section__heading whitespace-nowrap text-xs font-medium tracking-wider text-muted-foreground">{spec.label}</h3>
              <span aria-hidden="true" className="report-section__rule h-px flex-1 bg-border" />
              {editable && (
                <BlockControls>
                  <MiniSelect ariaLabel="Метрика" value={metric} onChange={(v) => onSetConfig(idx, { metric: v })} options={CHART_METRICS} />
                  <Segmented value={viz} onChange={(v) => onSetConfig(idx, { viz: v })}
                    options={[{ value: 'line', label: 'Линия' }, { value: 'bar', label: 'Столбцы' }]} />
                </BlockControls>
              )}
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-medium tabular-nums tracking-tight">{drillMeta[spec.drill].total}</span>
              <DeltaPill delta={drillMeta[spec.drill].trend} subtle />
            </div>
            <ReportChart series={spec.series} viz={viz} valueFmt={spec.valueFmt} zeroBase={spec.zeroBase}
              chartAppearance={viz === 'line' ? 'rhea' : 'default'} chartLabel={chartLabel} />
          </section>
        );
      }
      case 'table': {
        const rawSource = typeof block.config.source === 'string' ? block.config.source : 'weekly';
        const source = TABLE_SOURCES.some((s) => s.value === rawSource) ? rawSource : 'weekly';
        const body =
          source === 'top-posts' ? (
            <div className="report-top-posts-table">
              <TopPosts />
            </div>
          ) : source === 'kpi-ledger' ? (
            renderKpiLedger()
          ) : (
            renderWeeklyTable()
          );
        const label = TABLE_SOURCES.find((s) => s.value === source)?.label ?? 'Таблица';
        return (
          <section className="report-section space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="report-section__heading whitespace-nowrap text-xs font-medium tracking-wider text-muted-foreground">{label}</h3>
              <span aria-hidden="true" className="report-section__rule h-px flex-1 bg-border" />
              {editable && (
                <BlockControls>
                  <MiniSelect ariaLabel="Источник" value={source} onChange={(v) => onSetConfig(idx, { source: v })} options={TABLE_SOURCES} />
                </BlockControls>
              )}
            </div>
            {body ?? <NotEnough />}
          </section>
        );
      }
      case 'map':
        return <MapBlock />;
    }
  };

  if (!editable) {
    // Read mode: a clean document — no add gaps, no toolbars. Vertical rhythm comes from the
    // block wrappers (InlineAdd carried it in edit mode).
    if (blocks.length === 0) {
      return (
        <p className="py-10 text-center text-sm text-muted-foreground">
          В этом отчёте пока нет блоков. Нажмите «Редактировать», чтобы собрать документ.
        </p>
      );
    }
    return (
      <div>
        {blocks.map((block, idx) => (
          <div key={block.id} className="mt-10 first:mt-0 print:mt-6">
            {renderContent(block, idx) ?? <NotEnough />}
          </div>
        ))}
      </div>
    );
  }

  // Edit mode (mobile always; desktop when editing): the historical inline-builder layout.
  return (
    <div>
      <InlineAdd allowMap={false} onAdd={(type, key) => onInsert(0, type, key)} />
      {blocks.map((block, idx) => (
        <Fragment key={block.id}>
          <div className="print:mt-6">
            <BlockFrame idx={idx} count={blocks.length} onMove={onMove} onRemove={onRemove}>
              {renderContent(block, idx) ?? <NotEnough />}
            </BlockFrame>
          </div>
          <InlineAdd allowMap={false} onAdd={(type, key) => onInsert(idx + 1, type, key)} />
        </Fragment>
      ))}
      {blocks.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Пустой отчёт. Нажмите «+», чтобы добавить блок.
        </p>
      )}
    </div>
  );
}
