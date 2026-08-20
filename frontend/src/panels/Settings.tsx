import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useChannels, useMe } from '@/api/queries';
import { pluralRu } from '@/lib/format';
import { SettingsIcon } from '@/components/settings/primitives';
import { PLAN_LABEL, usePlan } from '@/lib/plan';
import { useTeam } from '@/lib/team';
import {
  AppearanceSection,
  ProfileSection,
  SecuritySection,
} from '@/components/settings/AccountSection';
import { BillingSection } from '@/components/settings/BillingSection';
import { ChannelsSection } from '@/components/settings/ChannelsSection';
import { DataSection } from '@/components/settings/DataSection';
import { InstagramSection } from '@/components/settings/InstagramSection';
import { TeamSection } from '@/components/settings/TeamSection';
import {
  isSettingsSection,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  type SettingsSectionKey,
} from '@/lib/settingsSections';
import { cn } from '@/lib/utils';
import { useScrollEdgeFade } from '@/lib/useScrollEdgeFade';

export function Settings() {
  const [params, setParams] = useSearchParams();
  const me = useMe();
  const rawSection = params.get('section');
  const section: SettingsSectionKey = isSettingsSection(rawSection)
    ? rawSection
    : 'account';
  const active = SETTINGS_SECTIONS.find((item) => item.key === section) ?? SETTINGS_SECTIONS[0];
  const pendingHeadingFocus = useRef<SettingsSectionKey | null>(null);

  useEffect(() => {
    if (rawSection === null || isSettingsSection(rawSection)) return;
    setParams(
      (previous) => {
        const merged = new URLSearchParams(previous);
        merged.delete('section');
        return merged;
      },
      { replace: true },
    );
  }, [rawSection, setParams]);

  useEffect(() => {
    if (pendingHeadingFocus.current !== section) return;
    const frame = requestAnimationFrame(() => {
      document
        .getElementById(`settings-${section}-title`)
        ?.focus({ preventScroll: true });
      pendingHeadingFocus.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [section]);

  const setSection = useCallback(
    (next: SettingsSectionKey, moveFocus = false) => {
      pendingHeadingFocus.current = moveFocus ? next : null;
      setParams(
        (previous) => {
          const merged = new URLSearchParams(previous);
          if (next === 'account') merged.delete('section');
          else merged.set('section', next);
          return merged;
        },
        { replace: true },
      );

      requestAnimationFrame(() => {
        const scroller = document.querySelector<HTMLElement>('[data-dashboard-scroll]');
        if (scroller && window.matchMedia('(min-width: 768px)').matches) {
          scroller.scrollTo(0, 0);
        } else window.scrollTo(0, 0);

        if (next === section && moveFocus) {
          document
            .getElementById(`settings-${next}-title`)
            ?.focus({ preventScroll: true });
          pendingHeadingFocus.current = null;
        }
      });
    },
    [section, setParams],
  );

  const isSuperuser = me.data?.role === 'superuser';

  return (
    <div className="@container w-full max-w-[928px]">
      <header className="mb-5 md:hidden">
        <h1 className="text-2xl font-medium tracking-tight text-foreground">
          Настройки
        </h1>
        <p className="mt-1 max-w-[56ch] text-sm leading-relaxed text-muted-foreground">
          Аккаунт, рабочее пространство и подключённые источники в одном месте.
        </p>
      </header>

      <SettingsTabsRow
        section={section}
        setSection={setSection}
        isSuperuser={isSuperuser}
        className="mb-6 @min-[44rem]:hidden"
      />

      <div className="@min-[44rem]:grid @min-[44rem]:grid-cols-[200px_minmax(0,672px)] @min-[44rem]:gap-12">
        <nav
          aria-label="Разделы настроек"
          className="hidden @min-[44rem]:sticky @min-[44rem]:top-18 @min-[44rem]:block @min-[44rem]:self-start"
        >
          {SETTINGS_GROUPS.map((group, groupIndex) => (
            <div key={group.key}>
              <p
                className={cn(
                  'px-2.5 pb-1.5 text-2xs font-medium uppercase tracking-wider text-ink3',
                  groupIndex === 0 ? 'pt-1' : 'pt-6',
                )}
              >
                {group.label}
              </p>
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const selected = item.key === section;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      data-settings-nav-item={item.key}
                      aria-current={selected ? 'true' : undefined}
                      onClick={(event) => setSection(item.key, event.detail === 0)}
                      className={cn(
                        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
                        selected
                          ? 'bg-hover-row font-medium text-foreground'
                          : 'text-ink2 hover:bg-hover-row/60 hover:text-foreground',
                      )}
                    >
                      <SettingsIcon name={item.icon} className="h-4 w-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
          {isSuperuser && (
            <div className="mt-3 border-t border-border pt-3">
              <Link
                to="/admin"
                className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-ink2 transition-colors hover:bg-hover-row/60 hover:text-foreground"
              >
                <SettingsIcon name="shield" className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Админ</span>
                <SettingsIcon name="external" className="h-3.5 w-3.5 shrink-0 text-ink3" />
              </Link>
            </div>
          )}
        </nav>

        <div
          id="settings-detail"
          role="tabpanel"
          aria-labelledby={`settings-tab-${section}`}
          data-settings-section={section}
          className="min-w-0"
        >
          <header className="mb-7 border-b border-border pb-6">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <h2
                id={`settings-${section}-title`}
                tabIndex={-1}
                className="rounded-sm text-2xl font-medium tracking-tight text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                {active.label}
              </h2>
              <SectionMeta section={section} />
            </div>
            <p className="mt-1.5 max-w-[60ch] text-sm leading-relaxed text-muted-foreground">
              {active.description}
            </p>
          </header>
          {renderSection(section, setSection)}
        </div>
      </div>
    </div>
  );
}

function SettingsTabsRow({
  section,
  setSection,
  isSuperuser,
  className,
}: {
  section: SettingsSectionKey;
  setSection: (section: SettingsSectionKey, moveFocus?: boolean) => void;
  isSuperuser: boolean;
  className?: string;
}) {
  const tabsFadeRef = useScrollEdgeFade<HTMLDivElement>();
  return (
    <div ref={tabsFadeRef} className={cn('scroll-fade-x flex gap-1 overflow-x-auto border-b border-border', className)}>
      <div role="tablist" aria-label="Разделы настроек" className="flex shrink-0 gap-1">
        {SETTINGS_SECTIONS.map((item) => {
          const selected = item.key === section;
          return (
            <button
              key={item.key}
              id={`settings-tab-${item.key}`}
              type="button"
              role="tab"
              data-mobile-touch-target=""
              aria-selected={selected}
              aria-current={selected ? 'true' : undefined}
              aria-controls="settings-detail"
              tabIndex={selected ? 0 : -1}
              onClick={(event) => setSection(item.key, event.detail === 0)}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
                event.preventDefault();
                const index = SETTINGS_SECTIONS.findIndex((candidate) => candidate.key === item.key);
                const step = event.key === 'ArrowRight' ? 1 : SETTINGS_SECTIONS.length - 1;
                const next = SETTINGS_SECTIONS[(index + step) % SETTINGS_SECTIONS.length];
                setSection(next.key);
                requestAnimationFrame(() => {
                  document.getElementById(`settings-tab-${next.key}`)?.focus();
                });
              }}
              className={cn(
                'min-h-11 shrink-0 rounded-none border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50',
                selected
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      {isSuperuser && (
        <Link
          to="/admin"
          data-mobile-touch-target=""
          className="flex min-h-11 shrink-0 items-center gap-1 border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          Админ
          <SettingsIcon name="external" className="h-3 w-3" />
        </Link>
      )}
    </div>
  );
}

/**
 * Тихая техническая выкладка в шапке секции — счётчик, который у страницы уже есть в кэше
 * (никаких новых запросов ради подписи). Рендерится только для активной секции.
 */
function SectionMeta({ section }: { section: SettingsSectionKey }) {
  if (section === 'billing') return <BillingMeta />;
  if (section === 'team') return <TeamMeta />;
  if (section === 'channels') return <ChannelsMeta />;
  return null;
}

function MetaText({ children }: { children: ReactNode }) {
  return (
    <span className="text-xs tabular-nums text-ink3" data-settings-section-meta="">
      {children}
    </span>
  );
}

function BillingMeta() {
  const plan = usePlan();
  return <MetaText>{PLAN_LABEL[plan]}</MetaText>;
}

function TeamMeta() {
  const plan = usePlan();
  const team = useTeam();
  const limit = plan === 'max' ? 10 : plan === 'pro' ? 3 : null;
  if (limit == null) return null;
  // Владелец занимает первое место — ростер показывает его той же строкой.
  return <MetaText>{`${Math.min(team.length + 1, limit)} из ${limit} мест`}</MetaText>;
}

function ChannelsMeta() {
  const { data } = useChannels();
  const count = data?.channels.length ?? 0;
  if (!data?.enabled || count === 0) return null;
  return (
    <MetaText>{`${count} ${pluralRu(count, ['источник', 'источника', 'источников'])}`}</MetaText>
  );
}

function renderSection(
  section: SettingsSectionKey,
  setSection: (section: SettingsSectionKey, moveFocus?: boolean) => void,
) {
  switch (section) {
    case 'appearance':
      return <AppearanceSection />;
    case 'security':
      return <SecuritySection />;
    case 'billing':
      return <BillingSection />;
    case 'team':
      return <TeamSection onOpenBilling={() => setSection('billing')} />;
    case 'data':
      return <DataSection onOpenChannels={() => setSection('channels')} />;
    case 'channels':
      return <ChannelsSection />;
    case 'instagram':
      return <InstagramSection />;
    default:
      return <ProfileSection />;
  }
}
