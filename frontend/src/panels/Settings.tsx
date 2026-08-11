import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMe } from '@/api/queries';
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
 * Settings stays a first-class route in the dashboard shell. Three product-level categories keep
 * navigation shallow; the smaller settings inside each category form one continuous page. Existing
 * `?section=` links remain exact entry points and scroll to the requested section.
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

type CategoryKey = 'account' | 'workspace' | 'connections';

interface SectionItem {
  key: SectionKey;
  label: string;
  icon: SettingsIconName;
  description: string;
}

interface SettingsCategory {
  key: CategoryKey;
  label: string;
  tabLabel: string;
  description: string;
  defaultSection: SectionKey;
  items: readonly SectionItem[];
}

const CATEGORIES: readonly SettingsCategory[] = [
  {
    key: 'account',
    label: 'Аккаунт',
    tabLabel: 'Аккаунт',
    description: 'Профиль, внешний вид и безопасность вашего аккаунта.',
    defaultSection: 'account',
    items: [
      {
        key: 'account',
        label: 'Профиль',
        icon: 'user',
        description: 'Фото и основные данные, с которыми вы входите в Atlavue.',
      },
      {
        key: 'appearance',
        label: 'Оформление',
        icon: 'sun',
        description: 'Тема интерфейса на этом устройстве.',
      },
      {
        key: 'security',
        label: 'Безопасность',
        icon: 'lock',
        description: 'Пароль и управление аккаунтом.',
      },
    ],
  },
  {
    key: 'workspace',
    label: 'Рабочее пространство',
    tabLabel: 'Пространство',
    description: 'Тариф, команда и данные рабочего пространства.',
    defaultSection: 'billing',
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
        description: 'Участники, роли и совместный доступ.',
      },
      {
        key: 'data',
        label: 'Данные',
        icon: 'database',
        description: 'Состояние сбора, экспорт и переносимость данных.',
      },
    ],
  },
  {
    key: 'connections',
    label: 'Подключения',
    tabLabel: 'Подключения',
    description: 'Источники данных и внешние подключения.',
    defaultSection: 'channels',
    items: [
      {
        key: 'channels',
        label: 'Каналы',
        icon: 'signal',
        description: 'Telegram-каналы, коллекторы и ключи доступа.',
      },
      {
        key: 'instagram',
        label: 'Instagram',
        icon: 'instagram',
        description: 'OAuth-подключение и состояние аккаунта Instagram.',
      },
    ],
  },
] as const;

const SECTIONS = CATEGORIES.flatMap((category) => category.items);

const isSection = (raw: string | null): raw is SectionKey =>
  SECTIONS.some((section) => section.key === raw);

const categoryForSection = (section: SectionKey) =>
  CATEGORIES.find((category) =>
    category.items.some((item) => item.key === section),
  ) ?? CATEGORIES[0];

