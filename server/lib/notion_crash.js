'use strict';

// Нативный fetch (Node ≥18) — node-fetch выпилен; bind нужен undici (голая ссылка
// на fetch без this у некоторых версий кидает Illegal invocation).
const defaultFetch = (...args) => fetch(...args);

const NOTION_VERSION = '2022-06-28';
const rt = (value) =>
  value
    ? [{ type: 'text', text: { content: String(value).slice(0, 1900) } }]
    : [];

function createNotionCrashClient(
  { token = '', crashDatabaseId = '' } = {},
  { fetchImpl = defaultFetch } = {},
) {
  const enabled = !!(token && crashDatabaseId);

  async function notionFetch(path, method, body) {
    try {
      const response = await fetchImpl(`https://api.notion.com/v1${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        timeout: 8000,
      });
      if (!response.ok) return null;
      return await response.json();
    } catch {
      return null;
    }
  }

  async function createCrashCard(fields) {
    if (!enabled) return null;
    const properties = {
      Ошибка: {
        title: rt(
          `[${fields.scope}] ${fields.name}: ${fields.message}`.slice(0, 180),
        ),
      },
      Статус: { select: { name: 'Новый' } },
      Scope: { select: { name: fields.scope } },
      Повторов: { number: fields.count || 1 },
      Маршрут: { rich_text: rt(fields.route) },
      Виджет: { rich_text: rt(fields.widgetId || fields.label) },
      Коммит: { rich_text: rt(fields.commit) },
      'Trace-id': { rich_text: rt(fields.traceId) },
      Сигнатура: { rich_text: rt(fields.signature) },
      Впервые: { date: { start: fields.at } },
      'Последний раз': { date: { start: fields.at } },
    };
    const children = fields.stack
      ? [
          {
            object: 'block',
            type: 'code',
            code: {
              language: 'plain text',
              rich_text: rt(String(fields.stack).slice(0, 1900)),
            },
          },
        ]
      : [];
    const response = await notionFetch('/pages', 'POST', {
      parent: { database_id: crashDatabaseId },
      properties,
      children,
    });
    return response && response.id ? response.id : null;
  }

  async function updateCrashCard(pageId, fields) {
    if (!enabled || !pageId) return;
    await notionFetch(`/pages/${pageId}`, 'PATCH', {
      properties: {
        Повторов: { number: fields.count },
        'Последний раз': { date: { start: fields.at } },
        'Trace-id': { rich_text: rt(fields.traceId) },
      },
    });
  }

  return Object.freeze({ enabled, createCrashCard, updateCrashCard });
}

module.exports = { createNotionCrashClient };
