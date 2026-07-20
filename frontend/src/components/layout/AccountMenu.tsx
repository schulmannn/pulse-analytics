import { NavLink, useNavigate } from 'react-router-dom';
import { useLogout } from '@/api/queries';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTheme } from '@/lib/theme';
import { Icon } from '@/components/nav-icons';
import { SUPER_NAV } from './nav';

/** Letter-badge fallback for the account avatar — first two letters of the mailbox name. */
export const avatarInitials = (email?: string) =>
  (email
    ? email
        .replace(/@.*/, '')
        .replace(/[^\p{L}]/gu, '')
        .slice(0, 2)
        .toUpperCase()
    : '') || '?';

const THEME_MODES = [
  { mode: 'light', icon: 'sun', label: 'Светлая тема' },
  { mode: 'system', icon: 'monitor', label: 'Как в системе' },
  { mode: 'dark', icon: 'moon', label: 'Тёмная тема' },
] as const;

/** Compact radio group powered by the shadcn/Radix menu keyboard model. */
function ThemeRow() {
  const { mode, setMode } = useTheme();
  return (
    <DropdownMenuGroup className="flex items-center justify-between gap-3 px-2.5 py-1">
      <DropdownMenuLabel className="p-0 text-xs font-normal text-muted-foreground">
        Тема
      </DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={mode}
        onValueChange={(value) => setMode(value as typeof mode)}
        className="flex items-center gap-0.5 rounded-full border border-border p-0.5"
      >
        {THEME_MODES.map((item) => (
          <DropdownMenuRadioItem
            key={item.mode}
            value={item.mode}
            aria-label={item.label}
            title={item.label}
            className="flex h-6 w-6 justify-center rounded-full p-0 text-muted-foreground focus:bg-muted focus:text-foreground data-[state=checked]:bg-muted data-[state=checked]:text-foreground [&>span]:hidden"
          >
            <Icon name={item.icon} className="h-3.5 w-3.5" />
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}

/** Shared account-menu body for mobile and desktop triggers. */
export function AccountMenuContent({
  email,
  role,
  avatar,
  onClose,
}: {
  email?: string;
  role?: string;
  avatar?: string | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const logoutMutation = useLogout();
  const handleLogout = () =>
    logoutMutation.mutate(undefined, {
      onSettled: () => navigate('/login', { replace: true }),
    });

  return (
    <>
      {email && (
        <>
          <div className="flex items-center gap-2.5 px-2.5 py-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-full bg-avatar text-2xs font-medium text-ink2">
              {avatar ? (
                <img
                  src={avatar}
                  alt=""
                  className="h-full w-full object-cover"
                />
              ) : (
                avatarInitials(email)
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="min-w-0 truncate text-sm font-medium text-foreground">
                  {email.replace(/@.*/, '')}
                </span>
                {role === 'superuser' && <Badge variant="outline">Админ</Badge>}
              </div>
              <div className="truncate text-2xs text-muted-foreground">
                {email}
              </div>
            </div>
          </div>
          <DropdownMenuSeparator />
        </>
      )}

      <DropdownMenuItem asChild>
        <NavLink to="/settings" onClick={onClose}>
          <Icon name="gear" className="text-muted-foreground" />
          Настройки
        </NavLink>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <NavLink to="/settings?section=billing" onClick={onClose}>
          <Icon name="card" className="text-muted-foreground" />
          Подписка
        </NavLink>
      </DropdownMenuItem>
      <ThemeRow />

      {role === 'superuser' && (
        <>
          <DropdownMenuSeparator />
          {SUPER_NAV.map((item) => (
            <DropdownMenuItem key={item.to} asChild>
              <NavLink to={item.to} end={item.end} onClick={onClose}>
                <Icon name={item.icon} className="text-muted-foreground" />
                {item.label}
              </NavLink>
            </DropdownMenuItem>
          ))}
        </>
      )}

      <DropdownMenuSeparator />
      <DropdownMenuItem
        disabled={logoutMutation.isPending}
        onSelect={(event) => {
          event.preventDefault();
          handleLogout();
        }}
        className="group focus:bg-destructive/10 focus:text-destructive"
      >
        <Icon
          name="logout"
          className="text-muted-foreground transition-colors group-focus:text-destructive"
        />
        {logoutMutation.isPending ? 'Выход…' : 'Выйти'}
      </DropdownMenuItem>
    </>
  );
}

/** Account dropdown for the mobile header. Desktop uses the same body from SidebarUserRow. */
export function AccountMenu({
  email,
  role,
  avatar,
}: {
  email?: string;
  role?: string;
  avatar?: string | null;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Аккаунт"
          className="shrink-0 overflow-hidden rounded-full bg-avatar p-0 text-2xs font-medium text-ink2 hover:bg-muted"
        >
          {avatar ? (
            <img src={avatar} alt="" className="h-full w-full object-cover" />
          ) : (
            avatarInitials(email)
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4} className="w-64">
        <AccountMenuContent
          email={email}
          role={role}
          avatar={avatar}
          onClose={() => undefined}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