export function Settings() {
  const [params, setParams] = useSearchParams();
  const me = useMe();
  const rawSection = params.get('section');
  const section: SectionKey = isSection(rawSection) ? rawSection : 'account';
  const activeCategory = categoryForSection(section);
  const pendingSectionFocus = useRef<SectionKey | null>(null);
  const pendingCategoryFocus = useRef<{
    key: CategoryKey;
    moveFocus: boolean;
  } | null>(null);

  const revealSection = useCallback((target: SectionKey, moveFocus: boolean) => {
    const region = document.querySelector<HTMLElement>(
      `[data-settings-section="${target}"]`,
    );
    const heading = document.getElementById(`settings-${target}-title`);
    if (!region || !heading) return;
    region.scrollIntoView({ block: 'start' });
    if (moveFocus) heading.focus({ preventScroll: true });
  }, []);

  const revealCategory = useCallback((target: CategoryKey, moveFocus: boolean) => {
    const navigation = document.querySelector<HTMLElement>(
      'nav[aria-label="Категории настроек"]',
    );
    const heading = document.getElementById(`settings-category-${target}-title`);
    if (!navigation || !heading) return;
    navigation.scrollIntoView({ block: 'start' });
    if (moveFocus) heading.focus({ preventScroll: true });
  }, []);

  // Unknown values fall back safely and are removed without touching unrelated query params.
  useEffect(() => {
    if (rawSection === null || isSection(rawSection)) return;
    setParams(
      (previous) => {
        const merged = new URLSearchParams(previous);
        merged.delete('section');
        return merged;
      },
      { replace: true },
    );
  }, [rawSection, setParams]);

  // A direct deep link scrolls without stealing focus. Its category can still grow while async
  // sections above the target resolve, so a bounded ResizeObserver keeps the anchor in view until
  // layout settles or the user interacts. In-app actions move focus and do not need that follow-up.
  useEffect(() => {
    const categoryTarget = pendingCategoryFocus.current;
    if (categoryTarget) {
      const frame = requestAnimationFrame(() => {
        revealCategory(categoryTarget.key, categoryTarget.moveFocus);
        pendingCategoryFocus.current = null;
      });
      return () => cancelAnimationFrame(frame);
    }

    const target =
      pendingSectionFocus.current ?? (isSection(rawSection) ? rawSection : null);
    if (!target) return;
    let stopFollowing: (() => void) | undefined;
    const frame = requestAnimationFrame(() => {
      const moveFocus = pendingSectionFocus.current === target;
      revealSection(target, moveFocus);
      if (moveFocus) pendingSectionFocus.current = null;
      if (moveFocus || typeof ResizeObserver === 'undefined') return;

      const region = document.querySelector<HTMLElement>(
        `[data-settings-section="${target}"]`,
      );
      const category = region?.closest<HTMLElement>('[data-settings-category]');
      if (!category) return;

      let followFrame = 0;
      let timeout = 0;
      let stopped = false;
      const observer = new ResizeObserver(() => {
        if (stopped) return;
        cancelAnimationFrame(followFrame);
        followFrame = requestAnimationFrame(() => revealSection(target, false));
      });
      const stop = () => {
        if (stopped) return;
        stopped = true;
        observer.disconnect();
        cancelAnimationFrame(followFrame);
        clearTimeout(timeout);
        window.removeEventListener('pointerdown', stop, true);
        window.removeEventListener('wheel', stop, true);
        window.removeEventListener('touchstart', stop, true);
        window.removeEventListener('keydown', stop, true);
      };
      stopFollowing = stop;
      window.addEventListener('pointerdown', stop, true);
      window.addEventListener('wheel', stop, { capture: true, passive: true });
      window.addEventListener('touchstart', stop, { capture: true, passive: true });
      window.addEventListener('keydown', stop, true);
      observer.observe(category);
      timeout = window.setTimeout(stop, 3_000);
    });
    return () => {
      cancelAnimationFrame(frame);
      stopFollowing?.();
    };
  }, [rawSection, revealCategory, revealSection]);

  // Category changes replace the current URL entry: Back returns to the product instead of
  // replaying every settings category inspected in this session.
  const setSection = useCallback(
    (next: SectionKey) => {
      pendingSectionFocus.current = next;
      setParams(
        (previous) => {
          const merged = new URLSearchParams(previous);
          if (next === 'account') merged.delete('section');
          else merged.set('section', next);
          return merged;
        },
        { replace: true },
      );

      // React Router may elide a same-URL update. Re-selecting the active category still returns
      // the user to its first section and makes that destination explicit to assistive tech.
      if (next === section) {
        requestAnimationFrame(() => {
          revealSection(next, true);
          pendingSectionFocus.current = null;
        });
      }
    },
    [revealSection, section, setParams],
  );

  const setCategory = useCallback(
    (next: SettingsCategory, moveFocus: boolean) => {
      pendingCategoryFocus.current = { key: next.key, moveFocus };
      setParams(
        (previous) => {
          const merged = new URLSearchParams(previous);
          if (next.defaultSection === 'account') merged.delete('section');
          else merged.set('section', next.defaultSection);
          return merged;
        },
        { replace: true },
      );

      if (next.key === activeCategory.key) {
        requestAnimationFrame(() => {
          revealCategory(next.key, moveFocus);
          pendingCategoryFocus.current = null;
        });
      }
    },
    [activeCategory.key, revealCategory, setParams],
  );

  return (
    <div className="@container w-full max-w-[960px]">
      {/* Desktop already has the dashboard topbar; mobile needs its own page heading. */}
      <header className="mb-5 md:hidden">
        <h1 className="text-2xl font-medium tracking-tight text-foreground">
          Настройки
        </h1>
        <p className="mt-1 max-w-[56ch] text-sm leading-relaxed text-muted-foreground">
          Аккаунт, рабочее пространство и подключённые источники в одном месте.
        </p>
      </header>

      <nav
        aria-label="Категории настроек"
        className="scroll-mt-16 border-b border-border"
      >
        <div className="grid grid-cols-3 items-end">
          {CATEGORIES.map((category) => {
            const active = category.key === activeCategory.key;
            return (
              <button
                key={category.key}
                type="button"
                data-settings-category-trigger={category.key}
                aria-current={active ? 'page' : undefined}
                onClick={(event) => setCategory(category, event.detail === 0)}
                className={cn(
                  '-mb-px flex min-h-12 flex-1 items-center justify-center border-b-2 px-2 pb-3 pt-2 text-xs font-medium transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50 sm:text-sm',
                  active
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground',
                )}
              >
                {category.tabLabel}
              </button>
            );
          })}
        </div>
      </nav>

      <section
        aria-labelledby={`settings-category-${activeCategory.key}-title`}
        data-settings-category={activeCategory.key}
      >
        <header className="flex flex-wrap items-start justify-between gap-4 pb-7 pt-7 @min-[48rem]:pb-8 @min-[48rem]:pt-9">
          <div className="min-w-0">
            <h2
              id={`settings-category-${activeCategory.key}-title`}
              tabIndex={-1}
              className="rounded-sm text-2xl font-medium tracking-tight text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              {activeCategory.label}
            </h2>
            <p className="mt-1.5 max-w-[60ch] text-sm leading-relaxed text-muted-foreground">
              {activeCategory.description}
            </p>
          </div>
          {me.data?.role === 'superuser' && (
            <Link
              to="/admin"
              className="flex min-h-11 shrink-0 items-center gap-2 rounded-lg border border-border px-3 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/50 sm:min-h-9"
            >
              <SettingsIcon name="shield" className="h-3.5 w-3.5" />
              Админ
              <SettingsIcon name="external" className="h-3 w-3" />
            </Link>
          )}
        </header>

        <div className="border-b border-border">
          {activeCategory.items.map((item) => (
            <SettingsCategorySection key={item.key} item={item}>
              {renderSection(item.key, setSection)}
            </SettingsCategorySection>
          ))}
        </div>
      </section>
    </div>
  );
}

function SettingsCategorySection({
  item,
  children,
}: {
  item: SectionItem;
  children: ReactNode;
}) {
  return (
    <section
      id={`settings-section-${item.key}`}
      data-settings-section={item.key}
      aria-labelledby={`settings-${item.key}-title`}
      className="scroll-mt-24 border-t border-border py-7 @min-[48rem]:grid @min-[48rem]:grid-cols-[200px_minmax(0,1fr)] @min-[48rem]:gap-10 @min-[48rem]:py-8"
    >
      <header className="mb-5 @min-[48rem]:mb-0">
        <div className="flex items-start gap-3 @min-[48rem]:block">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border bg-card text-muted-foreground @min-[48rem]:mb-3">
            <SettingsIcon name={item.icon} className="h-4 w-4" />
          </span>
          <div className="min-w-0">
            <h3
              id={`settings-${item.key}-title`}
              tabIndex={-1}
              className="rounded-sm text-base font-medium tracking-tight text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            >
              {item.label}
            </h3>
            <p className="mt-1 max-w-[34ch] text-xs leading-relaxed text-ink3">
              {item.description}
            </p>
          </div>
        </div>
      </header>
      <div className="min-w-0">{children}</div>
    </section>
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
