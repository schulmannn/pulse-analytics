'use strict';

/* ── AI-провайдер: единый streamTurn-интерфейс над LLM ────────────────────────────────────────────
   Возвращает один из трёх режимов (env сюда не попадает — boundaries; всё инъектится из config
   через composition):

     anthropic — реальный Anthropic Messages API (@anthropic-ai/sdk), стриминг + tools;
     mock      — детерминированный офлайн-провайдер: БЕЗ ключа ВНЕ production (dev/CI/e2e)
                 полный стек — SSE, tool-цикл, персист, квота — работает без сети и секретов;
     off       — production без ключа: фича мягко выключена (роуты отвечают 503).

   Контракт streamTurn({ system, messages, tools, toolChoice, signal, onEvent }):
     onEvent({type:'text', delta})            — инкремент текста ответа;
     onEvent({type:'tool_start', name})       — модель начала собирать tool-вызов;
     → resolve { content, stopReason, usage:{input,output} } — финальные блоки хода
       (включая tool_use и thinking) для продолжения диалога агентным циклом в aiChatService.
   Ошибки провайдера нормализуются: err.userMessage — безопасный русский текст для клиента,
   err.status — HTTP-статус источника (если был). */

const REQUEST_TIMEOUT_MS = 120000;

function createAiProvider({ apiKey, model, maxOutputTokens, allowMock = false, log = () => {} }) {
  if (apiKey) return createAnthropicProvider({ apiKey, model, maxOutputTokens, log });
  if (allowMock) return createMockProvider({ log });
  return Object.freeze({
    mode: 'off',
    model: null,
    async streamTurn() {
      const err = new Error('AI provider is not configured');
      err.userMessage = 'AI-ассистент не настроен: не задан ANTHROPIC_API_KEY.';
      err.status = 503;
      throw err;
    },
  });
}

// ── Anthropic ────────────────────────────────────────────────────────────────────────────────────
function createAnthropicProvider({ apiKey, model, maxOutputTokens, log }) {
  const Anthropic = require('@anthropic-ai/sdk');
  // maxRetries 1: SSE-ответ пользователю уже открыт, длинные ретраи хуже честной ошибки.
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: REQUEST_TIMEOUT_MS });

  async function streamTurn({ system, messages, tools, toolChoice, signal, onEvent }) {
    const params = {
      model,
      max_tokens: maxOutputTokens,
      system,
      messages,
    };
    // thinking/effort не задаём: у Sonnet 5 adaptive thinking включён по умолчанию, а явные
    // параметры привязали бы запрос к конкретному семейству моделей (AI_MODEL переключаем env'ом).
    if (Array.isArray(tools) && tools.length) params.tools = tools;
    if (toolChoice) params.tool_choice = toolChoice;
    try {
      const stream = client.messages.stream(params, { signal });
      if (onEvent) {
        stream.on('text', (delta) => onEvent({ type: 'text', delta }));
        stream.on('streamEvent', (event) => {
          if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
            onEvent({ type: 'tool_start', name: event.content_block.name });
          }
        });
      }
      const final = await stream.finalMessage();
      return {
        content: final.content,
        stopReason: final.stop_reason,
        usage: {
          input: (final.usage && final.usage.input_tokens) || 0,
          output: (final.usage && final.usage.output_tokens) || 0,
        },
      };
    } catch (e) {
      throw normalizeAnthropicError(e, Anthropic, log);
    }
  }

  return Object.freeze({ mode: 'anthropic', model, streamTurn });
}

function normalizeAnthropicError(e, Anthropic, log) {
  // Abort клиента (закрыл вкладку/остановил ответ) — не ошибка провайдера: пробрасываем как есть,
  // вызывающий код различает по name.
  if (e && (e.name === 'AbortError' || e.name === 'APIUserAbortError')) return e;
  const status = e instanceof Anthropic.APIError ? e.status : undefined;
  let userMessage = 'Не удалось получить ответ от AI-провайдера. Попробуйте ещё раз.';
  if (status === 401 || status === 403) {
    userMessage = 'AI-провайдер отклонил ключ доступа — проверьте ANTHROPIC_API_KEY.';
  } else if (status === 429) {
    userMessage = 'AI-провайдер ограничил частоту запросов. Подождите минуту и повторите.';
  } else if (status === 529 || (status != null && status >= 500)) {
    userMessage = 'AI-провайдер временно перегружен. Попробуйте позже.';
  } else if (status === 400) {
    userMessage = 'AI-провайдер отклонил запрос. Попробуйте переформулировать вопрос.';
  }
  log('error', 'ai_provider_error', { status: status ?? null, error: e && e.message });
  const err = new Error(`anthropic: ${(e && e.message) || 'request failed'}`);
  err.userMessage = userMessage;
  if (status != null) err.status = status;
  return err;
}

// ── Mock (dev/CI/e2e) ────────────────────────────────────────────────────────────────────────────
/* Детерминированный сценарий: первый ход — вызов инструмента без обязательных аргументов (если
   такой объявлен; обычно get_campaigns), второй — фиксированный текст с эхом вопроса. Так e2e и
   интеграционные тесты проверяют ВЕСЬ агентный цикл (tools → tool_result → финальный текст →
   персист → SSE) без сети. */
function createMockProvider({ log }) {
  async function streamTurn({ messages, tools, toolChoice, onEvent }) {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user' && typeof m.content === 'string');
    const question = (lastUser ? lastUser.content : '').slice(0, 140);
    const hadToolResult = messages.some(
      (m) => Array.isArray(m.content) && m.content.some((b) => b && b.type === 'tool_result'),
    );
    const toolsAllowed = Array.isArray(tools) && tools.length && (!toolChoice || toolChoice.type !== 'none');
    if (!hadToolResult && toolsAllowed) {
      const zeroArg = tools.find((t) => !(t.input_schema && Array.isArray(t.input_schema.required) && t.input_schema.required.length));
      const tool = zeroArg || tools[0];
      if (onEvent) {
        onEvent({ type: 'text', delta: 'Смотрю данные… ' });
        onEvent({ type: 'tool_start', name: tool.name });
      }
      return {
        content: [
          { type: 'text', text: 'Смотрю данные… ' },
          { type: 'tool_use', id: 'mock_tool_1', name: tool.name, input: {} },
        ],
        stopReason: 'tool_use',
        usage: { input: 12, output: 8 },
      };
    }
    const text =
      `Это тестовый ответ AI-ассистента (mock-режим: ANTHROPIC_API_KEY не задан). ` +
      `Ваш вопрос: «${question}». Стриминг, инструменты и история чатов работают; ` +
      `добавьте ключ, чтобы получать настоящий анализ.`;
    if (onEvent) {
      // Несколько чанков — фронт честно проверяет инкрементальный рендер.
      const step = Math.ceil(text.length / 3);
      for (let i = 0; i < text.length; i += step) onEvent({ type: 'text', delta: text.slice(i, i + step) });
    }
    log('info', 'ai_mock_turn', { question_len: question.length });
    return {
      content: [{ type: 'text', text }],
      stopReason: 'end_turn',
      usage: { input: 15, output: 25 },
    };
  }

  return Object.freeze({ mode: 'mock', model: 'mock', streamTurn });
}

module.exports = { createAiProvider };
