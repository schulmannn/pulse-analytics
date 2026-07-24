import { fmt } from '@/lib/format';
import { pairDelta, tvBreakdown, CONTACT_LABEL } from '@/lib/igMetrics';
import type { IgData } from '@/lib/useIgData';
import { Section, KpiCard } from '@/components/instagram/shared';
import { ChartSection } from '@/components/ChartWidget';
import { WidgetGroup } from '@/components/widgets/WidgetGroup';
import { EmptyState } from '@/components/EmptyState';
import { AudienceBlock, BestTimeHeatmap } from '@/components/instagram/audience';
import { Breakdown } from '@/components/Breakdown';

/** IG Аудитория — demographics, posting time, and profile actions. */
export function IgAudience({ ig }: { ig: IgData }) {
  const contacts = tvBreakdown(ig.breakdowns?.data, 'profile_links_taps', 'contact_button_type').sort((a, b) => b.value - a.value);
  const profileViews = ig.pairs.profileViews;
  const hasViews = profileViews.hasCur && profileViews.cur > 0;
  const contactTotal = contacts.reduce((acc, it) => acc + it.value, 0);

  return (
    <div className="space-y-10">
      {/* «Демография», не «Аудитория» — блок фида уже называется «Аудитория», дубль-заголовок
          подряд читался как заикание (аудит 5.2). */}
      <Section title="Демография">
        <AudienceBlock breakdowns={ig.breakdowns} followers={ig.followers} />
      </Section>

      {/* A real widget card (not a flat h2 section): whole-card click opens the dedicated
          /metrics/ig-best-time page, the same route contract as the TG activity heatmap. */}
      <WidgetGroup id="ig-audience-actions" className="grid grid-flow-dense grid-cols-1 gap-6 lg:grid-cols-6">
        <ChartSection title="Лучшее время для публикации" defaultSize="full" drillTo="/metrics/ig-best-time">
          <BestTimeHeatmap online={ig.online} />
        </ChartSection>
        <ChartSection id="ig-profile-actions" title="Действия в профиле" defaultSize="full" noExpand>
        {!hasViews && contacts.length === 0 ? (
          <EmptyState compact title="Нет данных о действиях" />
        ) : (
          <div className="space-y-4">
            {hasViews && (
              <div className="grid grid-cols-1 gap-x-6 gap-y-4 border-t border-border pt-4 sm:grid-cols-2">
                <KpiCard label="Визиты профиля" value={fmt.kpi(profileViews.cur)} trend={pairDelta(profileViews)} hint="за период" />
                <KpiCard label="Клики по кнопкам контакта" value={fmt.kpi(contactTotal)} hint="сайт · почта · звонок" />
              </div>
            )}
            {contacts.length > 0 && (
              <Breakdown
                items={contacts.map((it) => ({
                  label: CONTACT_LABEL[it.label] ?? it.label,
                  value: it.value,
                  display: fmt.short(it.value),
                }))}
              />
            )}
          </div>
        )}
        </ChartSection>
      </WidgetGroup>
    </div>
  );
}
