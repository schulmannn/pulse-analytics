const LEGACY_TOKEN_KEY = 'pulse_token';
const LEGACY_TOKEN_EXP_KEY = 'pulse_token_exp';

/**
 * Чистка ключей до-cookie-транспорта из localStorage.
 *
 * Сам мост (заголовочный токен → одноразовый роут обмена на cookie) снят: критерий удаления —
 * «семь дней после первого деплоя» — наступил в июле, а прожил он до сентября (аудит #554).
 * Осталась одна строка уборки: у пользователя, не заходившего с тех пор, ключи всё ещё лежат в
 * браузере, и оставлять там читаемый из JS токен без всякой пользы незачем.
 *
 * УДАЛИТЬ ПОСЛЕ 2026-12-01: к этому сроку ключи выветрятся у всех, кто заходил хоть раз.
 */
export function purgeLegacySession(): void {
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    localStorage.removeItem(LEGACY_TOKEN_EXP_KEY);
  } catch {
    /* localStorage может быть недоступен */
  }
}
