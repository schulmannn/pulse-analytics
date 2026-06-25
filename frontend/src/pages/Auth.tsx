import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForgot, useLogin, useRegister, useReset, useVerify } from '@/api/queries';

/*  DESIGN: Claude — resend-style dark auth view, ported from the legacy `#auth-view`
    (public/index.html). Wrapped in `.dark` so the dark tokens apply regardless of app
    theme; colors are semantic/brand tokens only (no hex). The mutation logic is the
    original functional flow (login/register/verify/reset/forgot) untouched. */

const INPUT_CLASS =
  'w-full rounded-md border border-white/15 bg-white/[0.04] px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50';
const BUTTON_CLASS =
  'mt-5 w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50';
const LABEL_CLASS = 'mb-1.5 block text-sm font-medium text-muted-foreground';
const LINK_CLASS = 'cursor-pointer font-medium text-foreground hover:underline';

const GLOW_BG = {
  backgroundImage: [
    'radial-gradient(720px 460px at 88% 12%, hsl(var(--primary) / 0.18), transparent 62%)',
    'radial-gradient(560px 420px at 6% 96%, hsl(var(--primary) / 0.10), transparent 60%)',
    'linear-gradient(180deg, hsl(var(--background)), hsl(var(--background)))',
  ].join(','),
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить запрос';
}

