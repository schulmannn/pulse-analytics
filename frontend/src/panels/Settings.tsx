import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useChannels, useMe } from '@/api/queries';
import { pluralRu } from '@/lib/format';
import { SettingsIcon } from '@/components/settings/primitives';
import {
  AppearanceSection,
  ProfileSection,
  SecuritySection,
} from '@/components/settings/AccountSection';
import { BillingSection } from '@/components/settings/BillingSection';
import { ChannelsSection } from '@/components/settings/ChannelsSection';
import { DataSection } from '@/components/settings/DataSection';
import { TeamSection } from '@/components/settings/TeamSection';
import {
  Dialog,
  DialogClose,
  DialogOverlay,
  DialogPortal,
  DialogSurface,
  DialogTitle,
  useRestoreOpenerFocus,
} from '@/components/ui/dialog';
import { isPaidPlan, PLAN_LABEL, usePlan } from '@/lib/plan';
import { useTeam } from '@/api/team';
import { TEAM_LIMIT } from '@/lib/team';
import {
  isSettingsSection,
  LEGACY_SECTION_ALIASES,
  SETTINGS_GROUPS,
  SETTINGS_SECTIONS,
  type SettingsSectionKey,
} from '@/lib/settingsSections';
import { cn } from '@/lib/utils';
import { useScrollEdgeFade } from '@/lib/useScrollEdgeFade';

/**
 * /settings — модальный оверлей поверх приложения, не отдельная страница (решение владельца,
 * 2026-08). Роут остаётся: deep-links `?section=` работают, ProtectedApp рендерит за диалогом
 * страницу-источник (или Главную при прямом заходе). Закрытие возвращает в историю; ≥44rem
 * контейнера — рейл слева, уже — line-tabs. Горизонтальных линий у хрома нет — секции разделяет
 * воздух и тональные панели, единственная линия — вертикальный hairline рейла.
 */
