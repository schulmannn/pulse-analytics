import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useForgot, useLogin, useRegister, useReset, useVerify } from '@/api/queries';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const INPUT_CLASS =
  'w-full rounded-md border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50';
const BUTTON_CLASS =
  'w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Не удалось выполнить запрос';
}

function AuthPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      {/* <!-- DESIGN: Claude review --> */}
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
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
      <AuthPage title="Сброс пароля">
        <form onSubmit={handleForgot} className="space-y-4">
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="Email"
            required
            disabled={forgotMutation.isPending}
            className={INPUT_CLASS}
          />
          <button type="submit" disabled={forgotMutation.isPending} className={BUTTON_CLASS}>
            {forgotMutation.isPending ? 'Отправка…' : 'Отправить ссылку'}
          </button>
          {forgotMutation.isError && (
            <p className="text-sm text-destructive">{errorMessage(forgotMutation.error)}</p>
          )}
          {forgotMutation.isSuccess && (
            <p className="text-sm text-muted-foreground">
              {forgotMutation.data.message || 'Если такой аккаунт есть — ссылка отправлена.'}
            </p>
          )}
          <button
            type="button"
            onClick={() => {
              forgotMutation.reset();
              setForgotMode(false);
            }}
            className="text-sm font-medium text-primary hover:underline"
          >
            ← Назад ко входу
          </button>
        </form>
      </AuthPage>
    );
  }

  return (
    <AuthPage title="Вход">
      <form onSubmit={handleLogin} className="space-y-4">
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="Email (необязательно для командного входа)"
          disabled={loginMutation.isPending}
          className={INPUT_CLASS}
        />
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Пароль"
          required
          disabled={loginMutation.isPending}
          className={INPUT_CLASS}
        />
        <button type="submit" disabled={loginMutation.isPending} className={BUTTON_CLASS}>
          {loginMutation.isPending ? 'Вход…' : 'Войти'}
        </button>
        {loginMutation.isError && <p className="text-sm text-destructive">{errorMessage(loginMutation.error)}</p>}
        <div className="flex justify-between gap-4 text-sm">
          <button
            type="button"
            onClick={() => {
              loginMutation.reset();
              setForgotMode(true);
            }}
            className="text-primary hover:underline"
          >
            Забыли пароль?
          </button>
          <Link to="/register" className="text-primary hover:underline">
            Регистрация
          </Link>
        </div>
      </form>
    </AuthPage>
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
    <AuthPage title="Регистрация">
      <form onSubmit={handleSubmit} className="space-y-4">
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="Email"
          required
          disabled={registerMutation.isPending}
          className={INPUT_CLASS}
        />
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Пароль (минимум 8 символов)"
          minLength={8}
          required
          disabled={registerMutation.isPending}
          className={INPUT_CLASS}
        />
        <button type="submit" disabled={registerMutation.isPending} className={BUTTON_CLASS}>
          {registerMutation.isPending ? 'Регистрация…' : 'Зарегистрироваться'}
        </button>
        {registerMutation.isError && (
          <p className="text-sm text-destructive">{errorMessage(registerMutation.error)}</p>
        )}
        {registerMutation.isSuccess && (
          <p className="text-sm text-muted-foreground">
            {registerMutation.data.message || 'Проверьте почту для подтверждения аккаунта.'}
          </p>
        )}
        <Link to="/login" className="inline-block text-sm text-primary hover:underline">
          Уже есть аккаунт? Войти
        </Link>
      </form>
    </AuthPage>
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
    <AuthPage title="Подтверждение email">
      <form onSubmit={handleSubmit} className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {token ? 'Подтвердите активацию аккаунта.' : 'В ссылке отсутствует токен подтверждения.'}
        </p>
        {token && !verifyMutation.isSuccess && (
          <button type="submit" disabled={verifyMutation.isPending} className={BUTTON_CLASS}>
            {verifyMutation.isPending ? 'Подтверждение…' : 'Подтвердить email'}
          </button>
        )}
        {verifyMutation.isError && <p className="text-sm text-destructive">{errorMessage(verifyMutation.error)}</p>}
        {verifyMutation.isSuccess && <p className="text-sm text-muted-foreground">Email подтверждён.</p>}
        <Link to="/login" className="inline-block text-sm text-primary hover:underline">
          Перейти ко входу
        </Link>
      </form>
    </AuthPage>
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
    <AuthPage title="Новый пароль">
      <form onSubmit={handleSubmit} className="space-y-4">
        {!token && <p className="text-sm text-destructive">В ссылке отсутствует токен сброса.</p>}
        <input
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          placeholder="Новый пароль (минимум 8 символов)"
          minLength={8}
          required
          disabled={!token || resetMutation.isPending}
          className={INPUT_CLASS}
        />
        <button type="submit" disabled={!token || resetMutation.isPending} className={BUTTON_CLASS}>
          {resetMutation.isPending ? 'Сохранение…' : 'Сохранить пароль'}
        </button>
        {resetMutation.isError && <p className="text-sm text-destructive">{errorMessage(resetMutation.error)}</p>}
        <Link to="/login" className="inline-block text-sm text-primary hover:underline">
          Вернуться ко входу
        </Link>
      </form>
    </AuthPage>
  );
}
