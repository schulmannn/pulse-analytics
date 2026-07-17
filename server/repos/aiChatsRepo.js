'use strict';

/* ── AI chats repo (личные диалоги с AI-ассистентом, 028_ai_chats.sql) ────────────────────────────
   Скоуп — ПОЛЬЗОВАТЕЛЬ: каждый метод принимает uid и вшивает user_id = uid в WHERE, поэтому
   чужой chatId неотличим от несуществующего (роут → 404 без утечки). Аналитика попадает в диалог
   НЕ отсюда — только через ForActor-инструменты aiChatService с ownership-чеком на каждый вызов.

   Конвенции репо: guard'ы при !enabled (список → [], одиночка → null, запись → null/false),
   to_char ISO-таймстампы как в campaignsRepo, BIGINT-счётчики usage приводятся к number.

   ai_usage_daily — дневной quota-гейт: день считается в UTC (Railway живёт в UTC; локальная
   таймзона дев-машины не должна менять момент сброса лимита). */

const AI_CHAT_TITLE_MAX = 80;
const AI_CHAT_LIST_LIMIT = 20;
const AI_CHAT_MESSAGES_LIMIT = 200;
const UTC_TODAY = `(now() AT TIME ZONE 'utc')::date`;

function createAiChatsRepo({ pool, enabled }) {
  const ISO = `'YYYY-MM-DD"T"HH24:MI:SSOF'`;
  const CHAT_COLS = `c.id, c.title,
    to_char(c.created_at,${ISO}) AS created_at,
    to_char(c.updated_at,${ISO}) AS updated_at`;
  const MSG_COLS = `m.id, m.chat_id, m.role, m.content, m.tool_trace, m.model,
    m.input_tokens, m.output_tokens, m.error,
    to_char(m.created_at,${ISO}) AS created_at`;

  async function listAiChats(uid, limit = AI_CHAT_LIST_LIMIT) {
    if (!enabled || uid == null) return [];
    const safeLimit = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || AI_CHAT_LIST_LIMIT));
    const { rows } = await pool.query(
      `SELECT ${CHAT_COLS},
              (SELECT count(*)::int FROM ai_chat_messages m WHERE m.chat_id = c.id) AS message_count
         FROM ai_chats c
        WHERE c.user_id = $1
        ORDER BY c.updated_at DESC, c.id DESC
        LIMIT $2`, [uid, safeLimit]);
    return rows;
  }

  async function createAiChat(uid) {
    if (!enabled || uid == null) return null;
    const { rows } = await pool.query(
      `INSERT INTO ai_chats (user_id) VALUES ($1)
       RETURNING id, title,
                 to_char(created_at,${ISO}) AS created_at,
                 to_char(updated_at,${ISO}) AS updated_at`, [uid]);
    return rows[0] || null;
  }

  // Ownership-checked fetch: null и для «нет», и для «не мой» (роут → 404, без утечки).
  async function getAiChat(uid, id) {
    if (!enabled || uid == null || !id) return null;
    const { rows } = await pool.query(
      `SELECT ${CHAT_COLS} FROM ai_chats c WHERE c.id = $2 AND c.user_id = $1`, [uid, id]);
    return rows[0] || null;
  }

  async function deleteAiChat(uid, id) {
    if (!enabled || uid == null || !id) return false;
    const { rowCount } = await pool.query(
      `DELETE FROM ai_chats WHERE id = $2 AND user_id = $1`, [uid, id]);
    return rowCount > 0;
  }

  async function listAiChatMessages(uid, chatId, limit = AI_CHAT_MESSAGES_LIMIT) {
    if (!enabled || uid == null || !chatId) return [];
    const safeLimit = Math.min(500, Math.max(1, Number.parseInt(limit, 10) || AI_CHAT_MESSAGES_LIMIT));
    // Хвост диалога (последние N) в хронологическом порядке — старое сверху.
    const { rows } = await pool.query(
      `SELECT * FROM (
         SELECT ${MSG_COLS}
           FROM ai_chat_messages m
           JOIN ai_chats c ON c.id = m.chat_id AND c.user_id = $1
          WHERE m.chat_id = $2
          ORDER BY m.id DESC
          LIMIT $3
       ) tail ORDER BY id ASC`, [uid, chatId, safeLimit]);
    return rows;
  }

  /* Append + бухгалтерия чата одним стейтментом: вставка гейтится ownership'ом через CTE
     (чужой/несуществующий чат → 0 строк → null), updated_at всегда поднимается, а пустой title
     заполняется из ПЕРВОГО пользовательского сообщения (обрезка по границе слова — в JS). */
  async function appendAiChatMessage(uid, chatId, message) {
    if (!enabled || uid == null || !chatId) return null;
    const {
      role, content, toolTrace = null, model = null,
      inputTokens = null, outputTokens = null, error = null,
    } = message || {};
    if (role !== 'user' && role !== 'assistant') throw new Error('bad role');
    const text = typeof content === 'string' ? content : '';
    const titleCandidate = role === 'user' ? makeChatTitle(text) : null;
    const { rows } = await pool.query(
      `WITH chat AS (
         SELECT id FROM ai_chats WHERE id = $2 AND user_id = $1
       ), ins AS (
         INSERT INTO ai_chat_messages (chat_id, role, content, tool_trace, model, input_tokens, output_tokens, error)
         SELECT chat.id, $3, $4, $5::jsonb, $6, $7, $8, $9 FROM chat
         RETURNING id, chat_id, role, content, tool_trace, model, input_tokens, output_tokens, error,
                   to_char(created_at,${ISO}) AS created_at
       ), upd AS (
         UPDATE ai_chats c
            SET updated_at = now(),
                title = CASE WHEN c.title = '' AND $10::text IS NOT NULL THEN $10 ELSE c.title END
           FROM chat WHERE c.id = chat.id
       )
       SELECT * FROM ins`,
      [
        uid, chatId, role, text,
        toolTrace == null ? null : JSON.stringify(toolTrace),
        model, inputTokens, outputTokens, error, titleCandidate,
      ]);
    return rows[0] || null;
  }

  async function getAiUsageToday(uid) {
    if (!enabled || uid == null) return { messages: 0, input_tokens: 0, output_tokens: 0 };
    const { rows } = await pool.query(
      `SELECT messages, input_tokens, output_tokens
         FROM ai_usage_daily WHERE user_id = $1 AND day = ${UTC_TODAY}`, [uid]);
    const r = rows[0];
    return {
      messages: r ? r.messages : 0,
      input_tokens: r ? Number(r.input_tokens) : 0,
      output_tokens: r ? Number(r.output_tokens) : 0,
    };
  }

  async function bumpAiUsage(uid, { messages = 0, inputTokens = 0, outputTokens = 0 } = {}) {
    if (!enabled || uid == null) return;
    await pool.query(
      `INSERT INTO ai_usage_daily (user_id, day, messages, input_tokens, output_tokens)
       VALUES ($1, ${UTC_TODAY}, $2, $3, $4)
       ON CONFLICT (user_id, day) DO UPDATE SET
         messages      = ai_usage_daily.messages      + EXCLUDED.messages,
         input_tokens  = ai_usage_daily.input_tokens  + EXCLUDED.input_tokens,
         output_tokens = ai_usage_daily.output_tokens + EXCLUDED.output_tokens`,
      [uid, messages, Math.max(0, Math.round(inputTokens)), Math.max(0, Math.round(outputTokens))]);
  }

  return {
    AI_CHAT_TITLE_MAX,
    listAiChats,
    createAiChat,
    getAiChat,
    deleteAiChat,
    listAiChatMessages,
    appendAiChatMessage,
    getAiUsageToday,
    bumpAiUsage,
  };
}

/** Заголовок чата из первого вопроса: схлопнутые пробелы, обрезка ≤80 по границе слова + «…». */
function makeChatTitle(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  if (flat.length <= AI_CHAT_TITLE_MAX) return flat;
  const cut = flat.slice(0, AI_CHAT_TITLE_MAX);
  const atWord = cut.lastIndexOf(' ') > AI_CHAT_TITLE_MAX * 0.6 ? cut.slice(0, cut.lastIndexOf(' ')) : cut;
  return `${atWord.trimEnd()}…`;
}

module.exports = { createAiChatsRepo, makeChatTitle };
