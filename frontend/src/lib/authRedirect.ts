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
 *
 * Allow-list — точные коды, не пространство имён: легаси-формы отзыва плюс `source_reauth` единого
 * sendSourceError (он отдаёт отзыв 409 и сюда доходить не должен, код в списке — страховка на
 * переход). Каждый код списка sourceErrorKind узнаёт как 'reauth' (тест в api/sourceErrors.test):
 * иначе такой 401 уже не уводил бы на /login, но и «Переподключить» не давал — остался бы «Повторить»,
 * который вернёт тот же отказ. Прочие `source_*` (недоступность, «не подключён») с 401 не приходят —
 * сервер 401 для ошибок источника не отдаёт; если придут, это прежний выход на /login, а не молча
 * проглоченный отказ. Новый код добавляется сюда и в словарь sourceErrorKind.
 */
export const SOURCE_ACCESS_CODES: ReadonlySet<string> = new Set(['ms_token_revoked', 'ym_token_revoked', 'source_reauth']);

/** 401 с таким кодом — отказ источника, а не истёкшая сессия. 401 без кода и с любым другим кодом по-прежнему ведёт на /login. */
export function isSourceAccessCode(code: unknown): code is string {
  return typeof code === 'string' && SOURCE_ACCESS_CODES.has(code);
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
