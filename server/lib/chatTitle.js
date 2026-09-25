'use strict';

/* Заголовок AI-чата из первой реплики пользователя. Чистая функция без БД: жила в
   repos/aiChatsRepo, и services/aiChatService импортировал её ОТТУДА — сервис тянул repo напрямую
   (аудит #554). Один общий модуль вместо двух копий: разойдись они, чат получал бы в списке одно
   имя, а в шапке другое. */

const AI_CHAT_TITLE_MAX = 80;

function makeChatTitle(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  if (flat.length <= AI_CHAT_TITLE_MAX) return flat;
  const cut = flat.slice(0, AI_CHAT_TITLE_MAX);
  const atWord = cut.lastIndexOf(' ') > AI_CHAT_TITLE_MAX * 0.6 ? cut.slice(0, cut.lastIndexOf(' ')) : cut;
  return `${atWord.trimEnd()}…`;
}

module.exports = { AI_CHAT_TITLE_MAX, makeChatTitle };
