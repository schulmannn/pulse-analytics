import { useState } from 'react';
import type { FormEvent, InputHTMLAttributes, ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForgot, useLogin, useRegister, useReset, useVerify } from '@/api/queries';
import { AtlavueMark } from '@/components/AtlavueMark';
import { GoogleSignInButton } from '@/components/GoogleSignInButton';
import { cn } from '@/lib/utils';

// "Atlavue Refined Technical" auth — a calm dark card on the near-black canvas: one card-scale
// surface, hairline field shells with a compact leading icon, a full-width pill submit and one calm
// blue accent. Semantic/brand tokens only; borders-only depth (no shadow/glow).

const BUTTON_CLASS =
  'btn-pill mt-5 w-full bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50';
const LABEL_CLASS = 'mb-1.5 block text-sm font-medium text-ink2';
const LINK_CLASS = 'cursor-pointer font-medium text-primary hover:underline';

// Lean stroke-only glyphs (the house icon language) that sit inside a field shell.
const FIELD_ICONS = {
  mail: ['M4 6h16v12H4z', 'm4 7 8 6 8-6'],
  lock: ['M6 11h12v9H6z', 'M9 11V8a3 3 0 0 1 6 0v3'],
} satisfies Record<string, string[]>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить запрос';
}

function FieldIcon({ paths }: { paths: string[] }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0 text-ink3" aria-hidden="true">
      {paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/**
 * One accessible auth field: a label bound to the input plus a hairline shell that lights up on
 * `focus-within` and carries a compact leading icon. The shell owns the border/focus ring so the
 * icon and the input read as one control; all native input props (type, autoComplete, required,
 * disabled, minLength…) pass straight through to the real `<input>` for correct browser behaviour.
 */
function AuthField({
  id,
  label,
  icon,
  className,
  ...inputProps
}: { id: string; label: string; icon: keyof typeof FIELD_ICONS } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={id} className={LABEL_CLASS}>
        {label}
      </label>
      <div className="flex items-center gap-2.5 rounded-lg border border-input bg-background px-3 transition-colors focus-within:border-primary focus-within:ring-1 focus-within:ring-primary">
        <FieldIcon paths={FIELD_ICONS[icon]} />
        <input
          id={id}
          className={cn(
            'w-full bg-transparent py-2.5 text-sm text-foreground placeholder:text-ink3 focus:outline-hidden disabled:opacity-50',
            className,
          )}
          {...inputProps}
        />
      </div>
    </div>
  );
}

/** Dark page shell: near-black canvas, a centered brand mark above one card-scale auth surface. */
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
    <div className="flex min-h-screen items-center justify-center bg-background px-5 py-12 text-foreground">
      <div className="w-full max-w-[400px]">
        <Link to="/" className="mb-6 flex items-center justify-center gap-2.5">
          <AtlavueMark className="h-6 w-6 text-primary" />
          <span className="text-lg font-medium tracking-tight text-foreground">Atlavue</span>
        </Link>
        <div className="rounded-2xl border border-border bg-card p-7 sm:p-8">
          <h1 className="text-2xl font-medium tracking-tight text-foreground">{title}</h1>
          {subtitle && <p className="mt-2 text-sm leading-relaxed text-ink2">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  );
}

function TrustIcon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0 text-ink2" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

