'use strict';

/* ── AI-чат: оркестрация диалога (STEEP-паттерн «Спросить что угодно») ────────────────────────────
   Чистая фабрика от deps (boundaries): db + provider (infrastructure/aiProvider) + лимиты из
   config. Владеет:
     • preflight — валидация до открытия SSE (доступность, владение чатом, дневная квота) —
       кодированные ошибки, роут маппит их в HTTP-статусы;
     • answer — агентный цикл: system-промпт с источниками пользователя → streamTurn провайдера →
       исполнение read-only инструментов (aiTools, ForActor-гейт на каждый вызов) → повтор, пока
       модель просит инструменты (потолок maxToolRounds, дальше tool_choice:none) → персист
       ответа + токен-бухгалтерия. После открытия SSE answer НЕ бросает: любая ошибка становится
       emit({type:'error'}) + честным персистом частичного ответа.

   Доступ v1: только superuser (обкатка владельцем) — см. enabledFor. Расширение на всех
   пользователей = замена одной проверки здесь + снятие requireSuper в routes/ai.js. */

const { createAiTools } = require('./aiTools');
const { makeChatTitle } = require('../repos/aiChatsRepo');

const HISTORY_MESSAGES = 30;      // сколько последних сообщений диалога уходит в контекст модели
const HISTORY_CHARS_PER_MSG = 4000;
const TOOL_RESULT_CHARS = 8000;   // потолок сериализованного tool_result (защита контекста)

