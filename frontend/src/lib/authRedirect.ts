import { isDemoMode } from '@/lib/demo';

function hasStatus(error: unknown, status: number): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    (error as { status?: unknown }).status === status
  );
}

/**
 * Публичные роуты, которые САМИ спрашивают сессию и должны пережить ответ «её нет».
 * `/invite` (приглашение в команду) читает `useMe`, чтобы выбрать ветку: принять одним кликом,
 * сказать «вы вошли не тем адресом» или завести аккаунт прямо здесь. Без этого исключения
 * ожидаемый 401 уносил получателя письма на /login — то есть ссылка из письма не работала.
 */
const PUBLIC_PATHS = new Set(['/login', '/invite']);

/**
 * 401 с этими машинными кодами — не конец НАШЕЙ сессии, а отказ СТОРОННЕГО токена источника:
 * data-роуты МойСклада (routes/moysklad.js, sendMsError) и Метрики (routes/metrika.js, sendYmError)
 * так отвечают, когда провайдер перестал принимать уже сохранённый токен. Сессия Atlavue жива, и
 * экран источника сам показывает «Переподключить» (MsOverview/YmOverview). Редирект на /login
 * выдавал отзыв токена за разлогин и прятал эту кнопку — источник становился недоступен совсем.
 * У Instagram та же ситуация отдаётся 409 `ig_reauth` и сюда не доходит. Список явный: 401 без
 * кода (или с любым другим) по-прежнему ведёт на /login.
 */
const SOURCE_TOKEN_CODES = new Set(['ms_token_revoked', 'ym_token_revoked']);

function hasSourceTokenCode(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && SOURCE_TOKEN_CODES.has(code);
}

/** Raw AuthGate owns the public probe, so every TanStack 401 belongs to protected work. */
export function shouldRedirectOnUnauthorized(
  error: unknown,
  pathname: string,
  demoMode: boolean,
): boolean {
  if (!hasStatus(error, 401) || demoMode) return false;
  if (PUBLIC_PATHS.has(pathname)) return false;
  if (hasSourceTokenCode(error)) return false;
  return true;
}

interface BrowserUnauthorizedDeps {
  pathname: string;
  demoMode: boolean;
  assign: (path: string) => void;
}

/**
 * Shared boundary for direct fetches and TanStack caches. Dependency injection keeps the policy
 * unit-testable without jsdom while production callers use the real browser state.
 */
export function redirectBrowserOnUnauthorized(
  error: unknown,
  deps: BrowserUnauthorizedDeps = {
    pathname: window.location.pathname,
    demoMode: isDemoMode(),
    assign: (path) => window.location.assign(path),
  },
): boolean {
  if (!shouldRedirectOnUnauthorized(error, deps.pathname, deps.demoMode)) return false;
  deps.assign('/login');
  return true;
}
