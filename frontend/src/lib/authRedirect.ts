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
 * 401 с кодом источника — не конец НАШЕЙ сессии, а отказ СТОРОННЕГО токена: data-роуты МойСклада
 * (routes/moysklad.js, sendMsError) и Метрики (routes/metrika.js, sendYmError) так отвечают, когда
 * провайдер перестал принимать уже сохранённый токен. Сессия Atlavue жива, и экран источника сам
 * показывает «Переподключить» (он читает api/sourceErrors.sourceErrorKind). Редирект на /login
 * выдавал отзыв токена за разлогин и прятал эту кнопку — источник становился недоступен совсем.
 * У Instagram та же ситуация отдаётся 409 `ig_reauth` и сюда не доходит.
 */
const LEGACY_SOURCE_TOKEN_CODES: ReadonlySet<string> = new Set(['ms_token_revoked', 'ym_token_revoked']);

/**
 * Пространство имён `source_*` зарезервировано под ошибки источников единого sendSourceError
 * (`source_reauth`, `source_unavailable`, `source_not_connected`). Сессию приложения такими кодами
 * сервер не помечает: 401 requireAuth приходит без кода.
 */
const SOURCE_CODE_NAMESPACE = /^source_[a-z0-9]+(?:_[a-z0-9]+)*$/;

/**
 * Allow-list: 401 с таким кодом — отказ источника, а не истёкшая сессия. Совпадение точное:
 * легаси-коды списком, новые — только в snake_case-пространстве `source_`. 401 без кода и с любым
 * другим кодом по-прежнему ведёт на /login.
 */
export function isSourceAccessCode(code: unknown): code is string {
  return typeof code === 'string' && (LEGACY_SOURCE_TOKEN_CODES.has(code) || SOURCE_CODE_NAMESPACE.test(code));
}

function hasSourceAccessCode(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return isSourceAccessCode((error as { code?: unknown }).code);
}

/** Raw AuthGate owns the public probe, so every TanStack 401 belongs to protected work. */
export function shouldRedirectOnUnauthorized(
  error: unknown,
  pathname: string,
  demoMode: boolean,
): boolean {
  if (!hasStatus(error, 401) || demoMode) return false;
  if (PUBLIC_PATHS.has(pathname)) return false;
  if (hasSourceAccessCode(error)) return false;
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
