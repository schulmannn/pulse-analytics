import { fmt } from '@/lib/format';
import { pairDelta, tvBreakdown, CONTACT_LABEL } from '@/lib/igMetrics';
import type { IgData } from '@/lib/useIgData';
import { Section, KpiCard } from '@/components/instagram/shared';
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

      <Section title="Лучшее время для публикации">
        <BestTimeHeatmap online={ig.online} />
      </Section>

      <Section title="Действия в профиле">
        {!hasViews && contacts.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Нет данных о действиях.</p>
        ) : (
          <div className="space-y-4">
            {hasViews && (
              <div className="grid grid-cols-1 gap-px border-t border-border bg-border sm:grid-cols-2">
                <KpiCard label="Визиты профиля" value={fmt.short(profileViews.cur)} trend={pairDelta(profileViews)} hint="за период" />
                <KpiCard label="Клики по кнопкам контакта" value={fmt.short(contactTotal)} hint="сайт · почта · звонок" />
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
      </Section>
    </div>
  );
}
