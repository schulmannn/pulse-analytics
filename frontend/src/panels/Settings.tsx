import { useCallback } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMe } from '@/api/queries';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
 * Настройки — a full-screen settings DIALOG over the dashboard (Claude-desktop style), not a page.
 * The /settings route stays; the component renders a fixed overlay: left mini-nav (pane switcher)
 * + one active section of setting rows. The active section lives in ?section= (replace-written,
 * default «account» = Профиль keeps the URL clean), so section clicks never pollute history and
 * closing is a single Back. Closing returns to the page the dialog was opened from; a deep-link
 * close lands on the overview.
 */
const ACCOUNT_SECTIONS = [
  { key: 'account', label: 'Профиль', icon: 'user' },
  { key: 'appearance', label: 'Оформление', icon: 'sun' },
  { key: 'security', label: 'Безопасность', icon: 'lock' },
  { key: 'billing', label: 'Подписка', icon: 'card' },
  { key: 'team', label: 'Команда', icon: 'users' },
] as const;
const DATA_SECTIONS = [
  { key: 'data', label: 'Данные', icon: 'database' },
  { key: 'channels', label: 'Каналы', icon: 'signal' },
  { key: 'instagram', label: 'Instagram', icon: 'instagram' },
] as const;
const SECTIONS = [...ACCOUNT_SECTIONS, ...DATA_SECTIONS];
type SectionKey = (typeof SECTIONS)[number]['key'];

const isSection = (raw: string | null): raw is SectionKey =>
  SECTIONS.some((s) => s.key === raw);

export function Settings() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const me = useMe();
  const isSuperuser = me.data?.role === 'superuser';
  const rawSection = params.get('section');
  const section: SectionKey = isSection(rawSection) ? rawSection : 'account';
  const active = SECTIONS.find((s) => s.key === section) ?? SECTIONS[0];

  // Replace-write (mirrors /analytics ?tab=): switching panes must not stack history entries,
  // so Back/Escape closes the dialog instead of unwinding section clicks.
  const setSection = useCallback(
    (next: SectionKey) => {
      setParams(
        (prev) => {
          const merged = new URLSearchParams(prev);
          if (next === 'account') merged.delete('section');
          else merged.set('section', next);
          return merged;
        },
        { replace: true },
      );
    },
    [setParams],
  );

  // Close = leave /settings. Opened in-app → back to the page underneath; direct deep-link
  // (this history entry is the first in-app one) → the overview. React-router keeps its entry
  // index in history.state.idx; section switches replace-write the URL, which regenerates
  // location.key but PRESERVES idx — so idx>0 (not key !== 'default') is the reliable
  // "there is an in-app page behind this dialog" signal even after section clicks.
  const close = useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (window.history.length > 1 && idx > 0) navigate(-1);
    else navigate('/');
  }, [navigate]);

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex h-full max-h-none w-full max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 bg-background p-0 md:h-[min(85vh,720px)] md:w-[calc(100%-3rem)] md:max-w-4xl md:flex-row md:rounded md:border md:border-border">
        <DialogDescription className="sr-only">
          Настройки аккаунта, данных и подключений
        </DialogDescription>
        <Tabs
          value={section}
          onValueChange={(value) => setSection(value as SectionKey)}
          className="flex h-full min-h-0 w-full flex-col md:flex-row"
        >
          {/* Left mini-nav — pane switcher (md+). */}
          <nav
            aria-label="Разделы настроек"
            className="hidden w-[200px] shrink-0 flex-col overflow-y-auto border-r border-border p-3 md:flex"
          >
            <div className="px-2.5 pb-3 pt-1 text-sm font-medium tracking-tight text-foreground">
              Настройки
            </div>
            <div className="space-y-0.5">
              {ACCOUNT_SECTIONS.map((item) => (
                <SectionNavItem
                  key={item.key}
                  item={item}
                  active={section === item.key}
                  onSelect={() => setSection(item.key)}
                />
              ))}
            </div>
            <p className="px-2.5 pb-1.5 pt-4 text-2xs font-medium tracking-wider text-muted-foreground">
              Данные и подключения
            </p>
            <div className="space-y-0.5">
              {DATA_SECTIONS.map((item) => (
                <SectionNavItem
                  key={item.key}
                  item={item}
                  active={section === item.key}
                  onSelect={() => setSection(item.key)}
                />
              ))}
            </div>
            {isSuperuser && (
              <>
                <div
                  className="mx-1 my-3 border-t border-border"
                  aria-hidden="true"
                />
                <Link
                  to="/admin"
                  className="flex items-center gap-2.5 rounded px-2.5 py-1.5 text-sm text-ink2 transition-colors hover:bg-hover-row/60 hover:text-foreground"
                >
                  <SettingsIcon name="shield" className="h-4 w-4 shrink-0" />
                  <span className="flex-1">Админ</span>
                  <SettingsIcon
                    name="external"
                    className="h-3.5 w-3.5 shrink-0 text-ink3"
                  />
                </Link>
              </>
            )}
          </nav>

          {/* Right column: header (+ mobile tab row) + the scrollable content pane. */}
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 md:px-8">
              <DialogTitle className="min-w-0 truncate pr-8 text-lg font-medium tracking-tight">
                <span className="md:hidden">Настройки</span>
                <span className="hidden md:inline">{active.label}</span>
              </DialogTitle>
            </header>

            {/* Mobile: the mini-nav becomes a horizontal scrollable tab row. */}
            <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border px-3 md:hidden">
              <TabsList
                aria-label="Разделы настроек"
                className="flex h-auto shrink-0 justify-start gap-1 rounded-none border-0 bg-transparent p-0"
              >
                {SECTIONS.map((item) => (
                  <TabsTrigger
                    key={item.key}
                    value={item.key}
                    className={cn(
                      'shrink-0 rounded-b-none rounded-t border-b-2 bg-transparent px-3 py-2 text-sm font-medium',
                      'border-transparent text-muted-foreground hover:text-foreground data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground',
                    )}
                  >
                    {item.label}
                  </TabsTrigger>
                ))}
              </TabsList>
              {isSuperuser && (
                <Link
                  to="/admin"
                  className="flex shrink-0 items-center gap-1 border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  Админ
                  <SettingsIcon name="external" className="h-3 w-3" />
                </Link>
              )}
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-5 md:px-8 md:py-6">
              <div className="mx-auto w-full max-w-[640px] space-y-10">
                {section === 'account' && <ProfileSection />}
                {section === 'appearance' && <AppearanceSection />}
                {section === 'security' && <SecuritySection />}
                {section === 'billing' && <BillingSection />}
                {section === 'team' && (
                  <TeamSection onOpenBilling={() => setSection('billing')} />
                )}
                {section === 'data' && (
                  <DataSection onOpenChannels={() => setSection('channels')} />
                )}
                {section === 'channels' && <ChannelsSection />}
                {section === 'instagram' && <InstagramSection />}
              </div>
            </div>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function SectionNavItem({
  item,
  active,
  onSelect,
}: {
  item: { key: SectionKey; label: string; icon: SettingsIconName };
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-2.5 rounded px-2.5 py-1.5 text-left text-sm transition-colors',
        active
          ? 'bg-hover-row font-medium text-foreground'
          : 'text-ink2 hover:bg-hover-row/60 hover:text-foreground',
      )}
    >
      <SettingsIcon name={item.icon} className="h-4 w-4 shrink-0" />
      <span className="truncate">{item.label}</span>
    </button>
  );
}
