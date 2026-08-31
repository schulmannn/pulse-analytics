import { Suspense, lazy, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Me } from '@/api/schemas';
import { ME_QUERY_KEY } from '@/api/authQueryKey';
import {
  DEMO_MODE_CHANGE_EVENT,
  enableDemoMode,
  isDemoMode,
} from '@/lib/demo';
import { lazyWithReload } from '@/lib/lazyWithReload';
import { useForcedTheme } from '@/lib/forcedTheme';

const ProtectedApp = lazy(lazyWithReload(() => import('@/ProtectedApp')));
const Landing = lazy(
  lazyWithReload(() =>
    import('@/pages/Landing').then((module) => ({ default: module.Landing })),
  ),
);

export const AUTH_PROBE_TIMEOUT_MS = 5_000;

export class AuthProbeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AuthProbeError';
  }
}

type ProbeState =
  | { status: 'pending' }
  | { status: 'success'; me: Me }
  | { status: 'error'; error: AuthProbeError };

export const DEMO_ME: Me = {
  uid: 0,
  email: 'demo@atlavue.local',
  role: 'user',
  avatar: null,
  ai: { enabled: false },
};

/** Pure/exported so the no-auth demo bootstrap stays covered without mounting the route graph. */
export function authGateInitialState(): ProbeState {
  return isDemoMode()
    ? { status: 'success', me: DEMO_ME }
    : { status: 'pending' };
}

/** Offline/timeout is an indeterminate public boot, so keep demo reachable; a real 5xx stays error. */
export function shouldRenderLandingForProbeError(status: number): boolean {
  return status === 0 || status === 401;
}