/** Register trust block — what we don't do with the user's data. */
function Trust() {
  const items = [
    { d: 'M5 11h14v9H5z M8 11V8a4 4 0 0 1 8 0v3', text: 'Telegram-сессия не хранится в Atlavue' },
    { d: 'M4 5h16v11H4z M2 20h20', text: 'Collector работает локально' },
    { d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0', text: 'Instagram можно открыть в демо-режиме' },
  ];
  return (
    <div className="mt-6 space-y-3 border-t border-border pt-5">
      {items.map((it) => (
        <div key={it.text} className="flex items-center gap-2.5 text-sm text-ink2">
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
          <AuthField
            id="forgot-email"
            label="Email для сброса пароля"
            icon="mail"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            required
            disabled={forgotMutation.isPending}
          />
          <button type="submit" disabled={forgotMutation.isPending} className={BUTTON_CLASS}>
            {forgotMutation.isPending ? 'Отправка…' : 'Отправить ссылку'}
          </button>
          {forgotMutation.isError && (
            <p role="alert" className="mt-3 text-sm text-destructive">{errorMessage(forgotMutation.error)}</p>
          )}
          <div aria-live="polite">
            {forgotMutation.isSuccess && (
              <p className="mt-3 text-sm text-ink2">
                {forgotMutation.data.message || 'Если такой аккаунт есть — ссылка отправлена.'}
              </p>
            )}
          </div>
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
    <AuthShell title="Войти в Atlavue">
      <form onSubmit={handleLogin}>
        <AuthField
          id="login-email"
          label="Email"
          icon="mail"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          autoComplete="username"
          required
          disabled={loginMutation.isPending}
        />
        <div className="mt-4">
          <AuthField
            id="login-password"
            label="Пароль"
            icon="lock"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            disabled={loginMutation.isPending}
          />
        </div>
        <button type="submit" disabled={loginMutation.isPending} className={BUTTON_CLASS}>
          {loginMutation.isPending ? 'Вход…' : 'Войти'}
        </button>
        {loginMutation.isError && (
          <p role="alert" className="mt-3 text-sm text-destructive">{errorMessage(loginMutation.error)}</p>
        )}
        <GoogleSignInButton text="continue_with" />
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            className="cursor-pointer text-sm text-primary hover:underline"
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
      title="Создать аккаунт Atlavue"
      subtitle="Подключите канал и получите обзор просмотров, постов и состояния сбора."
    >
      <form onSubmit={handleSubmit}>
        <AuthField
          id="reg-email"
          label="Email"
          icon="mail"
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="you@example.com"
          autoComplete="username"
          required
          disabled={registerMutation.isPending}
        />
        <div className="mt-4">
          <AuthField
            id="reg-password"
            label="Пароль"
            icon="lock"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="минимум 8 символов"
            minLength={8}
            autoComplete="new-password"
            required
            disabled={registerMutation.isPending}
          />
        </div>
        <button type="submit" disabled={registerMutation.isPending} className={BUTTON_CLASS}>
          {registerMutation.isPending ? 'Регистрация…' : 'Создать аккаунт'}
        </button>
        {registerMutation.isError && (
          <p role="alert" className="mt-3 text-sm text-destructive">{errorMessage(registerMutation.error)}</p>
        )}
        <div aria-live="polite">
          {registerMutation.isSuccess && (
            <p className="mt-3 text-sm text-ink2">
              {registerMutation.data.message || 'Проверьте почту для подтверждения аккаунта.'}
            </p>
          )}
        </div>
        <GoogleSignInButton text="signup_with" />
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
          {token ? 'Подтвердите аккаунт — нажмите кнопку ниже.' : 'Ссылка неполная — откройте её из письма целиком или запросите новое письмо при входе.'}
        </p>
        {token && !verifyMutation.isSuccess && (
          <button type="submit" disabled={verifyMutation.isPending} className={BUTTON_CLASS}>
            {verifyMutation.isPending ? 'Подтверждение…' : 'Подтвердить email'}
          </button>
        )}
        {verifyMutation.isError && (
          <p role="alert" className="mt-3 text-sm text-destructive">{errorMessage(verifyMutation.error)}</p>
        )}
        <div aria-live="polite">
          {verifyMutation.isSuccess && <p className="mt-3 text-sm text-ink2">Email подтверждён.</p>}
        </div>
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
        {!token && <p className="mb-2 text-sm text-destructive">Ссылка неполная — откройте её из письма целиком или запросите новую через «Забыли пароль?».</p>}
        <AuthField
          id="reset-password"
          label="Новый пароль"
          icon="lock"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="минимум 8 символов"
          minLength={8}
          required
          disabled={!token || resetMutation.isPending}
        />
        <button type="submit" disabled={!token || resetMutation.isPending} className={BUTTON_CLASS}>
          {resetMutation.isPending ? 'Сохранение…' : 'Сохранить пароль'}
        </button>
        {resetMutation.isError && (
          <p role="alert" className="mt-3 text-sm text-destructive">{errorMessage(resetMutation.error)}</p>
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