/** Dark page shell: glow, back-to-landing link, centered box with logo mark + title. */
function AuthShell({
  title,
  switchLine,
  children,
}: {
  title: string;
  switchLine?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="dark relative flex min-h-screen items-center justify-center px-5 py-16 text-foreground"
      style={GLOW_BG}
    >
      {/* skewed iris glow */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-[12%] right-[-8%] h-[760px] w-[520px] -skew-x-12 blur-[22px]"
        style={{ background: 'radial-gradient(closest-side, hsl(var(--primary) / 0.16), transparent 70%)' }}
      />
      <Link
        to="/"
        className="absolute left-5 top-5 z-10 rounded p-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        ← На главную
      </Link>

      <div className="relative z-[1] w-full max-w-[380px] text-center">
        <div className="mb-4 flex justify-center">
          <span className="flex h-[38px] w-[38px] items-center justify-center rounded-[9px] bg-primary text-xl font-medium text-primary-foreground">
            P
          </span>
        </div>
        <h1 className="mb-1.5 text-[26px] font-medium tracking-tight">{title}</h1>
        {switchLine && <p className="mb-6 text-sm text-muted-foreground">{switchLine}</p>}
        {children}
      </div>
    </div>
  );
}

/** Google / GitHub placeholders + "или" divider (visual parity with legacy; not wired). */
function OAuthBlock() {
  const [notice, setNotice] = useState('');
  const buttons: Array<{ key: string; label: string; icon: ReactNode }> = [
    {
      key: 'google',
      label: 'Продолжить с Google',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09z" />
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.98.66-2.23 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z" />
          <path fill="#FBBC05" d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84z" />
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z" />
        </svg>
      ),
    },
    {
      key: 'github',
      label: 'Продолжить с GitHub',
      icon: (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 1.3a10.7 10.7 0 0 0-3.38 20.86c.53.1.73-.23.73-.51l-.01-1.8c-2.98.65-3.6-1.44-3.6-1.44-.49-1.24-1.19-1.57-1.19-1.57-.97-.66.07-.65.07-.65 1.08.08 1.64 1.11 1.64 1.11.96 1.64 2.52 1.16 3.13.89.1-.7.37-1.16.68-1.43-2.38-.27-4.88-1.19-4.88-5.3 0-1.17.42-2.13 1.11-2.88-.11-.27-.48-1.36.11-2.84 0 0 .9-.29 2.96 1.1a10.3 10.3 0 0 1 5.4 0c2.05-1.39 2.95-1.1 2.95-1.1.59 1.48.22 2.57.11 2.84.69.75 1.1 1.71 1.1 2.88 0 4.12-2.5 5.03-4.89 5.29.38.33.72.98.72 1.98l-.01 2.93c0 .29.2.62.74.51A10.7 10.7 0 0 0 12 1.3z" />
        </svg>
      ),
    },
  ];
  return (
    <div className="text-left">
      <div className="flex flex-col gap-2.5">
        {buttons.map((b) => (
          <button
            key={b.key}
            type="button"
            onClick={() => setNotice(`Вход через ${b.key === 'google' ? 'Google' : 'GitHub'} скоро будет`)}
            className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-white/15 bg-white/[0.04] px-3.5 py-2.5 text-sm font-medium text-foreground transition-colors hover:border-white/25 hover:bg-white/[0.08]"
          >
            {b.icon}
            {b.label}
          </button>
        ))}
      </div>
      {notice && <p className="mt-2 text-center text-xs text-muted-foreground">{notice}</p>}
      <div className="my-4 flex items-center gap-3 text-[13px] text-muted-foreground">
        <span className="h-px flex-1 bg-white/10" />
        или
        <span className="h-px flex-1 bg-white/10" />
      </div>
    </div>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const loginMutation = useLogin();
  const forgotMutation = useForgot();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [forgotMode, setForgotMode] = useState(false);

  const handleLogin = (event: FormEvent) => {
    event.preventDefault();
    loginMutation.mutate(
      { email: email.trim(), password },
      { onSuccess: () => navigate('/', { replace: true }) },
    );
  };

  const handleForgot = (event: FormEvent) => {
    event.preventDefault();
    forgotMutation.mutate({ email: email.trim() });
  };

  if (forgotMode) {
    return (
      <AuthShell
        title="Сброс пароля"
        switchLine={
          <button
            type="button"
            className={LINK_CLASS}
            onClick={() => {
              forgotMutation.reset();
              setForgotMode(false);
            }}
          >
            ← Назад ко входу
          </button>
        }
      >
        <form onSubmit={handleForgot} className="text-left">
          <label className={LABEL_CLASS} htmlFor="forgot-email">
            Email для сброса пароля
          </label>
          <input
            id="forgot-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            required
            disabled={forgotMutation.isPending}
            className={INPUT_CLASS}
          />
          <button type="submit" disabled={forgotMutation.isPending} className={BUTTON_CLASS}>
            {forgotMutation.isPending ? 'Отправка…' : 'Отправить ссылку'}
          </button>
          {forgotMutation.isError && (
            <p className="mt-3 text-sm text-destructive">{errorMessage(forgotMutation.error)}</p>
          )}
          {forgotMutation.isSuccess && (
            <p className="mt-3 text-sm text-muted-foreground">
              {forgotMutation.data.message || 'Если такой аккаунт есть — ссылка отправлена.'}
            </p>
          )}
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="С возвращением"
      switchLine={
        <>
          Нет аккаунта?{' '}
          <Link to="/register" className={LINK_CLASS}>
            Создать
          </Link>
        </>
      }
    >
      <OAuthBlock />
      <form onSubmit={handleLogin} className="text-left">
        <label className={LABEL_CLASS} htmlFor="login-email">
          Email
        </label>
        <input
          id="login-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          autoComplete="username"
          disabled={loginMutation.isPending}
          className={INPUT_CLASS}
        />
        <label className={`${LABEL_CLASS} mt-3`} htmlFor="login-password">
          Пароль
        </label>
        <input
          id="login-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
          disabled={loginMutation.isPending}
          className={INPUT_CLASS}
        />
        <button type="submit" disabled={loginMutation.isPending} className={BUTTON_CLASS}>
          {loginMutation.isPending ? 'Вход…' : 'Войти'}
        </button>
        {loginMutation.isError && (
          <p className="mt-3 text-sm text-destructive">{errorMessage(loginMutation.error)}</p>
        )}
        <p className="mt-3.5 text-sm text-muted-foreground">
          <button
            type="button"
            className="cursor-pointer text-primary hover:underline"
            onClick={() => {
              loginMutation.reset();
              setForgotMode(true);
            }}
          >
            Забыли пароль?
          </button>{' '}
          · оставь email пустым для входа по командному паролю
        </p>
      </form>
    </AuthShell>
  );
}

export function RegisterPage() {
  const registerMutation = useRegister();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    registerMutation.mutate({ email: email.trim(), password });
  };

  return (
    <AuthShell
      title="Создать аккаунт Pulse"
      switchLine={
        <>
          Уже есть аккаунт?{' '}
          <Link to="/login" className={LINK_CLASS}>
            Войти
          </Link>
        </>
      }
    >
      <OAuthBlock />
      <form onSubmit={handleSubmit} className="text-left">
        <label className={LABEL_CLASS} htmlFor="reg-email">
          Email
        </label>
        <input
          id="reg-email"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          autoComplete="username"
          required
          disabled={registerMutation.isPending}
          className={INPUT_CLASS}
        />
        <label className={`${LABEL_CLASS} mt-3`} htmlFor="reg-password">
          Пароль (мин. 8 символов)
        </label>
        <input
          id="reg-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="••••••••"
          minLength={8}
          autoComplete="new-password"
          required
          disabled={registerMutation.isPending}
          className={INPUT_CLASS}
        />
        <button type="submit" disabled={registerMutation.isPending} className={BUTTON_CLASS}>
          {registerMutation.isPending ? 'Регистрация…' : 'Создать аккаунт'}
        </button>
        {registerMutation.isError && (
          <p className="mt-3 text-sm text-destructive">{errorMessage(registerMutation.error)}</p>
        )}
        {registerMutation.isSuccess ? (
          <p className="mt-3 text-sm text-muted-foreground">
            {registerMutation.data.message || 'Проверьте почту для подтверждения аккаунта.'}
          </p>
        ) : (
          <p className="mt-3.5 text-xs leading-relaxed text-muted-foreground">
            На указанный email придёт ссылка для подтверждения.
          </p>
        )}
      </form>
    </AuthShell>
  );
}

export function VerifyPage() {
  const [searchParams] = useSearchParams();
  const verifyMutation = useVerify();
  const token = searchParams.get('token') ?? '';

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (token) verifyMutation.mutate({ token });
  };

  return (
    <AuthShell title="Подтверждение email">
      <form onSubmit={handleSubmit} className="text-left">
        <p className="text-sm text-muted-foreground">
          {token ? 'Активируй аккаунт в Pulse Analytics.' : 'В ссылке отсутствует токен подтверждения.'}
        </p>
        {token && !verifyMutation.isSuccess && (
          <button type="submit" disabled={verifyMutation.isPending} className={BUTTON_CLASS}>
            {verifyMutation.isPending ? 'Подтверждение…' : 'Подтвердить email'}
          </button>
        )}
        {verifyMutation.isError && (
          <p className="mt-3 text-sm text-destructive">{errorMessage(verifyMutation.error)}</p>
        )}
        {verifyMutation.isSuccess && (
          <p className="mt-3 text-sm text-muted-foreground">Email подтверждён.</p>
        )}
        <p className="mt-4 text-sm">
          <Link to="/login" className="text-primary hover:underline">
            Перейти ко входу
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}

export function ResetPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const resetMutation = useReset();
  const token = searchParams.get('token') ?? '';
  const [password, setPassword] = useState('');

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!token) return;
    resetMutation.mutate(
      { token, password },
      { onSuccess: () => navigate('/login', { replace: true }) },
    );
  };

  return (
    <AuthShell title="Новый пароль">
      <form onSubmit={handleSubmit} className="text-left">
        {!token && <p className="mb-2 text-sm text-destructive">В ссылке отсутствует токен сброса.</p>}
        <label className={LABEL_CLASS} htmlFor="reset-password">
          Новый пароль (мин. 8 символов)
        </label>
        <input
          id="reset-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="••••••••"
          minLength={8}
          required
          disabled={!token || resetMutation.isPending}
          className={INPUT_CLASS}
        />
        <button type="submit" disabled={!token || resetMutation.isPending} className={BUTTON_CLASS}>
          {resetMutation.isPending ? 'Сохранение…' : 'Сохранить пароль'}
        </button>
        {resetMutation.isError && (
          <p className="mt-3 text-sm text-destructive">{errorMessage(resetMutation.error)}</p>
        )}
        <p className="mt-4 text-sm">
          <Link to="/login" className="text-primary hover:underline">
            Вернуться ко входу
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