function humanMessage(status: number): string {
  if (status === 401) return 'Сессия истекла — войдите заново';
  if (status === 403) return 'Нет доступа к этому разделу';
  if (status >= 500) return 'Сервер временно недоступен — попробуйте позже';
  return `Не удалось выполнить запрос (код ${status})`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Minimal strict shape guard for the only response needed before the protected API graph exists. */
export function parseMe(value: unknown): Me {
  if (!record(value)) throw new AuthProbeError(0, 'Формат данных не совпадает с ожидаемым');
  if (
    typeof value.uid !== 'number' ||
    !Number.isFinite(value.uid) ||
    !Number.isInteger(value.uid)
  ) {
    throw new AuthProbeError(0, 'Формат данных не совпадает с ожидаемым');
  }
  if (typeof value.email !== 'string' || value.email.trim() === '') {
    throw new AuthProbeError(0, 'Формат данных не совпадает с ожидаемым');
  }
  if (typeof value.role !== 'string') {
    throw new AuthProbeError(0, 'Формат данных не совпадает с ожидаемым');
  }
  if (value.avatar !== null && typeof value.avatar !== 'string') {
    throw new AuthProbeError(0, 'Формат данных не совпадает с ожидаемым');
  }
  if (
    value.ai !== undefined &&
    (!record(value.ai) ||
      (value.ai.enabled !== undefined && typeof value.ai.enabled !== 'boolean'))
  ) {
    throw new AuthProbeError(0, 'Формат данных не совпадает с ожидаемым');
  }
  if (value.rusender_surfaces !== undefined && typeof value.rusender_surfaces !== 'boolean') {
    throw new AuthProbeError(0, 'Формат данных не совпадает с ожидаемым');
  }
  // ПРОЕКЦИЯ, А НЕ PASSTHROUGH: этот объект сеет кэш useMe (setQueryData ниже), поэтому поле,
  // не перечисленное здесь, теряется на бутстрапе и «появляется» только после рефетча. Новый
  // гейт-флаг обязан попасть и сюда, иначе раздел мигал бы при первой загрузке.
  return {
    uid: value.uid,
    email: value.email,
    role: value.role,
    avatar: value.avatar,
    ai: value.ai as Me['ai'],
    rusender_surfaces: value.rusender_surfaces as Me['rusender_surfaces'],
  };
}

export async function probeMe(
  signal: AbortSignal,
  request: typeof fetch = fetch,
  timeoutMs = AUTH_PROBE_TIMEOUT_MS,
): Promise<Me> {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();
  if (signal.aborted) abortFromParent();
  else signal.addEventListener('abort', abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await request('/api/auth/me', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      let message = humanMessage(response.status);
      try {
        const body: unknown = await response.json();
        if (
          record(body) &&
          typeof body.error === 'string' &&
          /[А-Яа-яЁё ]/.test(body.error)
        ) {
          message = body.error;
        }
      } catch {
        // Keep the status-based human fallback for a proxy/non-JSON response.
      }
      throw new AuthProbeError(response.status, message);
    }
    const data: unknown = await response.json().catch(() => null);
    return parseMe(data);
  } catch (error) {
    if (error instanceof AuthProbeError) throw error;
    if (signal.aborted && !timedOut) {
      throw new DOMException('Auth probe cancelled', 'AbortError');
    }
    if (timedOut) {
      throw new AuthProbeError(
        0,
        'Сервер не ответил вовремя — можно открыть демо или попробовать позже',
      );
    }
    throw new AuthProbeError(
      0,
      'Нет соединения с сервером — можно открыть демо или попробовать позже',
    );
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', abortFromParent);
  }
}

/**
 * Sole bridge between the public and protected route graphs. ProtectedApp's import starts only
 * after a validated probe succeeds; the result seeds TanStack's canonical `['me']` cache so hooks
 * inside the protected graph do not issue a duplicate request.
 */
export function AuthGate() {
  const queryClient = useQueryClient();
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<ProbeState>(authGateInitialState);

  useEffect(() => {
    if (isDemoMode()) {
      queryClient.setQueryData(ME_QUERY_KEY, DEMO_ME);
      setState({ status: 'success', me: DEMO_ME });
      return;
    }

    const controller = new AbortController();
    setState({ status: 'pending' });
    void probeMe(controller.signal).then(
      (me) => {
        queryClient.setQueryData(ME_QUERY_KEY, me);
        setState({ status: 'success', me });
      },
      (error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setState({
          status: 'error',
          error:
            error instanceof AuthProbeError
              ? error
              : new AuthProbeError(0, 'Не удалось загрузить'),
        });
      },
    );
    return () => controller.abort();
  }, [attempt, queryClient]);

  useEffect(() => {
    const handleDemoChange = () => {
      setState(authGateInitialState());
      setAttempt((value) => value + 1);
    };
    window.addEventListener(DEMO_MODE_CHANGE_EVENT, handleDemoChange);
    return () => window.removeEventListener(DEMO_MODE_CHANGE_EVENT, handleDemoChange);
  }, []);

  if (state.status === 'pending') return <GateFallback />;

  if (state.status === 'error') {
    if (shouldRenderLandingForProbeError(state.error.status)) {
      return (
        <Suspense fallback={<LandingFallback />}>
          <Landing onEnterDemo={enableDemoMode} />
        </Suspense>
      );
    }
    return (
      <Centered>
        <div role="alert" className="w-full max-w-sm text-center">
          <p className="text-sm font-medium text-foreground">Не удалось загрузить</p>
          <p className="mt-1 text-sm text-muted-foreground">{state.error.message}</p>
          <button
            type="button"
            onClick={() => setAttempt((value) => value + 1)}
            className="btn-pill mt-4 bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            Повторить
          </button>
        </div>
      </Centered>
    );
  }

  return (
    <Suspense fallback={<GateFallback />}>
      <ProtectedApp me={state.me} />
    </Suspense>
  );
}

function Pulse({ className }: { className: string }) {
  return <div className={`animate-pulse rounded bg-muted motion-reduce:animate-none ${className}`} />;
}

function GateFallback() {
  return (
    <Centered>
      <div className="w-full max-w-sm space-y-3">
        <Pulse className="h-5 w-1/3" />
        <Pulse className="h-10 w-full" />
        <Pulse className="h-10 w-full" />
      </div>
    </Centered>
  );
}

/** Скелетон ленивого чанка лендинга: повторяет его раскладку (пилюля-топбар + центрированная
    колонка) и так же пришпиливает тёмную тему, иначе до приезда чанка страница моргает светлым
    и потом дёргается. */
function LandingFallback() {
  useForcedTheme('dark');
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <div className="px-4 py-3">
        <Pulse className="mx-auto h-[52px] w-[220px] rounded-full" />
      </div>
      <div className="flex flex-1 items-center justify-center py-20 sm:py-28">
        <div className="flex w-full max-w-[620px] flex-col items-center space-y-4 px-6">
          <Pulse className="h-12 w-full" />
          <Pulse className="h-12 w-4/5" />
          <Pulse className="h-4 w-2/3" />
          <div className="flex gap-3 pt-5">
            <Pulse className="h-11 w-32 rounded-full" />
            <Pulse className="h-11 w-40 rounded-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      {children}
    </div>
  );
}
