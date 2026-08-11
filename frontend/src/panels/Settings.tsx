import { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMe } from '@/api/queries';
import {
  Dialog,
  DialogOverlay,
  DialogPortal,
  DialogSurface,
  DialogTitle,
  useRestoreOpenerFocus,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import {
  SettingsIcon,
  type SettingsIconName,
} from '@/components/settings/primitives';
import {
  AppearanceSection,
  ProfileSection,
  SecuritySection,
} from '@/components/settings/AccountSection';
import { BillingSection } from '@/components/settings/BillingSection';
import { TeamSection } from '@/components/settings/TeamSection';
import { DataSection } from '@/components/settings/DataSection';
import { ChannelsSection } from '@/components/settings/ChannelsSection';
import { InstagramSection } from '@/components/settings/InstagramSection';

/**
 * Settings is a first-class route inside the dashboard shell. The Kokonut-inspired pieces are
 * deliberately compositional: a calm active rail and a mobile bottom sheet. Account identity stays
 * in the dashboard shell instead of being repeated inside this route. The product keeps its own
 * tokens, Radix focus handling and URL state — no Motion, Vaul or copied demo state machines.
 */
type SectionKey =
  | 'account'
  | 'appearance'
  | 'security'
  | 'billing'
  | 'team'
  | 'data'
  | 'channels'
  | 'instagram';

interface SectionItem {
  key: SectionKey;
  label: string;
  icon: SettingsIconName;
  description: string;
}

interface SectionGroup {
  label: string;
  items: readonly SectionItem[];
}

const SECTION_GROUPS: readonly SectionGroup[] = [
  {
    label: 'Аккаунт',
    items: [
      {
        key: 'account',
        label: 'Профиль',
        icon: 'user',
        description: 'Фото, email и основные данные аккаунта.',
      },
      {
        key: 'appearance',
        label: 'Оформление',
        icon: 'sun',
        description: 'Тема и внешний вид интерфейса на этом устройстве.',
      },
      {
        key: 'security',
        label: 'Безопасность',
        icon: 'lock',
        description: 'Пароль и удаление аккаунта.',
      },
    ],
  },
  {
    label: 'Рабочее пространство',
    items: [
      {
        key: 'billing',
        label: 'Подписка',
        icon: 'card',
        description: 'Текущий тариф, возможности и лимиты.',
      },
      {
        key: 'team',
        label: 'Команда',
        icon: 'users',
        description: 'Участники, роли и доступ к рабочему пространству.',
      },
      {
        key: 'data',
        label: 'Данные',
        icon: 'database',
        description: 'Экспорт, переносимость и управление данными.',
      },
    ],
  },
  {
    label: 'Подключения',
    items: [
      {
        key: 'channels',
        label: 'Каналы',
        icon: 'signal',
        description: 'Источники данных и ключи внешних коллекторов.',
      },
      {
        key: 'instagram',
        label: 'Instagram',
        icon: 'instagram',
        description: 'OAuth-подключение и статус аккаунта Instagram.',
      },
    ],
  },
] as const;

const SECTIONS: readonly SectionItem[] = SECTION_GROUPS.flatMap((group) => group.items);

const isSection = (raw: string | null): raw is SectionKey =>
  SECTIONS.some((section) => section.key === raw);

export function Settings() {
  const [params, setParams] = useSearchParams();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const me = useMe();
  const isSuperuser = me.data?.role === 'superuser';
  const rawSection = params.get('section');
  const section: SectionKey = isSection(rawSection) ? rawSection : 'account';
  const active = SECTIONS.find((item) => item.key === section) ?? SECTIONS[0];

  // Section changes replace the current URL entry: Back returns to the previous product page
  // instead of replaying every settings section the user inspected.
  const setSection = useCallback(
    (next: SectionKey) => {
      setParams(
        (previous) => {
          const merged = new URLSearchParams(previous);
          if (next === 'account') merged.delete('section');
          else merged.set('section', next);
          return merged;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  const selectFromSheet = useCallback(
    (next: SectionKey) => {
      setMobileNavOpen(false);
      setSection(next);
    },
    [setSection],
  );

  return (
    <div className="mx-auto w-full max-w-[1040px]">
      {/* Desktop already has the dashboard topbar; mobile needs its own page heading. */}
      <header className="mb-5 md:hidden">
        <h1 className="text-2xl font-medium tracking-tight text-foreground">
          Настройки
        </h1>
        <p className="mt-1 max-w-[56ch] text-sm leading-relaxed text-muted-foreground">
          Управляйте аккаунтом, рабочим пространством и подключёнными источниками в одном месте.
        </p>
      </header>

      <button
        type="button"
        data-mobile-touch-target=""
        aria-label={`Выбрать раздел настроек, сейчас ${active.label}`}
        onClick={() => setMobileNavOpen(true)}
        className="mb-5 flex min-h-14 w-full items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/60 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/50 xl:hidden"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
          <SettingsIcon name={active.icon} className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-2xs font-medium uppercase tracking-wide text-ink3">
            Раздел настроек
          </span>
          <span className="mt-0.5 block truncate text-sm font-medium text-foreground">
            {active.label}
          </span>
        </span>
        <SettingsIcon name="arrow" className="h-4 w-4 shrink-0 text-muted-foreground" />
      </button>

      <div className="grid items-start gap-6 xl:grid-cols-[220px_minmax(0,760px)] xl:justify-center xl:gap-8">
        <aside className="sticky top-20 hidden xl:block">
          <nav
            aria-label="Разделы настроек"
            className="px-1"
          >
            {SECTION_GROUPS.map((group, groupIndex) => (
              <div
                key={group.label}
                className={cn(groupIndex > 0 && 'mt-5')}
              >
                <p className="px-2.5 pb-1 text-2xs font-medium uppercase tracking-wide text-ink3">
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {group.items.map((item) => (
                    <SectionNavItem
                      key={item.key}
                      item={item}
                      active={section === item.key}
                      onSelect={() => setSection(item.key)}
                    />
                  ))}
                </div>
              </div>
            ))}
            {isSuperuser && (
              <div className="mt-5">
                <Link
                  to="/admin"
                  className="flex min-h-10 items-center gap-2.5 rounded-xl px-2.5 py-2 text-sm text-ink2 transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/50"
                >
                  <SettingsIcon name="shield" className="h-4 w-4 shrink-0" />
                  <span className="flex-1">Админ</span>
                  <SettingsIcon name="external" className="h-3.5 w-3.5 text-ink3" />
                </Link>
              </div>
            )}
          </nav>
        </aside>

        <section
          aria-labelledby={`settings-${section}-title`}
          className="min-w-0 max-w-[760px]"
        >
          <div className="mb-5 min-w-0">
            <h2
              id={`settings-${section}-title`}
              className="text-xl font-medium tracking-tight text-foreground"
            >
              {active.label}
            </h2>
            <p className="mt-1 max-w-[56ch] text-sm leading-relaxed text-muted-foreground">
              {active.description}
            </p>
          </div>

          <div className="space-y-6">{renderSection(section, setSection)}</div>
        </section>
      </div>

      {mobileNavOpen && (
        <SettingsSectionSheet
          section={section}
          isSuperuser={isSuperuser}
          onSelect={selectFromSheet}
          onClose={() => setMobileNavOpen(false)}
        />
      )}
    </div>
  );
}

function renderSection(
  section: SectionKey,
  setSection: (section: SectionKey) => void,
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

function SectionNavItem({
  item,
  active,
  onSelect,
}: {
  item: SectionItem;
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'relative flex min-h-10 w-full items-center gap-2.5 overflow-hidden rounded-xl px-2.5 py-2 text-left text-sm transition-colors before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-primary before:opacity-0 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/50',
        active
          ? 'bg-card font-medium text-foreground before:opacity-100'
          : 'text-ink2 hover:bg-muted/60 hover:text-foreground',
      )}
    >
      <SettingsIcon name={item.icon} className="h-4 w-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </button>
  );
}

function SettingsSectionSheet({
  section,
  isSuperuser,
  onSelect,
  onClose,
}: {
  section: SectionKey;
  isSuperuser: boolean;
  onSelect: (section: SectionKey) => void;
  onClose: () => void;
}) {
  const restoreOpener = useRestoreOpenerFocus();

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogPortal>
        <DialogOverlay className="detail-backdrop-in" />
        <DialogSurface
          aria-labelledby="settings-section-sheet-title"
          onCloseAutoFocus={restoreOpener}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
          className="fixed inset-0 z-modal flex flex-col justify-end"
        >
          <div className="sheet-in pointer-events-auto relative z-10 flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-2xl border-t border-border bg-popover pb-[env(safe-area-inset-bottom)] sm:mx-auto sm:mb-4 sm:max-w-lg sm:rounded-2xl sm:border">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <DialogTitle id="settings-section-sheet-title" className="text-base">
                  Разделы настроек
                </DialogTitle>
                <p className="mt-1 text-xs text-muted-foreground">
                  Выберите, что хотите изменить.
                </p>
              </div>
              <button
                type="button"
                data-mobile-touch-target=""
                onClick={onClose}
                aria-label="Закрыть"
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/50 sm:h-8 sm:w-8"
              >
                <SettingsIcon name="close" className="h-4 w-4" />
              </button>
            </div>
            <nav aria-label="Разделы настроек" className="min-h-0 flex-1 overflow-y-auto p-2">
              {SECTION_GROUPS.map((group) => (
                <div key={group.label} className="pb-2 last:pb-0">
                  <p className="px-3 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-ink3">
                    {group.label}
                  </p>
                  {group.items.map((item) => {
                    const active = item.key === section;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        data-mobile-touch-target=""
                        aria-current={active ? 'page' : undefined}
                        onClick={() => onSelect(item.key)}
                        className={cn(
                          'flex min-h-12 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/50',
                          active
                            ? 'bg-muted font-medium text-foreground'
                            : 'text-ink2 hover:bg-muted/60 hover:text-foreground',
                        )}
                      >
                        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-border bg-background">
                          <SettingsIcon name={item.icon} className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm">{item.label}</span>
                          <span className="mt-0.5 block truncate text-2xs font-normal text-muted-foreground">
                            {item.description}
                          </span>
                        </span>
                        {active && (
                          <SettingsIcon name="check" className="h-4 w-4 shrink-0 text-verdant" />
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
              {isSuperuser && (
                <div className="border-t border-border pt-2">
                  <Link
                    to="/admin"
                    data-mobile-touch-target=""
                    className="flex min-h-12 items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-ink2 transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/50"
                  >
                    <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-border bg-background">
                      <SettingsIcon name="shield" className="h-4 w-4" />
                    </span>
                    <span className="flex-1">Админ</span>
                    <SettingsIcon name="external" className="h-3.5 w-3.5 text-ink3" />
                  </Link>
                </div>
              )}
            </nav>
          </div>
        </DialogSurface>
      </DialogPortal>
    </Dialog>
  );
}
