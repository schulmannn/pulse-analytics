'use strict';

/* ── Чистые хелперы доставки упоминаний (Bot API) ─────────────────────────────────────────────────
   Всё, что можно проверить без сети/БД: экранирование HTML для parse_mode:'HTML', парсинг
   /start-пейлоада вебхука, деривация webhook-секрета из токена бота и сборка текстов сообщений.
   Роут и джоб держат только оркестрацию — форматирование тестируется здесь юнитами. */

const crypto = require('crypto');

// Telegram parse_mode:'HTML' принимает <b>/<i>/<a>; всё пользовательское — только через escape.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

// Секрет вебхука (X-Telegram-Bot-Api-Secret-Token) ДЕРИВИРУЕТСЯ из токена бота: стабилен между
// рестартами, не требует отдельного env, не угадывается без токена. Формат Телеграма: 1-256
// символов [A-Za-z0-9_-] — hex sha256 (64) подходит.
function webhookSecretOf(botToken) {
  if (!botToken) return '';
  return crypto.createHash('sha256').update(`${botToken}:atlavue-webhook`).digest('hex');
}

// «/start <payload>» из сообщения вебхука. Телеграм передаёт payload deep-link'а строкой после
// пробела; формат ссылки ограничен [A-Za-z0-9_-]{1,64}. Возвращает payload или null (не /start,
// пустой или мусорный payload — в т.ч. попытки скормить что-то длинное/со спецсимволами).
function parseStartPayload(text) {
  if (typeof text !== 'string') return null;
  const m = text.trim().match(/^\/start(?:@\w+)?[ \t]+([A-Za-z0-9_-]{8,64})$/);
  return m ? m[1] : null;
}

// Одна карточка упоминания. mention — строка формы /mentions/search (title/username/link/snippet).
// Ссылку даём голым <a> на пост; без превью (see sendMessage disable preview) карточка компактна.
function formatMentionCard(mention) {
  const title = escapeHtml(mention.title || 'канал');
  const uname = mention.username ? ` (@${escapeHtml(mention.username)})` : '';
  const lines = [`🔔 <b>${title}</b>${uname}`];
  if (mention.snippet) lines.push(`«${escapeHtml(mention.snippet)}»`);
  if (mention.link) lines.push(escapeHtml(mention.link));
  return lines.join('\n');
}

// Первый прогон подписки: не выплёвываем весь архив, а шлём одну сводку. foundNow — сколько
// нашёл ТЕКУЩИЙ поиск (не размер архива: после ручных прогонов архив может быть больше).
function formatSeedMessage(channelTitle, foundNow) {
  const title = escapeHtml(channelTitle || 'канал');
  return [
    `✅ Уведомления об упоминаниях включены для «${title}».`,
    `Поиск нашёл ${foundNow} упоминаний — дальше будут приходить только новые.`,
  ].join('\n');
}

// Хвост, когда новых больше, чем влезает карточками за прогон.
function formatOverflowMessage(rest, appUrl) {
  const suffix = appUrl ? `\n${escapeHtml(appUrl)}/mentions` : '';
  return `…и ещё ${rest} новых за прогон — полный список в дашборде.${suffix}`;
}

module.exports = {
  escapeHtml,
  webhookSecretOf,
  parseStartPayload,
  formatMentionCard,
  formatSeedMessage,
  formatOverflowMessage,
};