function createAiChatService({ db, log, provider, dailyMessageLimit, maxToolRounds, tools, sklad }) {
  const aiTools = tools || createAiTools({ db, sklad });

  const available = () => provider.mode !== 'off' && !!db.enabled;
  // v1: фича видна и доступна только владельцу (superuser). При открытии всем — заменить
  // на `!!user` (и убрать requireSuper из routes/ai.js).
  const enabledFor = (user) => available() && !!user && user.role === 'superuser';

  // ── Тонкие обёртки CRUD (uid-scope в repo) ────────────────────────────────────────────────
  const listChats = (user) => db.listAiChats(user.uid);
  const createChat = (user) => db.createAiChat(user.uid);
  const deleteChat = (user, id) => db.deleteAiChat(user.uid, id);
  async function getChatWithMessages(user, id) {
    const chat = await db.getAiChat(user.uid, id);
    if (!chat) return null;
    const messages = await db.listAiChatMessages(user.uid, id);
    return { chat, messages };
  }

  /* Проверки ДО открытия SSE-ответа. Бросает Error с .code:
       'off'       → 503 (провайдер не настроен в production)
       'not_found' → 404 (чужой/несуществующий чат)
       'quota'     → 429 (дневной лимит вопросов исчерпан)                                */
  async function preflight(user, chatId, text) {
    if (!available()) throw coded('off', 'AI-ассистент не настроен.');
    if (typeof text !== 'string' || !text.trim()) throw coded('bad_text', 'Пустой вопрос.');
    if (text.trim().length > 4000) throw coded('bad_text', 'Вопрос слишком длинный (до 4000 символов).');
    const chat = await db.getAiChat(user.uid, chatId);
    if (!chat) throw coded('not_found', 'Чат не найден');
    const usage = await db.getAiUsageToday(user.uid);
    if (usage.messages >= dailyMessageLimit) {
      throw coded('quota', `Дневной лимит вопросов (${dailyMessageLimit}) исчерпан. Лимит обновится в полночь UTC.`);
    }
    return { chat, usage };
  }

  /* Агентный цикл. emit(obj) — транспорт события клиенту (SSE); signal — abort закрывшегося
     клиента. Никогда не бросает: ошибки эмитятся и персистятся. Возвращает сводку хода. */
  async function answer({ user, chat, text, emit, signal }) {
    const uid = user.uid;
    const trimmed = text.trim();
    const history = await db.listAiChatMessages(uid, chat.id, HISTORY_MESSAGES);
    await db.appendAiChatMessage(uid, chat.id, { role: 'user', content: trimmed });
    await db.bumpAiUsage(uid, { messages: 1 });
    emit({ type: 'meta', chat_id: chat.id, title: chat.title || makeChatTitle(trimmed) });

    const system = await buildSystemPrompt(user);
    let convo = [...historyToTurns(history), { role: 'user', content: trimmed }];

    let textOut = '';
    const toolTrace = [];
    let usage = { input: 0, output: 0 };
    let stopReason = null;
    let failure = null; // { message, kind }

    try {
      for (let round = 0; ; round += 1) {
        const finalRound = round >= maxToolRounds;
        const turn = await provider.streamTurn({
          system,
          messages: convo,
          tools: aiTools.definitions,
          // Потолок tool-раундов: история уже содержит tool-блоки (tools обязаны остаться в
          // запросе), но новые вызовы запрещаем — модель обязана ответить по собранному.
          toolChoice: finalRound ? { type: 'none' } : undefined,
          signal,
          onEvent: (ev) => {
            if (ev.type === 'text') {
              textOut += ev.delta;
              emit({ type: 'text', delta: ev.delta });
            } else if (ev.type === 'tool_start') {
              emit({ type: 'tool', name: ev.name, status: 'start' });
            }
          },
        });
        usage.input += turn.usage.input;
        usage.output += turn.usage.output;
        stopReason = turn.stopReason;
        if (turn.stopReason !== 'tool_use') break;

        const toolUses = turn.content.filter((b) => b && b.type === 'tool_use');
        if (!toolUses.length) break; // защитный выход: stop_reason врёт — не зацикливаемся
        const results = [];
        for (const tu of toolUses) {
          const startedAt = Date.now();
          let result;
          try {
            result = await aiTools.run(tu.name, tu.input, user);
          } catch (e) {
            log('error', 'ai_tool_failed', { tool: tu.name, error: e.message });
            result = { error: 'Инструмент временно недоступен.' };
          }
          const isError = !!(result && result.error);
          toolTrace.push({
            name: tu.name,
            input: tu.input,
            ok: !isError,
            ms: Date.now() - startedAt,
            ...(isError ? { error: result.error } : {}),
          });
          emit({ type: 'tool', name: tu.name, status: isError ? 'error' : 'end' });
          results.push({
            type: 'tool_result',
            tool_use_id: tu.id,
            content: clip(JSON.stringify(result), TOOL_RESULT_CHARS),
            ...(isError ? { is_error: true } : {}),
          });
        }
        convo = [...convo, { role: 'assistant', content: turn.content }, { role: 'user', content: results }];
      }
    } catch (e) {
      if (isAbort(e) || (signal && signal.aborted)) {
        failure = { kind: 'aborted', message: 'Ответ прерван.' };
      } else {
        failure = { kind: 'provider', message: e.userMessage || 'Не удалось получить ответ от AI-провайдера.' };
        log('error', 'ai_answer_failed', { chat_id: chat.id, error: e.message });
      }
    }

    if (!failure && stopReason === 'refusal' && !textOut.trim()) {
      failure = { kind: 'refusal', message: 'Ассистент не может ответить на этот запрос.' };
    }

    const saved = await db.appendAiChatMessage(uid, chat.id, {
      role: 'assistant',
      content: textOut,
      toolTrace: toolTrace.length ? toolTrace : null,
      model: provider.model,
      inputTokens: usage.input || null,
      outputTokens: usage.output || null,
      error: failure ? failure.kind : stopReason === 'max_tokens' ? 'max_tokens' : null,
    }).catch((e) => {
      log('error', 'ai_persist_failed', { chat_id: chat.id, error: e.message });
      return null;
    });
    await db.bumpAiUsage(uid, { inputTokens: usage.input, outputTokens: usage.output }).catch(() => {});

    if (failure && failure.kind !== 'aborted') {
      emit({ type: 'error', message: failure.message });
    } else if (!failure) {
      emit({
        type: 'done',
        message_id: saved ? saved.id : null,
        stop_reason: stopReason,
        usage: { input: usage.input, output: usage.output },
      });
    }
    return { ok: !failure, stopReason, usage, toolCalls: toolTrace.length };
  }

  // ── System-промпт: продукт + источники пользователя + жёсткие правила метрик ────────────────
  async function buildSystemPrompt(user) {
    const channels = await db.listChannels(user).catch(() => []);
    const lines = channels.map((ch) => {
      const nets = [];
      if (ch.source === 'ig') nets.push('Instagram');
      else if (ch.source === 'ms') nets.push('МойСклад');
      else {
        nets.push('Telegram');
        if (ch.ig_connected) nets.push('Instagram подключён');
      }
      const handle = ch.username ? ` (@${ch.username})` : '';
      return `- channel_id=${ch.id}: «${ch.title || ch.username || 'Без названия'}»${handle} — ${nets.join(', ')}`;
    });
    const today = new Date().toISOString().slice(0, 10);
    return [
      'Ты — встроенный AI-аналитик Atlavue, продукта аналитики Telegram и Instagram для авторов и команд.',
      `Сегодня ${today}. Пользователь: ${user.email || 'без email'}.`,
      '',
      lines.length
        ? `Источники пользователя (передавай их channel_id в инструменты):\n${lines.join('\n')}`
        : 'У пользователя пока нет подключённых источников — подскажи подключить канал в разделе «Подключить».',
      '',
      'Обязательные правила работы с метриками:',
      '- Просмотры Telegram и охват Instagram — разные метрики. Никогда не складывай их и не сравнивай как одно число.',
      '- «Просмотры канала» TG — сумма дневного потока просмотров (включая старые посты); «просмотры публикаций» — только по постам выбранного окна. Не подменяй одно другим.',
      '- IG: followers в дневных данных — валовые новые подписчики; нетто-прирост = follows − unfollows.',
      '- «Потенциальные просмотры» упоминаний — сумма просмотров упомянувших постов без дедупликации аудитории; это не охват.',
      '- Деньги МойСклада (выручка, заказы, средний чек) — отдельная система величин: не смешивай их с просмотрами и охватами соцсетей. Средний чек = сумма заказов / число заказов.',
      '- Числа бери ТОЛЬКО из инструментов. Если данных нет или инструмент вернул ошибку — честно скажи об этом, не выдумывай.',
      '',
      'Стиль: отвечай на языке вопроса (по умолчанию — по-русски), кратко и по делу. Большие числа разделяй пробелами (12 400), проценты — с одним знаком после запятой. Списки уместны, таблицы — только короткие. Если вопрос не про аналитику пользователя, вежливо вернись к теме продукта.',
    ].join('\n');
  }

  return {
    mode: provider.mode,
    model: provider.model,
    available,
    enabledFor,
    listChats,
    createChat,
    deleteChat,
    getChatWithMessages,
    preflight,
    answer,
    dailyMessageLimit,
  };
}

// ── Хелперы ────────────────────────────────────────────────────────────────────────────────────
function coded(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const isAbort = (e) => !!e && (e.name === 'AbortError' || e.name === 'APIUserAbortError');

const clip = (s, max) =>
  s.length <= max ? s : `${s.slice(0, max)}… [обрезано: слишком длинный результат]`;

/* История диалога → чередование plain-text ходов. Tool-блоки прошлых ходов НЕ переигрываются
   (их след хранится в tool_trace для UI); пустые ответы (ошибки провайдера) пропускаются;
   ведущие assistant-сообщения отбрасываются — первый ход всегда user. */
function historyToTurns(history) {
  const turns = [];
  for (const m of history) {
    const content = String(m.content || '').slice(0, HISTORY_CHARS_PER_MSG);
    if (!content.trim()) continue;
    if (!turns.length && m.role === 'assistant') continue;
    turns.push({ role: m.role, content });
  }
  return turns;
}

module.exports = { createAiChatService };
