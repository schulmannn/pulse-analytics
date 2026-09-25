// ═══════════════════════════════════════════════════════════════
//  Atlavue — состояние long-lived токена Instagram (домен, чистая функция)
// ═══════════════════════════════════════════════════════════════
// Токен «Instagram API with Instagram Login» живёт 60 дней и продлевается в окне 10 дней до
// истечения. До этого модуля срок знал только один потребитель — точка орбиты на /connect: экран
// Instagram, карточки Главной и пилюля источника его не читали, поэтому истёкший токен выглядел
// вечной загрузкой. Одно правило на всех: и статус-роут, и фоновый job считают окно ЗДЕСЬ.
//
// 'none'     — токена нет (аккаунт не подключён или в строке нет срока);
// 'ok'       — до истечения больше окна продления;
// 'expiring' — внутри окна: продление уже должно происходить, состояние ещё рабочее;
// 'expired'  — срок прошёл: любой запрос к Graph вернёт OAuthException, нужен реконнект.

'use strict';

const IG_REFRESH_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;

/** @returns {'none'|'ok'|'expiring'|'expired'} */
function igTokenState(expiresAtStr, now = Date.now()) {
  if (!expiresAtStr) return 'none';
  const exp = new Date(expiresAtStr).getTime();
  if (!Number.isFinite(exp)) return 'none';   // нечитаемая дата — не повод пугать пользователя
  if (exp <= now) return 'expired';
  return exp - now <= IG_REFRESH_WINDOW_MS ? 'expiring' : 'ok';
}

/** Токен пора продлевать: живой, но уже внутри окна. Истёкший продлить нельзя — только реконнект. */
function igTokenDueForRefresh(expiresAtStr, now = Date.now()) {
  return igTokenState(expiresAtStr, now) === 'expiring';
}

module.exports = { igTokenState, igTokenDueForRefresh, IG_REFRESH_WINDOW_MS };
