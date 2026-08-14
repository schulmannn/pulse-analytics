import { Link } from 'react-router-dom';
import type { IgData } from '@/lib/useIgData';
import {
  IgReachBody,
  IgAudienceBody,
  IgViewsBody,
  IgInteractionsBody,
  IgEngagementBody,
} from '@/components/instagram/shared';
import { TopPostsBlock } from '@/components/instagram/content';
import { ChartSection } from '@/components/ChartWidget';
import { WidgetGroup } from '@/components/widgets/WidgetGroup';
import { IgNarrativeWeekBlock } from '@/panels/IgNarrativeWeek';
import { InsightsBlock } from '@/components/instagram/insights';

/**
 * IG Обзор — the focused summary, mirroring the redesigned Telegram Overview: the old aggregate
 * «Показатели» hero (IgKpiBlock — kept for the legacy `ig-kpi` Home key) split into independent,
 * source-honest widgets. Row 1: «Охват» (the one honest daily series, half) + «Динамика аудитории»
 * (base + movement, half). Row 2: «Просмотры» / «Взаимодействия» / «Вовлечённость» as compact
 * non-temporal comparisons (third each — never a tiny timeline). Then «Неделя аккаунта» and the
 * top-posts teaser. Every card carries the full ⋯ contract and its own drill into /metrics/ig-*.
 *
 * No per-widget periodControl here: these bodies read the GLOBAL IG window (ig.pairs / ig.window)
 * threaded from the feed, so the section header's period chips are the honest single control.
 */
export function IgOverview({ ig }: { ig: IgData }) {
  return (
    <WidgetGroup id="ig-overview-v2" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
      {/* Row 1 — the two primary cards. Reach reuses the curated `ig-reach` Home key, so «На
          главную» pins the card it already knew; audience drills to /metrics/ig-follows.
          «Охват» — единственная тонированная карточка доски (канон: одна история = один цвет). */}
      <ChartSection
        id="ig-overview-reach"
        title="Охват"
        defaultSize="half"
        defaultColor={1}
        defaultTinted
        homeKey="ig-reach"
        drillTo="/metrics/ig-reach"
        variants={[
          { key: 'line', label: 'Линия', render: <IgReachBody ig={ig} /> },
          { key: 'bar', label: 'Столбцы', render: <IgReachBody ig={ig} viz="bar" /> },
        ]}
      />
      <ChartSection id="ig-overview-audience" title="Динамика аудитории" defaultSize="half" drillTo="/metrics/ig-follows">
        <IgAudienceBody ig={ig} />
      </ChartSection>
      {/* Row 2 — compact comparisons at third width. */}
      <ChartSection
        id="ig-overview-views"
        title="Просмотры"
        defaultSize="third"
        drillTo="/metrics/ig-views"
        variants={[
          { key: 'line', label: 'Линия', render: <IgViewsBody ig={ig} /> },
          { key: 'bar', label: 'Столбцы', render: <IgViewsBody ig={ig} viz="bar" /> },
        ]}
      />
      <ChartSection
        id="ig-overview-interactions"
        title="Взаимодействия"
        defaultSize="third"
        drillTo="/metrics/ig-interactions"
        variants={[
          // Столбцы первыми = дефолт (решение владельца 2026-08-13): счётный поток, а оконный
          // агрегат-одиночка столбцом виден. Сохранённый выбор юзера (prefs.variant) выигрывает.
          { key: 'bar', label: 'Столбцы', render: <IgInteractionsBody ig={ig} viz="bar" /> },
          { key: 'line', label: 'Линия', render: <IgInteractionsBody ig={ig} /> },
        ]}
      />
      {/* Вовлечённость — центрированный стат БЕЗ графика (владелец, 2026-08-14): вариантов
          line/bar больше нет, дневной ER остаётся на /metrics/ig-er. Сохранённый prefs.variant
          прежних вариантов просто игнорируется (children-режим ChartSection, как у TG ER). */}
      <ChartSection id="ig-overview-engagement" title="Вовлечённость" defaultSize="third" drillTo="/metrics/ig-er">
        <IgEngagementBody ig={ig} />
      </ChartSection>
      {/* The S/M/L grid pairs the narrative with one strongest rule-based insight at M/M;
          no unsupported footprint and no second wall of text. */}
      <IgNarrativeWeekBlock id="ig-overview-week" homeKey="ig-week" fixedSize="half" title="Неделя аккаунта" />
      <ChartSection id="ig-overview-change" title="Главное изменение" fixedSize="half" noExpand>
        <InsightsBlock insights={ig.insights} limit={1} />
      </ChartSection>
      <ChartSection
        id="ig-overview-top-posts"
        title="Лучшие публикации"
        defaultSize="full"
        action={
          <Link to="/instagram/content" className="shrink-0 text-xs font-medium text-primary hover:underline">
            <span className="md:hidden">Контент →</span>
            <span className="hidden md:inline">Открыть контент →</span>
          </Link>
        }
      >
        <TopPostsBlock posts={ig.postsInWindow} limit={3} showSort={false} />
      </ChartSection>
    </WidgetGroup>
  );
}