export function Settings() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const me = useMe();
  const restoreOpener = useRestoreOpenerFocus();
  const rawSection = params.get('section');
  const requested =
    rawSection != null && rawSection in LEGACY_SECTION_ALIASES
      ? LEGACY_SECTION_ALIASES[rawSection]
      : rawSection;
  const section: SettingsSectionKey = isSettingsSection(requested) ? requested : 'account';
  const active = SETTINGS_SECTIONS.find((item) => item.key === section) ?? SETTINGS_SECTIONS[0];
  const pendingHeadingFocus = useRef<SettingsSectionKey | null>(null);

  // Неизвестный ключ вычищается, легаси-ключ (instagram) переписывается на новый дом — replace,
  // state сохраняется, чтобы фон-«подложка» модалки не сбрасывался.
  useEffect(() => {
    if (rawSection === null || isSettingsSection(rawSection)) return;
    const legacy = LEGACY_SECTION_ALIASES[rawSection];
    setParams(
      (previous) => {
        const merged = new URLSearchParams(previous);
        if (legacy) merged.set('section', legacy);
        else merged.delete('section');
        return merged;
      },
      { replace: true, state: location.state },
    );
  }, [rawSection, setParams, location.state]);

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
        { replace: true, state: location.state },
      );

      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('[data-settings-scroll]')?.scrollTo(0, 0);

        if (next === section && moveFocus) {
          document
            .getElementById(`settings-${next}-title`)
            ?.focus({ preventScroll: true });
          pendingHeadingFocus.current = null;
        }
      });
    },
    [section, setParams, location.state],
  );

  // Закрытие: шаг назад по истории (открыватель запушил /settings); прямой заход без истории
  // приземляется на Главную. Полная перезагрузка не нужна — это просто оверлей.
  const close = useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/home', { replace: true });
  }, [navigate]);

  const isSuperuser = me.data?.role === 'superuser';

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogPortal>
        <DialogOverlay />
        <DialogSurface
          aria-describedby={undefined}
          tabIndex={-1}
          onCloseAutoFocus={restoreOpener}
          onOpenAutoFocus={(event) => {
            // Дефолтный автофокус Radix зажигает focus-кольцо на первом пункте рейла (а фокус
            // заголовка зажигал бы его на h2). Начальный фокус — сама поверхность диалога:
            // читалка объявляет «Настройки», колец нет, Tab ведёт в рейл уже с честным кольцом.
            event.preventDefault();
            (event.currentTarget as HTMLElement | null)?.focus({ preventScroll: true });
          }}
          className={cn(
            '@container fixed inset-0 z-modal flex flex-col overflow-hidden bg-background',
            'sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-[min(44rem,calc(100dvh-3rem))] sm:w-[calc(100vw-2.5rem)] sm:max-w-[64rem] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border sm:border-border',
            'anim-dur-fast data-[state=open]:animate-in data-[state=open]:ease-house data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:ease-exit data-[state=closed]:anim-dur-exit data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 motion-reduce:duration-0',
          )}
        >
          <DialogTitle className="sr-only">Настройки</DialogTitle>

          {/* Узкий контейнер (телефон / маленькое окно): свой хром с закрытием + line-tabs. */}
          <div className="@min-[44rem]:hidden">
            <div className="flex items-center justify-between gap-3 pl-4 pr-2 pt-2">
              <span className="text-base font-medium text-foreground">Настройки</span>
              <DialogClose
                aria-label="Закрыть настройки"
                data-mobile-touch-target=""
                className="flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                <SettingsIcon name="close" className="h-4 w-4" />
              </DialogClose>
            </div>
            <SettingsTabsRow
              section={section}
              setSection={setSection}
              isSuperuser={isSuperuser}
              className="mx-4 mt-1"
            />
          </div>

          <div className="flex min-h-0 flex-1">
            <nav
              aria-label="Разделы настроек"
              className="hidden w-[220px] shrink-0 flex-col overflow-y-auto border-r border-border px-3 pb-4 pt-4 @min-[44rem]:flex"
            >
              <span aria-hidden="true" className="px-2.5 pb-4 text-sm font-medium text-foreground">
                Настройки
              </span>
              <div>
                {SETTINGS_GROUPS.map((group, groupIndex) => (
                  <div key={group.key}>
                    <p
                      className={cn(
                        'px-2.5 pb-1.5 text-2xs font-medium uppercase tracking-wider text-ink3',
                        groupIndex === 0 ? 'pt-0' : 'pt-6',
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
                  <div className="mt-4 border-t border-border pt-3">
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
              </div>
            </nav>

            <div className="relative min-w-0 flex-1">
              <DialogClose
                aria-label="Закрыть настройки"
                className="absolute right-3 top-3 z-10 hidden h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/50 @min-[44rem]:flex"
              >
                <SettingsIcon name="close" className="h-4 w-4" />
              </DialogClose>
              <div
                data-settings-scroll
                className="h-full overflow-y-auto overscroll-contain"
              >
                <div className="px-4 py-5 @min-[44rem]:px-8 @min-[44rem]:py-7">
                  <div
                    id="settings-detail"
                    role="tabpanel"
                    aria-labelledby={`settings-tab-${section}`}
                    data-settings-section={section}
                    className="w-full max-w-[672px]"
                  >
                    <header className="mb-6">
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
            </div>
          </div>
        </DialogSurface>
      </DialogPortal>
    </Dialog>
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
  const limit = isPaidPlan(plan) ? TEAM_LIMIT[plan] : null;
  // На free команды нет — запрос ростера там не нужен вовсе.
  const team = useTeam({ enabled: limit != null });
  if (limit == null || !team.data) return null;
  // Считаем МЕСТА ДЛЯ КОЛЛЕГ (владелец не в счёт) — ровно ту же величину, что печатает сама
  // секция «Команда». Раньше шапка считала владельца, а тело — нет, и на одном экране висели
  // «2 из 10» и «Занято 1 из 10».
  return <MetaText>{`${team.data.seats.used} из ${limit} мест`}</MetaText>;
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
    default:
      return <ProfileSection />;
  }
}
