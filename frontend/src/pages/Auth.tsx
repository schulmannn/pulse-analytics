import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForgot, useLogin, useRegister, useReset, useVerify } from '@/api/queries';
import { PulseMark } from '@/components/PulseMark';

// "Pulse Refined Technical" auth — light, quiet, calmer than the dashboard. Warm paper canvas,
// hairline-bordered fields, pill primary button, one calm blue accent. Semantic/brand tokens only.

const INPUT_CLASS =
  'w-full rounded-[4px] border border-border bg-card px-3.5 py-2.5 text-sm text-foreground placeholder:text-ink3 focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50';
const BUTTON_CLASS =
  'btn-pill mt-5 w-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50';
const LABEL_CLASS = 'mb-1.5 block text-[13px] font-medium text-ink2';
const LINK_CLASS = 'cursor-pointer font-medium text-primary hover:underline';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить запрос';
}

/** Light page shell: brand top-left, a centered, left-aligned form column (quieter than the app). */
function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-background px-5 py-16 text-foreground">
      <Link to="/" className="absolute left-6 top-6 flex items-center gap-2.5">
        <PulseMark className="h-[18px] w-[18px] text-primary" />
        <span className="text-[17px] font-medium tracking-tight text-foreground">Pulse</span>
      </Link>

      <div className="w-full max-w-[380px]">
        <h1 className="text-[24px] font-medium tracking-tight text-foreground">{title}</h1>
        {subtitle && <p className="mt-2 text-sm leading-relaxed text-ink2">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

function TrustIcon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0 text-ink2" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** Register trust block — what we don't do with the user's data. */
function Trust() {
  const items = [
    { d: 'M5 11h14v9H5z M8 11V8a4 4 0 0 1 8 0v3', text: 'Telegram-сессия не хранится в Pulse' },
    { d: 'M4 5h16v11H4z M2 20h20', text: 'Collector работает локально' },
    { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0', text: 'Instagram можно открыть в демо-режиме' },
  ];
  return (
    <div className="mt-6 space-y-3 border-t border-border pt-5">
      {items.map((it) => (
        <div key={it.text} className="flex items-center gap-2.5 text-[13px] text-ink2">
          <TrustIcon d={it.d} />
          {it.text}
        </div>
      ))}
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
      <AuthShell title="Сброс пароля">
        <form onSubmit={handleForgot}>
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
            <p className="mt-3 text-sm text-ink2">
              {forgotMutation.data.message || 'Если такой аккаунт есть — ссылка отправлена.'}
            </p>
          )}
          <div className="mt-5 border-t border-border pt-5 text-sm text-ink2">
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
          </div>
        </form>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Войти в Pulse">
      <form onSubmit={handleLogin}>
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
        <label className={`${LABEL_CLASS} mt-4`} htmlFor="login-password">
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
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            className="cursor-pointer text-[13px] text-primary hover:underline"
            onClick={() => {
              loginMutation.reset();
              setForgotMode(true);
            }}
          >
            Забыли пароль?
          </button>
        </div>
        <div className="mt-5 border-t border-border pt-5 text-sm text-ink2">
          Нет аккаунта?{' '}
          <Link to="/register" className={LINK_CLASS}>
            Создать
          </Link>
        </div>
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
      subtitle="Подключите канал и получите обзор просмотров, постов и состояния сбора."
    >
      <form onSubmit={handleSubmit}>
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
        <label className={`${LABEL_CLASS} mt-4`} htmlFor="reg-password">
          Пароль
        </label>
        <input
          id="reg-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="минимум 8 символов"
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
        {registerMutation.isSuccess && (
          <p className="mt-3 text-sm text-ink2">
            {registerMutation.data.message || 'Проверьте почту для подтверждения аккаунта.'}
          </p>
        )}
        <div className="mt-6 text-sm text-ink2">
          Уже есть аккаунт?{' '}
          <Link to="/login" className={LINK_CLASS}>
            Войти
          </Link>
        </div>
      </form>
      <Trust />
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
      <form onSubmit={handleSubmit}>
        <p className="text-sm text-ink2">
          {token ? 'Активируй аккаунт в Pulse.' : 'В ссылке отсутствует токен подтверждения.'}
        </p>
        {token && !verifyMutation.isSuccess && (
          <button type="submit" disabled={verifyMutation.isPending} className={BUTTON_CLASS}>
            {verifyMutation.isPending ? 'Подтверждение…' : 'Подтвердить email'}
          </button>
        )}
        {verifyMutation.isError && (
          <p className="mt-3 text-sm text-destructive">{errorMessage(verifyMutation.error)}</p>
        )}
        {verifyMutation.isSuccess && <p className="mt-3 text-sm text-ink2">Email подтверждён.</p>}
        <div className="mt-5 border-t border-border pt-5 text-sm">
          <Link to="/login" className={LINK_CLASS}>
            Перейти ко входу
          </Link>
        </div>
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
      <form onSubmit={handleSubmit}>
        {!token && <p className="mb-2 text-sm text-destructive">В ссылке отсутствует токен сброса.</p>}
        <label className={LABEL_CLASS} htmlFor="reset-password">
          Новый пароль
        </label>
        <input
          id="reset-password"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="минимум 8 символов"
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
        <div className="mt-5 border-t border-border pt-5 text-sm">
          <Link to="/login" className={LINK_CLASS}>
            Вернуться ко входу
          </Link>
        </div>
      </form>
    </AuthShell>
  );
}
