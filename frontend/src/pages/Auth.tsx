import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForgot, useLogin, useRegister, useReset, useVerify } from '@/api/queries';

// Resend-style dark auth view (wrapped in `.dark` so dark tokens apply regardless of app theme).
// Semantic/brand tokens only — no hex.

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
            className="cursor-pointer text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
            onClick={() => {
              loginMutation.reset();
              setForgotMode(true);
            }}
          >
            Забыли пароль?
          </button>
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
          <Link to="/login" className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">
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
          <Link to="/login" className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary">
            Вернуться ко входу
          </Link>
        </p>
      </form>
    </AuthShell>
  );
}
