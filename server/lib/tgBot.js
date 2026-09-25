'use strict';

/* ── Telegram Bot API клиент для личных уведомлений ───────────────────────────────────────────────
   Тонкая обёртка над api.telegram.org для доставки упоминаний в личку. Использует ТОТ ЖЕ
   TG_BOT_TOKEN, что и статистика канала в routes/tg.js (getChat/getChatMemberCount) — бот один.
   Никакой очереди: объёмы — единицы сообщений в день на пользователя; отправка последовательная
   в джобе. 403 (пользователь заблокировал бота / чат удалён) — НЕ ошибка транспорта, а сигнал
   отвязки: возвращаем { blocked: true }, отвязку решает вызывающий. 429 (флуд-контроль,
   parameters.retry_after) — тоже НЕ перманентная ошибка: { throttled: true, retryAfterSec }, и
   вызывающий сам решает, что делать с остатком пачки. Токен бота один на весь продукт, поэтому
   отличать «притормози» от «сломано» обязательно: на глухом throw джоб ронял весь прогон и
   следующий свип переотправлял уже доставленные карточки.

   Токен НИКОГДА не логируется; в сообщениях об ошибках только method + код Телеграма. */

const DEFAULT_TIMEOUT_MS = 12000;
// Потолок доверия к retry_after апстрима: дольше часа ждать всё равно нечего (день-ключ джоба
// закроет прогон раньше), а мусорное/огромное значение не должно утекать в Retry-After клиенту.
const MAX_RETRY_AFTER_SEC = 3600;

function createTgBot({ token = '', fetchImpl, log = () => {} } = {}) {
  const BASE = 'https://api.telegram.org/bot';
  let cachedMe = null;          // { username, id } — getMe стабилен на всю жизнь процесса
  let webhookEnsured = false;   // идемпотентный setWebhook: один раз на процесс достаточно

  const configured = () => !!token;

  // parameters.retry_after Телеграма (секунды) → положительное целое в разумных границах либо null
  // («429 без срока» — тоже троттлинг, просто без подсказки, сколько ждать).
  function retryAfterSecOf(json) {
    const raw = json && json.parameters ? json.parameters.retry_after : null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    return Math.min(MAX_RETRY_AFTER_SEC, Math.ceil(n));
  }

  async function call(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!token) {
      const e = new Error('TG_BOT_TOKEN не задан');
      e.code = 'bot_not_configured';
      throw e;
    }
    const res = await fetchImpl(`${BASE}${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    }, timeoutMs);
    const json = await res.json().catch(() => ({}));
    if (!json.ok) {
      const errorCode = json.error_code || res.status;
      const e = new Error(`Bot API ${method}: ${errorCode}`);
      // 429 маркируем отдельным кодом и несём срок ожидания: sendMessage превращает его в
      // структурный { throttled }, а getUsername/ensureWebhook (их вызывающие и так отвечают 503)
      // видят обычную ошибку — семантика тех потоков не меняется.
      e.code = errorCode === 429 ? 'bot_throttled' : 'bot_api_error';
      e.errorCode = errorCode;
      if (errorCode === 429) e.retryAfterSec = retryAfterSecOf(json);
      throw e;
    }
    return json.result;
  }

  // username бота нужен для deep-link t.me/<username>?start=… — кэшируем первый успех.
  async function getUsername() {
    if (cachedMe) return cachedMe.username;
    const me = await call('getMe');
    cachedMe = { username: me.username, id: me.id };
    return cachedMe.username;
  }

  // Идемпотентная регистрация вебхука: зовётся лениво перед выдачей первой deep-link ссылки
  // (к моменту нажатия Start вебхук гарантированно стоит). Повторный setWebhook с теми же
  // параметрами безвреден; flag только экономит сетевые вызовы в рамках процесса.
  async function ensureWebhook(url, secretToken) {
    if (webhookEnsured || !url) return webhookEnsured;
    await call('setWebhook', {
      url,
      secret_token: secretToken,
      allowed_updates: ['message', 'my_chat_member'],
    });
    webhookEnsured = true;
    log('info', 'tg_bot_webhook_set', { url });
    return true;
  }

  // Личное сообщение. HTML-разметка (вызывающий обязан экранировать через tgNotifyText.escapeHtml),
  // превью выключено — карточки компактные. Два НЕ-исключительных исхода, которые вызывающий обязан
  // различать: 403 → { ok:false, blocked:true } (сигнал отвязки), 429 → { ok:false, throttled:true,
  // retryAfterSec } (притормозить, но НЕ считать доставленное недоставленным). Остальное — throw.
  async function sendMessage(chatId, text) {
    try {
      await call('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
      });
      return { ok: true };
    } catch (e) {
      if (e && e.errorCode === 403) return { ok: false, blocked: true };
      if (e && e.code === 'bot_throttled') {
        return { ok: false, throttled: true, retryAfterSec: e.retryAfterSec || null };
      }
      throw e;
    }
  }

  return { configured, getUsername, ensureWebhook, sendMessage };
}

module.exports = { createTgBot };
