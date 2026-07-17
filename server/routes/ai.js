'use strict';

/* ── AI-чат: HTTP/SSE-слой ────────────────────────────────────────────────────────────────────────
   CRUD личных диалогов + стриминговый ответ ассистента. Вся доменная логика — в aiChatService;
   здесь только маппинг кодов в статусы и механика Server-Sent Events.

   v1 owner-only: каждый роут за requireAuth + requireSuper. Открытие фичи всем пользователям =
   снятие requireSuper здесь + правка enabledFor в aiChatService (две строки, один PR).

   SSE: ответ на POST …/messages — text/event-stream. Глобальный compression() уважает
   Cache-Control: no-transform (см. app.js) — чанки уходят без буферизации; heartbeat-комментарий
   каждые 15с удерживает соединение через прокси. Дисконнект клиента абортит провайдера
   (частичный ответ всё равно персистится сервисом). */

const HEARTBEAT_MS = 15000;

function registerAiRoutes({ app, db, requireAuth, requireSuper, aiChatService, audit, log, getDbReady }) {
  // Общий гейт данных: фича настроена + БД поднята (как channels/campaigns → 503).
  function guarded(res) {
    if (!aiChatService.available() || !getDbReady()) {
      res.status(503).json({ error: aiChatService.available() ? 'БД не подключена' : 'AI-ассистент не настроен' });
      return false;
    }
    return true;
  }

  app.get('/api/ai/chats', requireAuth, requireSuper, async (req, res, next) => {
    if (!guarded(res)) return;
    try {
      const [chats, usage] = await Promise.all([
        aiChatService.listChats(req.user),
        db.getAiUsageToday(req.user.uid),
      ]);
      res.json({
        chats,
        usage: { used: usage.messages, limit: aiChatService.dailyMessageLimit },
      });
    } catch (e) { next(e); }
  });

  app.post('/api/ai/chats', requireAuth, requireSuper, async (req, res, next) => {
    if (!guarded(res)) return;
    try {
      const chat = await aiChatService.createChat(req.user);
      if (!chat) return res.status(503).json({ error: 'БД не подключена' });
      audit(req, 'ai.chat_create', { chat_id: chat.id }).catch(() => {});
      res.json({ chat });
    } catch (e) { next(e); }
  });

  app.get('/api/ai/chats/:id', requireAuth, requireSuper, async (req, res, next) => {
    if (!guarded(res)) return;
    try {
      const data = await aiChatService.getChatWithMessages(req.user, parseId(req.params.id));
      if (!data) return res.status(404).json({ error: 'Чат не найден' });
      res.json(data);
    } catch (e) { next(e); }
  });

  app.delete('/api/ai/chats/:id', requireAuth, requireSuper, async (req, res, next) => {
    if (!guarded(res)) return;
    try {
      const ok = await aiChatService.deleteChat(req.user, parseId(req.params.id));
      if (!ok) return res.status(404).json({ error: 'Чат не найден' });
      audit(req, 'ai.chat_delete', { chat_id: parseId(req.params.id) }).catch(() => {});
      res.json({ ok: true });
    } catch (e) { next(e); }
  });

  app.post('/api/ai/chats/:id/messages', requireAuth, requireSuper, async (req, res) => {
    if (!guarded(res)) return;
    const chatId = parseId(req.params.id);
    const text = req.body && req.body.text;

    // Все отказы — ДО открытия стрима, обычным JSON со статусом.
    let ctx;
    try {
      ctx = await aiChatService.preflight(req.user, chatId, text);
    } catch (e) {
      const status =
        e.code === 'not_found' ? 404
        : e.code === 'quota' ? 429
        : e.code === 'bad_text' ? 400
        : e.code === 'off' ? 503
        : 500;
      if (status === 500) log('error', 'ai_preflight_failed', { request_id: req.requestId, error: e.message });
      return res.status(status).json({ error: status === 500 ? 'internal_error' : e.message });
    }
    audit(req, 'ai.message', { chat_id: chatId }).catch(() => {});

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      // no-transform: глобальный compression() пропускает ответ без gzip-буферизации.
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    const send = (obj) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': hb\n\n');
    }, HEARTBEAT_MS);
    const abort = new AbortController();
    req.on('close', () => abort.abort());

    try {
      await aiChatService.answer({
        user: req.user,
        chat: ctx.chat,
        text: String(text),
        emit: send,
        signal: abort.signal,
      });
    } catch (e) {
      // answer не должен бросать; это последний рубеж, чтобы соединение не зависло без финала.
      log('error', 'ai_answer_unhandled', { request_id: req.requestId, error: e.message });
      send({ type: 'error', message: 'Внутренняя ошибка ассистента' });
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  });
}

const parseId = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

module.exports = { registerAiRoutes };
